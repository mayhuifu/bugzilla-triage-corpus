// ─────────────────────────────────────────────────────────────────
// 05-eval.ts — measure retrieval quality of out/corpus.sqlite
// against the eval_queries set shipped inside the SQLite (ADR-008).
//
// For each query:
//   • baseline = FTS5 BM25 with the OR-of-terms construction the
//     v1 desktop retriever uses
//   • hybrid   = FTS5 top-50 ⊕ sqlite-vec top-50, RRF fusion (k=60)
//
// Reports Recall@1/3/5/10, MRR@10, broken down by stratum.
// Writes dist/eval-report.json.
//
// Build-gate behaviour (per ADR-008):
//   • no eval_queries        → skip gate, exit 0
//   • no vectors in corpus   → run baseline only, exit 0 (build is v2-no-vec)
//   • hybrid MRR@10 strictly lower than baseline                   → exit 1
//   • hybrid lift < target absolute (default 0.15) over baseline   → exit 1
//
// Override the lift target with EVAL_MIN_LIFT=0.10 etc. The default
// is conservative; tune downward early in the eval-set rollout once
// you've seen the baseline numbers, but keep > 0 to enforce that
// hybrid actually helps.
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
const DIST_DIR = path.join(REPO_ROOT, "dist");
const OUT_SQLITE = path.join(REPO_ROOT, "out", "corpus.sqlite");
const OUT_REPORT = path.join(DIST_DIR, "eval-report.json");

const MIN_LIFT = Number(process.env.EVAL_MIN_LIFT ?? "0.15");
const RRF_K = 60;
const CANDIDATES_PER_SOURCE = 50;
const TOP_K = 10;
const PYTHON = process.env.EMBED_PY ?? "python3";

const log = (...args: unknown[]) => console.log("[eval]", ...args);
const warn = (...args: unknown[]) => console.warn("[eval] ⚠", ...args);

// ── Tokenization mirroring the v1 desktop retriever ──────────────
// retriever.ts builds an OR-of-terms BM25 query from the bug text.
// Mirror it here so "baseline" measures what the desktop actually
// does today, not an idealized BM25.
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
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

// ── float16 base64 → Float32Array (matches embed.ts) ────────────
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
function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

interface EvalRow {
  qid: number;
  query: string;
  expected_clause_id: string;
  stratum: string | null;
  difficulty: string | null;
}

interface PerQueryResult {
  qid: number;
  query: string;
  stratum: string | null;
  difficulty: string | null;
  expected: string;
  baselineRank: number;
  hybridRank: number | null;   // null when corpus has no vectors
}

interface AggMetrics {
  count: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  recallAt10: number;
  mrrAt10: number;
}

function metrics(ranks: number[]): AggMetrics {
  const count = ranks.length || 1;
  const recallAt = (k: number) => ranks.filter(r => r > 0 && r <= k).length / count;
  const mrr = ranks.reduce((acc, r) => acc + (r > 0 ? 1 / r : 0), 0) / count;
  return {
    count: ranks.length,
    recallAt1: recallAt(1),
    recallAt3: recallAt(3),
    recallAt5: recallAt(5),
    recallAt10: recallAt(10),
    mrrAt10: mrr,
  };
}

