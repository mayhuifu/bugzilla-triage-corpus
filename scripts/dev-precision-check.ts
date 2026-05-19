// ─────────────────────────────────────────────────────────────────
// dev-precision-check.ts — proof-of-concept micro-eval that
// validates the hybrid (BM25 + dense + RRF) architecture before
// we touch the real parser or schema. Uses the synthetic fixture
// under scripts/fixtures/.
//
// Pipeline:
//   1. Read fixtures/dev-clauses.jsonl + fixtures/dev-queries.json.
//   2. Spawn the Python embed sidecar twice: once on clause text,
//      once on query text. Cache embeddings under dist/.dev/ so
//      re-runs are fast.
//   3. Build a fresh /tmp SQLite with FTS5 (clauses_fts) and
//      sqlite-vec (clauses_vec) populated from the fixture.
//   4. For each query, run BOTH retrievers:
//        a) baseline FTS5 BM25 (OR-of-terms like the v1 desktop)
//        b) hybrid RRF (FTS5 top-50 ⊕ vec0 top-50, RRF k=60)
//      Record rank of the expected clause in each.
//   5. Print Recall@1/3/5/10, MRR@10 for both retrievers + a per-
//      query table so we can see which queries flipped from miss
//      to hit when adding dense.
//
// Success criterion: hybrid MRR@10 strictly greater than baseline
// AND hybrid Recall@5 strictly greater than baseline. Print PASS/FAIL
// and exit non-zero on FAIL.
//
// Env:
//   EMBED_MODEL=BAAI/bge-m3       (default)
//   DEV_KEEP_CACHE=1              (skip re-embedding if cache present)
// ─────────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures");
const DEV_CACHE = path.join(REPO_ROOT, "dist", ".dev");
const TMP_DB = path.join(DEV_CACHE, "dev-corpus.sqlite");

const MODEL = process.env.EMBED_MODEL ?? "BAAI/bge-m3";
const KEEP_CACHE = process.env.DEV_KEEP_CACHE === "1";
const PYTHON = process.env.EMBED_PY ?? "python3";
const RRF_K = 60;
const CANDIDATES_PER_SOURCE = 50;
const TOP_K = 10;

interface Clause {
  id: string;
  spec: string;
  release: string;
  version: string;
  clauseNo: string;
  title: string;
  parentId: string | null;
  parentTitle: string | null;
  text: string;
}

interface Query {
  qid: number;
  query: string;
  expectedClauseId: string;
  difficulty: "easy" | "hard";
  stratum: string;
}

interface EmbeddingRecord {
  id: string;
  embedding_b64: string;
}

// ── Helpers ──────────────────────────────────────────────────────

const log = (...args: unknown[]) => console.log("[dev-eval]", ...args);

async function readJsonl<T>(p: string): Promise<T[]> {
  const raw = await fs.readFile(p, "utf8");
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    out.push(JSON.parse(s) as T);
  }
  return out;
}

/** Decode base64 → float16 → Float32Array. */
function decodeFloat16Base64(b64: string): Float32Array {
  const bytes = Buffer.from(b64, "base64");
  const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const f32 = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) f32[i] = fp16ToFp32(u16[i]);
  return f32;
}

function fp16ToFp32(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) {
    if (f === 0) return s ? -0 : 0;
    const v = f * 2 ** -24;
    return s ? -v : v;
  }
  if (e === 0x1f) return f ? NaN : s ? -Infinity : Infinity;
  const v = (1 + f / 1024) * 2 ** (e - 15);
  return s ? -v : v;
}

/** Convert Float32Array → little-endian buffer ready for vec0 INSERT. */
function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Spawn embed_sidecar.py synchronously (small workloads). */
function runSidecar(inPath: string, outPath: string) {
  const sidecar = path.join(__dirname, "embed_sidecar.py");
  const args = [
    sidecar,
    "--in", inPath,
    "--out", outPath,
    "--model", MODEL,
    "--batch-size", "32",
  ];
  log(`spawn ${PYTHON} ${args.join(" ")}`);
  const r = spawnSync(PYTHON, args, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) {
    throw new Error(`embed_sidecar.py failed (status=${r.status})`);
  }
}

/** Lightweight tokenizer ≈ the desktop's v1 retriever (unicode, lowercased,
 *  stopword-light). Mimics what the FTS5 user-facing query would look like. */