function runSidecar(inPath: string, outPath: string, model: string) {
  const sidecar = path.join(__dirname, "embed_sidecar.py");
  const args = [
    sidecar,
    "--in", inPath,
    "--out", outPath,
    "--model", model,
    "--batch-size", "32",
  ];
  log(`spawn ${PYTHON} ${args.join(" ")}`);
  const r = spawnSync(PYTHON, args, { stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) throw new Error(`embed_sidecar.py failed (status=${r.status})`);
}

async function main() {
  await fs.mkdir(DIST_DIR, { recursive: true });
  if (!fsSync.existsSync(OUT_SQLITE)) {
    console.error("[eval] out/corpus.sqlite missing — run `npm run index` first.");
    process.exit(1);
  }

  const db = new Database(OUT_SQLITE, { readonly: true });
  // sqlite-vec needs to be loaded against this connection to enable MATCH
  // on vec0 tables — load() works fine on a readonly DB.
  try { sqliteVec.load(db); } catch (e) {
    warn(`could not load sqlite-vec extension: ${(e as Error).message}`);
  }

  const schemaVer = db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").pluck().get() as string | undefined;
  const embeddingModel = db.prepare("SELECT value FROM meta WHERE key='embeddingModel'").pluck().get() as string | undefined;
  const hasVec = !!schemaVer && !schemaVer.endsWith("-no-vec");
  log(`corpus schemaVersion=${schemaVer ?? "?"}; embeddingModel=${embeddingModel ?? "<none>"}`);

  const queries = db.prepare(`
    SELECT qid, query, expected_clause_id, stratum, difficulty
    FROM eval_queries
    ORDER BY qid
  `).all() as EvalRow[];
  if (queries.length === 0) {
    log("no eval_queries in corpus — skipping precision gate (exit 0)");
    await fs.writeFile(OUT_REPORT, JSON.stringify({
      builtAt: new Date().toISOString(),
      hasVec, embeddingModel: embeddingModel ?? null,
      queryCount: 0,
      note: "no eval queries — gate skipped",
    }, null, 2));
    db.close();
    return;
  }
  log(`evaluating ${queries.length} query/queries`);

  // ── Validate eval-query clause IDs ─────────────────────────
  // The clauses table holds only leaves. An eval entry whose
  // expectedClauseId isn't there means either (a) typo, or (b) the
  // referenced clause is a non-leaf in this build and its children
  // are the actual leaves. We surface the latter case by listing
  // sibling/child leaves with the same prefix, so the fix is obvious.
  log("validating eval-query clause IDs against corpus…");
  const idCheck = db.prepare("SELECT 1 FROM clauses WHERE id = ?").pluck();
  const suggestSiblings = db.prepare(`
    SELECT id FROM clauses
    WHERE id LIKE ? OR id LIKE ?
    ORDER BY id
    LIMIT 6
  `);
  type Missing = { qid: number; expected: string; suggestions: string[] };
  const missing: Missing[] = [];
  for (const q of queries) {
    if (idCheck.get(q.expected_clause_id) === 1) continue;
    // Build prefix patterns. For "38.331#5.7.3":
    //   '38.331#5.7.3.%'  → children of the targeted (non-leaf) clause
    //   '38.331#5.7.%'    → siblings under the same parent
    const childPattern = `${q.expected_clause_id}.%`;
    const lastDot = q.expected_clause_id.lastIndexOf(".");
    const siblingPattern = lastDot > q.expected_clause_id.indexOf("#")
      ? `${q.expected_clause_id.slice(0, lastDot)}.%`
      : `${q.expected_clause_id}%`;
    const rows = suggestSiblings.all(childPattern, siblingPattern) as Array<{ id: string }>;
    missing.push({
      qid: q.qid,
      expected: q.expected_clause_id,
      suggestions: rows.map(r => r.id).filter(id => id !== q.expected_clause_id).slice(0, 5),
    });
  }
  if (missing.length > 0) {
    warn(`${missing.length} of ${queries.length} eval queries point at clause IDs that are not leaves in this corpus:`);
    for (const m of missing) {
      warn(`  qid=${m.qid} expects ${m.expected} — MISSING`);
      if (m.suggestions.length > 0) {
        warn(`    nearby leaves:`);
        for (const s of m.suggestions) warn(`      - ${s}`);
      } else {
        warn(`    (no nearby leaves found — check the spec / clause number)`);
      }
    }
    warn("fix eval-queries.json (or rebuild corpus) before relying on the precision gate.");
    if (process.env.EVAL_SKIP_MISSING !== "1") {
      db.close();
      // Still emit a report so CI/users can grep the JSON.
      await fs.writeFile(OUT_REPORT, JSON.stringify({
        builtAt: new Date().toISOString(),
        hasVec, embeddingModel: embeddingModel ?? null,
        queryCount: queries.length,
        missingIds: missing,
        note: "ID validation failed — fix eval-queries.json IDs and re-run",
      }, null, 2));
      log(`wrote ${OUT_REPORT}`);
      process.exitCode = 3;
      return;
    }
    warn("EVAL_SKIP_MISSING=1 set — skipping missing-ID failures and proceeding with the survivors");
  }
  const liveQueries = missing.length > 0
    ? queries.filter(q => !missing.some(m => m.qid === q.qid))
    : queries;
  if (liveQueries.length === 0) {
    warn("no queries with valid IDs remain — nothing to measure");
    db.close();
    return;
  }

  // ── Embed queries (only when vectors are available) ─────────
  let queryEmb = new Map<number, Buffer>();
  if (hasVec) {
    if (!embeddingModel) {
      warn("vectors present but no meta.embeddingModel — falling back to BAAI/bge-m3");
    }
    const tmpIn = path.join(DIST_DIR, ".eval-queries.in.jsonl");
    const tmpOut = path.join(DIST_DIR, ".eval-queries.emb.jsonl");
    await fs.writeFile(
      tmpIn,
      liveQueries.map(q => JSON.stringify({ id: String(q.qid), text: q.query })).join("\n") + "\n",
    );
    runSidecar(tmpIn, tmpOut, embeddingModel ?? "BAAI/bge-m3");
    const lines = (await fs.readFile(tmpOut, "utf8")).split("\n").filter(Boolean);
    for (const ln of lines) {
      const r = JSON.parse(ln) as { id: string; embedding_b64: string };
      queryEmb.set(Number(r.id), vecToBlob(decodeFloat16Base64(r.embedding_b64)));
    }
    if (!process.env.EVAL_KEEP_TMP) {
      try { await fs.unlink(tmpIn); } catch { /* ignore */ }
      try { await fs.unlink(tmpOut); } catch { /* ignore */ }
    }
  }

  // ── Prepared statements ─────────────────────────────────────
  const baselineSql = db.prepare(`
    SELECT c.id
    FROM clauses_fts
    JOIN clauses c ON c.rowid = clauses_fts.rowid
    WHERE clauses_fts MATCH ?
    ORDER BY bm25(clauses_fts)
    LIMIT ?
  `);
  const hybridSql = hasVec ? db.prepare(`
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
    SELECT c.id
    FROM fused
    JOIN clauses c ON c.rowid = fused.rowid
    ORDER BY fused.rrf_score DESC
    LIMIT ?
  `) : null;

  // ── Per-query loop ─────────────────────────────────────────
  const results: PerQueryResult[] = [];
  for (const q of liveQueries) {
    const match = buildBm25Match(q.query);
    const baseRows = baselineSql.all(match, TOP_K) as Array<{ id: string }>;
    const baselineRank = (baseRows.findIndex(r => r.id === q.expected_clause_id) + 1) || 0;

    let hybridRank: number | null = null;
    if (hybridSql) {
      const qBlob = queryEmb.get(q.qid);
      if (!qBlob) {
        warn(`no embedding for qid=${q.qid}; skipping hybrid for this query`);
      } else {
        const hybridRows = hybridSql.all(
          match, CANDIDATES_PER_SOURCE,
          qBlob, CANDIDATES_PER_SOURCE,
          RRF_K, TOP_K,
        ) as Array<{ id: string }>;
        hybridRank = (hybridRows.findIndex(r => r.id === q.expected_clause_id) + 1) || 0;
      }
    }

    results.push({
      qid: q.qid,
      query: q.query,
      stratum: q.stratum,
      difficulty: q.difficulty,
      expected: q.expected_clause_id,
      baselineRank,
      hybridRank,
    });
  }
  db.close();

  // ── Aggregate ──────────────────────────────────────────────
  const overall = {
    baseline: metrics(results.map(r => r.baselineRank)),
    hybrid: hasVec ? metrics(results.map(r => r.hybridRank ?? 0)) : null,
  };
  const byStratum = new Map<string, { baseline: number[]; hybrid: number[] }>();
  for (const r of results) {
    const s = r.stratum ?? "<unlabeled>";
    const slot = byStratum.get(s) ?? { baseline: [], hybrid: [] };
    slot.baseline.push(r.baselineRank);
    slot.hybrid.push(r.hybridRank ?? 0);
    byStratum.set(s, slot);
  }
  const stratumReport: Record<string, { baseline: AggMetrics; hybrid: AggMetrics | null }> = {};
  for (const [s, vals] of byStratum) {
    stratumReport[s] = {
      baseline: metrics(vals.baseline),
      hybrid: hasVec ? metrics(vals.hybrid) : null,
    };
  }

  // ── Pretty print ───────────────────────────────────────────
  log("");
  log("per-query results (rank 0 = not in top-10):");
  log("  qid  stratum         diff   baseline  hybrid  expected");
  for (const r of results) {
    const flip =
      r.hybridRank !== null && r.baselineRank === 0 && r.hybridRank > 0 ? "★ recovered" :
      r.hybridRank !== null && r.hybridRank > 0 && r.baselineRank > 0 && r.hybridRank < r.baselineRank ? "↑ improved" :
      r.hybridRank !== null && r.hybridRank === 0 && r.baselineRank > 0 ? "↓ regressed" :
      "";
    log(`  ${String(r.qid).padStart(3)}  ${(r.stratum ?? "").padEnd(15).slice(0,15)}  `
      + `${(r.difficulty ?? "").padEnd(5).slice(0,5)}  `
      + `${String(r.baselineRank).padStart(8)}  ${String(r.hybridRank ?? "—").padStart(6)}  `
      + `${r.expected.padEnd(24)}  ${flip}`);
  }

  log("");
  log("overall:");
  log(`  baseline  MRR@10=${overall.baseline.mrrAt10.toFixed(3)}  R@1=${overall.baseline.recallAt1.toFixed(2)}  R@5=${overall.baseline.recallAt5.toFixed(2)}  R@10=${overall.baseline.recallAt10.toFixed(2)}`);
  if (overall.hybrid) {
    log(`  hybrid    MRR@10=${overall.hybrid.mrrAt10.toFixed(3)}  R@1=${overall.hybrid.recallAt1.toFixed(2)}  R@5=${overall.hybrid.recallAt5.toFixed(2)}  R@10=${overall.hybrid.recallAt10.toFixed(2)}`);
    const lift = overall.hybrid.mrrAt10 - overall.baseline.mrrAt10;
    log(`  MRR@10 lift: ${lift >= 0 ? "+" : ""}${lift.toFixed(3)} (target ≥ ${MIN_LIFT})`);
  }

  // ── Report file ────────────────────────────────────────────
  const reportPayload = {
    builtAt: new Date().toISOString(),
    hasVec,
    embeddingModel: embeddingModel ?? null,
    queryCount: liveQueries.length,
    skippedMissingIds: missing,
    minLiftTarget: MIN_LIFT,
    overall,
    byStratum: stratumReport,
    perQuery: results,
  };
  await fs.writeFile(OUT_REPORT, JSON.stringify(reportPayload, null, 2));
  log(`wrote ${OUT_REPORT}`);

  // ── Gate ──────────────────────────────────────────────────
  if (!hasVec) {
    log("v2-no-vec corpus: baseline only, gate skipped (exit 0)");
    return;
  }
  const lift = overall.hybrid!.mrrAt10 - overall.baseline.mrrAt10;
  if (lift < 0) {
    warn(`FAIL: hybrid MRR@10 lower than baseline (${lift.toFixed(3)})`);
    process.exitCode = 1;
  } else if (lift < MIN_LIFT) {
    warn(`FAIL: hybrid MRR@10 lift ${lift.toFixed(3)} below target ${MIN_LIFT}`);
    process.exitCode = 1;
  } else {
    log("PASS: hybrid lift meets target");
  }
}

await main();