const STOPWORDS = new Set([
  "the","a","an","and","or","of","to","in","on","for","is","are","was","were",
  "be","been","by","with","as","at","that","this","it","its","from","into",
  "than","then","such","not","no","do","does","did","has","have","had",
]);
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]+/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}
function buildBm25Match(query: string): string {
  const tokens = Array.from(new Set(tokenize(query))).slice(0, 40);
  if (tokens.length === 0) return '""';
  // FTS5 syntax: OR between bare terms.
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  await fs.mkdir(DEV_CACHE, { recursive: true });

  // 1. Load fixture.
  const clauses = await readJsonl<Clause>(path.join(FIXTURES, "dev-clauses.jsonl"));
  const queriesFile = JSON.parse(
    await fs.readFile(path.join(FIXTURES, "dev-queries.json"), "utf8"),
  ) as { queries: Query[] };
  const queries = queriesFile.queries;
  log(`fixture: ${clauses.length} clause(s), ${queries.length} query/queries`);

  // 2. Embed clauses + queries (cache to dist/.dev/).
  const clauseCache = path.join(DEV_CACHE, "clauses.emb.jsonl");
  const queryCache = path.join(DEV_CACHE, "queries.emb.jsonl");

  if (!KEEP_CACHE || !fsSync.existsSync(clauseCache)) {
    const inPath = path.join(DEV_CACHE, "clauses.in.jsonl");
    const inLines = clauses.map(c => JSON.stringify({
      id: c.id,
      text: `${c.title}\n${c.text}`,
    })).join("\n") + "\n";
    await fs.writeFile(inPath, inLines);
    runSidecar(inPath, clauseCache);
  } else {
    log(`cache hit: ${clauseCache}`);
  }
  if (!KEEP_CACHE || !fsSync.existsSync(queryCache)) {
    const inPath = path.join(DEV_CACHE, "queries.in.jsonl");
    const inLines = queries.map(q => JSON.stringify({
      id: String(q.qid),
      text: q.query,
    })).join("\n") + "\n";
    await fs.writeFile(inPath, inLines);
    runSidecar(inPath, queryCache);
  } else {
    log(`cache hit: ${queryCache}`);
  }

  const clauseEmb = await readJsonl<EmbeddingRecord>(clauseCache);
  const queryEmb = await readJsonl<EmbeddingRecord>(queryCache);
  const dim = decodeFloat16Base64(clauseEmb[0].embedding_b64).length;
  log(`embedding dim: ${dim}`);

  // 3. Build temp SQLite with FTS5 + vec0.
  try { await fs.unlink(TMP_DB); } catch { /* ignore */ }
  const db = new Database(TMP_DB);
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE clauses (
      id TEXT PRIMARY KEY,
      spec TEXT, release TEXT, version TEXT,
      clause_no TEXT, title TEXT,
      parent_id TEXT, parent_title TEXT,
      text TEXT, citation TEXT
    );
    CREATE VIRTUAL TABLE clauses_fts USING fts5(
      citation, title, text,
      content='clauses', content_rowid='rowid',
      tokenize='porter unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER clauses_ai AFTER INSERT ON clauses BEGIN
      INSERT INTO clauses_fts(rowid, citation, title, text)
      VALUES (new.rowid, new.citation, new.title, new.text);
    END;
  `);
  // vec0 uses SQLite's implicit rowid; do NOT declare it as a named column.
  // We bind to the magic `rowid` column on INSERT, then JOIN via clauses_vec.rowid.
  db.exec(`
    CREATE VIRTUAL TABLE clauses_vec USING vec0(
      embedding FLOAT[${dim}]
    );
  `);

  const insertClause = db.prepare(`
    INSERT INTO clauses (id, spec, release, version, clause_no, title,
                         parent_id, parent_title, text, citation)
    VALUES (@id, @spec, @release, @version, @clauseNo, @title,
            @parentId, @parentTitle, @text, @citation)
  `);
  const insertVec = db.prepare(`
    INSERT INTO clauses_vec(rowid, embedding) VALUES (?, ?)
  `);
  // .pluck() returns just the rowid scalar (avoids BigInt/object wrapping
  // surprises in sqlite-vec's strict type check on the PK).
  const getRowid = db.prepare(`SELECT rowid FROM clauses WHERE id = ?`).pluck();
  const embById = new Map(clauseEmb.map(r => [r.id, decodeFloat16Base64(r.embedding_b64)]));

  const txn = db.transaction(() => {
    for (const c of clauses) {
      insertClause.run({
        ...c,
        citation: `3GPP ${c.spec} §${c.clauseNo}`,
      });
      const rawRowid = getRowid.get(c.id);
      if (rawRowid == null) throw new Error(`no rowid for ${c.id}`);
      // better-sqlite3 binds JS Number via sqlite3_bind_double() — sqlite-vec
      // rejects non-INTEGER rowids. Coerce to BigInt so it binds as int64.
      const rowid = typeof rawRowid === "bigint" ? rawRowid : BigInt(rawRowid as number);
      const v = embById.get(c.id);
      if (!v) throw new Error(`no embedding for ${c.id}`);
      insertVec.run(rowid, vecToBlob(v));
    }
  });
  txn();

  // 4. Run retrieval and score.
  const baselineSql = db.prepare(`
    SELECT c.id, bm25(clauses_fts) AS score
    FROM clauses_fts
    JOIN clauses c ON c.rowid = clauses_fts.rowid
    WHERE clauses_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `);
  // RRF hybrid: BM25 top-N ∪ vec top-N, scored by Σ 1/(k + rank), per
  // Cormack et al. 2009. ROW_NUMBER() gives us a stable 1-based rank
  // per source.
  const hybridSql = db.prepare(`
    WITH fts_top AS (
      SELECT c.rowid AS rowid,
             ROW_NUMBER() OVER (ORDER BY bm25(clauses_fts)) AS rk
      FROM clauses_fts
      JOIN clauses c ON c.rowid = clauses_fts.rowid
      WHERE clauses_fts MATCH ?
      LIMIT ?
    ),
    vec_top AS (
      SELECT rowid,
             ROW_NUMBER() OVER (ORDER BY distance) AS rk
      FROM clauses_vec
      WHERE embedding MATCH ? AND k = ?
    ),
    fused AS (
      SELECT rowid, SUM(1.0 / (? + rk)) AS rrf_score
      FROM (SELECT rowid, rk FROM fts_top UNION ALL SELECT rowid, rk FROM vec_top)
      GROUP BY rowid
    )
    SELECT c.id, fused.rrf_score AS score
    FROM fused
    JOIN clauses c ON c.rowid = fused.rowid
    ORDER BY fused.rrf_score DESC
    LIMIT ?
  `);

  interface Result {
    qid: number;
    query: string;
    difficulty: string;
    expected: string;
    baselineRank: number; // 0 if not in top-K
    hybridRank: number;
  }
  const results: Result[] = [];

  for (const q of queries) {
    const matchExpr = buildBm25Match(q.query);
    const baseRows = baselineSql.all(matchExpr, TOP_K) as Array<{ id: string }>;
    const baselineRank = (baseRows.findIndex(r => r.id === q.expectedClauseId) + 1) || 0;

    const qVec = queryEmb.find(e => e.id === String(q.qid));
    if (!qVec) throw new Error(`missing query embedding for qid=${q.qid}`);
    const qBlob = vecToBlob(decodeFloat16Base64(qVec.embedding_b64));
    const hybridRows = hybridSql.all(
      matchExpr, CANDIDATES_PER_SOURCE,           // FTS top-N
      qBlob, CANDIDATES_PER_SOURCE,               // vec top-N (k = ?)
      RRF_K, TOP_K,                               // RRF k, final limit
    ) as Array<{ id: string }>;
    const hybridRank = (hybridRows.findIndex(r => r.id === q.expectedClauseId) + 1) || 0;

    results.push({
      qid: q.qid,
      query: q.query,
      difficulty: q.difficulty,
      expected: q.expectedClauseId,
      baselineRank,
      hybridRank,
    });
  }
  db.close();

  // 5. Print scoreboard.
  log("");
  log("per-query results (rank 0 = not in top-10):");
  log("  qid  diff   baseline  hybrid  expected");
  for (const r of results) {
    const flip =
      r.baselineRank === 0 && r.hybridRank > 0 ? "★ recovered" :
      r.hybridRank > 0 && r.baselineRank > 0 && r.hybridRank < r.baselineRank ? "↑ improved" :
      r.hybridRank === 0 && r.baselineRank > 0 ? "↓ regressed" :
      "";
    log(`  ${String(r.qid).padStart(3)}  ${r.difficulty.padEnd(5)}  `
      + `${String(r.baselineRank).padStart(8)}  ${String(r.hybridRank).padStart(6)}  `
      + `${r.expected.padEnd(24)}  ${flip}`);
  }

  function mrr(rs: number[]): number {
    const total = rs.reduce((acc, r) => acc + (r > 0 ? 1 / r : 0), 0);
    return total / rs.length;
  }
  function recallAt(rs: number[], k: number): number {
    return rs.filter(r => r > 0 && r <= k).length / rs.length;
  }
  const baseRanks = results.map(r => r.baselineRank);
  const hybRanks = results.map(r => r.hybridRank);
  log("");
  log("aggregate:");
  log(`  baseline  MRR@10=${mrr(baseRanks).toFixed(3)}  R@1=${recallAt(baseRanks,1).toFixed(2)}  R@3=${recallAt(baseRanks,3).toFixed(2)}  R@5=${recallAt(baseRanks,5).toFixed(2)}`);
  log(`  hybrid    MRR@10=${mrr(hybRanks).toFixed(3)}   R@1=${recallAt(hybRanks,1).toFixed(2)}  R@3=${recallAt(hybRanks,3).toFixed(2)}  R@5=${recallAt(hybRanks,5).toFixed(2)}`);

  const mrrLift = mrr(hybRanks) - mrr(baseRanks);
  const r5Lift = recallAt(hybRanks, 5) - recallAt(baseRanks, 5);
  log("");
  log(`MRR@10 lift: ${mrrLift >= 0 ? "+" : ""}${mrrLift.toFixed(3)}`);
  log(`Recall@5 lift: ${r5Lift >= 0 ? "+" : ""}${r5Lift.toFixed(2)}`);

  if (mrrLift > 0 && r5Lift >= 0) {
    log("PASS — hybrid beats baseline on this fixture.");
    process.exitCode = 0;
  } else {
    log("FAIL — hybrid did not strictly improve over baseline. Investigate before Phase B.");
    process.exitCode = 1;
  }
}

await main();
