// ─────────────────────────────────────────────────────────────────
// 03-index.ts — emit out/corpus.sqlite from dist/clauses.json plus
// (when present) the v2 dense-embedding sidecar outputs.
//
// v2 schema (SPEC.md §14 ADR-002 / ADR-006 / ADR-008):
//
//   clauses
//     id, spec, release, version, clause_no, title,
//     parent_id, parent_title, path,
//     text,
//     tables_json, figures_json, mentions_json,
//     citation
//
//   clauses_fts (FTS5 over citation/title/parent_title/path/text)
//     porter + unicode61 tokenizer
//
//   clauses_vec  (sqlite-vec, FLOAT[dim], rowid == clauses.rowid)
//   parents      (id TEXT PK, child_count INTEGER)
//   parent_vec   (sqlite-vec, FLOAT[dim], rowid == parents.rowid)
//
//   acronyms     (acronym TEXT PK, expansion TEXT, aliases TEXT)
//   eval_queries (qid INTEGER PK, query, expected_clause_id, stratum, difficulty)
//
//   meta         schemaVersion=2 + embeddingModel/Dim/Dtype + builtAt/release
//
// After build:
//   - golden snippet validation (parse quality, v1 contract)
//   - VACUUM + ANALYZE + optimize
//
// Falls back to a v1-shaped SQLite (no clauses_vec / parent_vec /
// acronyms / eval_queries) when the embedding sidecar output is
// missing, with meta.schemaVersion="2-no-vec". This keeps `npm run
// dry-run` working pre-embedding.
// ─────────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import golden from "./golden-clauses.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const OUT_DIR = path.join(REPO_ROOT, "out");
const IN_CLAUSES_JSON = path.join(DIST_DIR, "clauses.json");
const IN_REPORT = path.join(DIST_DIR, "parse-report.json");
const IN_CLAUSE_EMB = path.join(DIST_DIR, "clauses-with-vec.jsonl");
const IN_PARENT_EMB = path.join(DIST_DIR, "parents-with-vec.jsonl");
const IN_ACRONYMS = path.join(__dirname, "acronyms.json");
const IN_EVAL_QUERIES = path.join(__dirname, "eval-queries.json");
const OUT_SQLITE = path.join(OUT_DIR, "corpus.sqlite");
// Phase 1 (rel17-v4): figure images live in `dist/media/<spec>/`.
// 03-index.ts walks every clause's figures[] array, opens any
// referenced media file, and writes the bytes into `figure_images`
// as a BLOB. The desktop's SpecDrawer reads the blob and renders the
// SVG/PNG/JPEG inline; the LLM triage path passes them as vision
// content blocks when the cited clause has images.
const IN_MEDIA_DIR = path.join(DIST_DIR, "media");

// Schema v3 is purely additive over v2: the only new table is
// `figure_images`. Older desktop builds that hard-coded v2 reads will
// IGNORE the new table and still work — the FTS, vec, parent_vec,
// acronyms, eval_queries surfaces are unchanged. Bumping the version
// lets v3-aware desktops opt INTO rendering the figures.
const SCHEMA_VERSION = "3";
const EMBED_MODEL = process.env.EMBED_MODEL ?? "BAAI/bge-m3";
const EMBED_DTYPE = "float16";

const log = (...args: unknown[]) => console.log("[index]", ...args);
const warn = (...args: unknown[]) => console.warn("[index] ⚠", ...args);

interface ClauseRow {
  id: string;
  spec: string;
  release: string;
  version: string;
  clauseNo: string;
  title: string;
  parentId: string | null;
  parentTitle: string | null;
  /** v2 — ancestor title chain. May be "" for top-level clauses (v1 rows
   *  also tolerated since this script reads clauses.json defensively). */
  path?: string;
  text: string;
  tables?: unknown[];
  figures?: unknown[];
  mentions?: unknown[];
  citation: string;
}

interface ParseReport {
  builtAt: string;
  release: string;
  totalClauses: number;
  specs: Array<{ spec: string; version: string; clauseCount: number }>;
}

interface EmbeddingRecord {
  id: string;
  embedding_b64: string;
  childCount?: number;
}

interface AcronymEntry {
  acronym: string;
  expansion: string;
  aliases?: string[];
}

interface EvalQuery {
  qid: number;
  query: string;
  expectedClauseId: string;
  stratum?: string;
  difficulty?: string;
}

async function readJsonlOptional<T>(p: string): Promise<T[] | null> {
  if (!fsSync.existsSync(p)) return null;
  const raw = await fs.readFile(p, "utf8");
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    out.push(JSON.parse(s) as T);
  }
  return out;
}

async function readJsonOptional<T>(p: string): Promise<T | null> {
  if (!fsSync.existsSync(p)) return null;
  return JSON.parse(await fs.readFile(p, "utf8")) as T;
}

/** Decode base64 → float16 bytes → Float32Array. Used so we can re-encode
 *  as float32 for sqlite-vec (vec0 stores FLOAT32 internally; the on-disk
 *  saving from float16 only matters in transit). */
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

async function main() {
  const rows = JSON.parse(await fs.readFile(IN_CLAUSES_JSON, "utf8")) as ClauseRow[];
  const report = JSON.parse(await fs.readFile(IN_REPORT, "utf8")) as ParseReport;
  log(`indexing ${rows.length} clause(s)`);
  await fs.mkdir(OUT_DIR, { recursive: true });
  try { await fs.unlink(OUT_SQLITE); } catch { /* ENOENT is fine */ }

  // ── Sidecar outputs (optional) ──────────────────────────────
  const clauseEmb = await readJsonlOptional<EmbeddingRecord>(IN_CLAUSE_EMB);
  const parentEmb = await readJsonlOptional<EmbeddingRecord>(IN_PARENT_EMB);
  const acronyms = (await readJsonOptional<{ acronyms?: AcronymEntry[] }>(IN_ACRONYMS))?.acronyms ?? [];
  const evalQueries = (await readJsonOptional<{ queries?: EvalQuery[] }>(IN_EVAL_QUERIES))?.queries ?? [];

  const hasVec = clauseEmb !== null && clauseEmb.length > 0;
  let dim = 0;
  if (hasVec) {
    dim = decodeFloat16Base64(clauseEmb![0].embedding_b64).length;
    log(`vectors: ${clauseEmb!.length} leaf, ${parentEmb?.length ?? 0} parent (dim=${dim})`);
  } else {
    warn("no embedding sidecar output — building a v2-no-vec corpus (FTS5 only)");
  }

  // ── Connection + extension ─────────────────────────────────
  const db = new Database(OUT_SQLITE);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  if (hasVec) {
    sqliteVec.load(db);
    log(`sqlite-vec: ${db.prepare("SELECT vec_version()").pluck().get()}`);
  }

  // ── Core schema ────────────────────────────────────────────
  db.exec(`
    CREATE TABLE clauses (
      id            TEXT PRIMARY KEY,
      spec          TEXT NOT NULL,
      release       TEXT NOT NULL,
      version       TEXT NOT NULL,
      clause_no     TEXT NOT NULL,
      title         TEXT NOT NULL,
      parent_id     TEXT,
      parent_title  TEXT,
      path          TEXT NOT NULL DEFAULT '',
      text          TEXT NOT NULL,
      tables_json   TEXT NOT NULL DEFAULT '[]',
      figures_json  TEXT NOT NULL DEFAULT '[]',
      mentions_json TEXT NOT NULL DEFAULT '[]',
      citation      TEXT NOT NULL
    );

    CREATE INDEX idx_clauses_spec_no ON clauses(spec, clause_no);
    CREATE INDEX idx_clauses_parent  ON clauses(parent_id);

    -- v2 FTS5 widens indexed columns to include parent_title and path
    -- so BM25 ranks hierarchy hits (ADR-004 hierarchy preservation).
    CREATE VIRTUAL TABLE clauses_fts USING fts5(
      citation, title, parent_title, path, text,
      content='clauses',
      content_rowid='rowid',
      tokenize='porter unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER clauses_ai AFTER INSERT ON clauses BEGIN
      INSERT INTO clauses_fts(rowid, citation, title, parent_title, path, text)
      VALUES (new.rowid, new.citation, new.title, new.parent_title, new.path, new.text);
    END;

    CREATE TABLE meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE acronyms (
      acronym   TEXT PRIMARY KEY,
      expansion TEXT NOT NULL,
      aliases   TEXT NOT NULL DEFAULT '[]'   -- JSON array of synonyms
    );

    CREATE TABLE eval_queries (
      qid                INTEGER PRIMARY KEY,
      query              TEXT NOT NULL,
      expected_clause_id TEXT NOT NULL,
      stratum            TEXT,
      difficulty         TEXT
    );

    -- Phase 1 (schemaVersion=3): figure-image blobs. One row per
    -- (clause_id, figure_id) where the figure had an associated media
    -- file. clauses.figures_json still carries the figure_id ↔ caption
    -- mapping; the image bytes live here so the FTS payload doesn't
    -- swell with binary blobs.
    --
    -- mime_type is the canonical IANA form ("image/svg+xml",
    -- "image/png", "image/jpeg", "image/gif"). The desktop reads this
    -- to pick the right <img> rendering path and the right vision-
    -- content-block media_type when passing the bytes to the model.
    CREATE TABLE figure_images (
      clause_id  TEXT NOT NULL,
      figure_id  TEXT NOT NULL,
      mime_type  TEXT NOT NULL,
      bytes      INTEGER NOT NULL,
      data       BLOB NOT NULL,
      PRIMARY KEY (clause_id, figure_id),
      FOREIGN KEY (clause_id) REFERENCES clauses(id)
    );
    CREATE INDEX idx_figure_images_clause ON figure_images(clause_id);
  `);

  if (hasVec) {
    db.exec(`
      CREATE VIRTUAL TABLE clauses_vec USING vec0(embedding FLOAT[${dim}]);
      CREATE TABLE parents (
        id          TEXT PRIMARY KEY,
        child_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE VIRTUAL TABLE parent_vec USING vec0(embedding FLOAT[${dim}]);
    `);
  }

  // ── Insert clauses ─────────────────────────────────────────
  // INSERT OR IGNORE: belt-and-suspenders against duplicate clause ids
  // slipping through the parser. With the v2 parser-level dedup this
  // should never trigger, but if it does, the build keeps going and the
  // final count log surfaces the discrepancy.
  const insertClause = db.prepare(`
    INSERT OR IGNORE INTO clauses (id, spec, release, version, clause_no, title,
                                   parent_id, parent_title, path, text,
                                   tables_json, figures_json, mentions_json, citation)
    VALUES (@id, @spec, @release, @version, @clauseNo, @title,
            @parentId, @parentTitle, @path, @text,
            @tablesJson, @figuresJson, @mentionsJson, @citation)
  `);
  const txClauses = db.transaction((rows: ClauseRow[]) => {
    let i = 0;
    for (const r of rows) {
      insertClause.run({
        id: r.id,
        spec: r.spec,
        release: r.release,
        version: r.version,
        clauseNo: r.clauseNo,
        title: r.title,
        parentId: r.parentId,
        parentTitle: r.parentTitle,
        path: r.path ?? "",
        text: r.text,
        tablesJson: JSON.stringify(r.tables ?? []),
        figuresJson: JSON.stringify(r.figures ?? []),
        mentionsJson: JSON.stringify(r.mentions ?? []),
        citation: r.citation,
      });
      if (++i % 5000 === 0) log(`  inserted ${i}/${rows.length}…`);
    }
  });
  txClauses(rows);
  log(`✓ inserted ${rows.length} clauses`);

  // ── Insert figure-image blobs (Phase 1) ────────────────────
  // Each clause's figures[] is already in clauses.figures_json. We
  // additionally read the on-disk media file referenced by
  // figures[].mediaFilename, and stash the raw bytes in
  // `figure_images` with the canonical IANA mime type. Files that
  // failed to convert (no on-disk match) and figures without any
  // associated image are silently skipped — the figure caption
  // still lives in figures_json, and the desktop falls back to a
  // "caption only" rendering for those.
  let figImgInserted = 0;
  let figImgMissing = 0;
  let figImgBytesTotal = 0;
  const insertFigImg = db.prepare(`
    INSERT OR IGNORE INTO figure_images (clause_id, figure_id, mime_type, bytes, data)
    VALUES (?, ?, ?, ?, ?)
  `);
  const txFigImgs = db.transaction(() => {
    for (const r of rows) {
      const figs = (r.figures ?? []) as Array<{
        id?: string;
        mediaFilename?: string;
      }>;
      for (const fig of figs) {
        if (!fig.mediaFilename || !fig.id) continue;
        // Path: dist/media/<spec>/<filename>. We pull the spec out of
        // r.spec — note r.spec is "TS 38.211" (carries the "TS"
        // prefix); strip it to get the plain spec number used by
        // 02-parse.ts when it builds the media subdir.
        const specPlain = String(r.spec || "").replace(/^TS\s+/i, "").trim();
        const mediaPath = path.join(IN_MEDIA_DIR, specPlain, fig.mediaFilename);
        let buf: Buffer;
        try {
          buf = fsSync.readFileSync(mediaPath);
        } catch {
          figImgMissing++;
          continue;
        }
        const ext = path.extname(fig.mediaFilename).slice(1).toLowerCase();
        const mime =
          ext === "svg" ? "image/svg+xml" :
          ext === "png" ? "image/png" :
          ext === "jpeg" || ext === "jpg" ? "image/jpeg" :
          ext === "gif" ? "image/gif" :
          ext === "webp" ? "image/webp" :
          "application/octet-stream";
        insertFigImg.run(r.id, fig.id, mime, buf.byteLength, buf);
        figImgInserted++;
        figImgBytesTotal += buf.byteLength;
      }
    }
  });
  txFigImgs();
  if (figImgInserted > 0 || figImgMissing > 0) {
    log(
      `✓ inserted ${figImgInserted} figure image(s) (` +
      `${(figImgBytesTotal / 1024 / 1024).toFixed(1)} MB${
        figImgMissing > 0 ? `, ${figImgMissing} missing` : ""
      })`,
    );
  } else {
    log("no figure images on disk (skipped)");
  }

  // ── Insert vectors ────────────────────────────────────────
  if (hasVec) {
    const getRowid = db.prepare(`SELECT rowid FROM clauses WHERE id = ?`).pluck();
    const insertVec = db.prepare(`INSERT INTO clauses_vec(rowid, embedding) VALUES (?, ?)`);
    const txVecs = db.transaction(() => {
      let n = 0, missing = 0, dup = 0;
      // Defensive dedup: if the embed sidecar emitted the same id twice
      // (because the v1 parser produced duplicates), the second INSERT
      // into clauses_vec would fail with a PK collision. Skip silently
      // and count for the log.
      const seen = new Set<string>();
      for (const e of clauseEmb!) {
        if (seen.has(e.id)) { dup++; continue; }
        seen.add(e.id);
        const rid = getRowid.get(e.id);
        if (rid == null) { missing++; continue; }
        // sqlite-vec rejects non-INTEGER rowids; better-sqlite3 binds
        // JS Number as REAL by default, so coerce to BigInt.
        const rowid = typeof rid === "bigint" ? rid : BigInt(rid as number);
        insertVec.run(rowid, vecToBlob(decodeFloat16Base64(e.embedding_b64)));
        n++;
        if (n % 1000 === 0) log(`  vec inserted ${n}/${clauseEmb!.length}…`);
      }
      if (missing > 0) warn(`${missing} embedding(s) had no matching clause row`);
      if (dup > 0) warn(`${dup} duplicate embedding(s) skipped`);
      return n;
    });
    const vecCount = txVecs();
    log(`✓ inserted ${vecCount} leaf vector(s)`);

    if (parentEmb && parentEmb.length > 0) {
      const insertParent = db.prepare(`INSERT INTO parents (id, child_count) VALUES (?, ?)`);
      const insertParentVec = db.prepare(`INSERT INTO parent_vec(rowid, embedding) VALUES (?, ?)`);
      const txParents = db.transaction(() => {
        let n = 0;
        for (const p of parentEmb) {
          const info = insertParent.run(p.id, p.childCount ?? 0);
          const rid = info.lastInsertRowid;
          const rowid = typeof rid === "bigint" ? rid : BigInt(rid as number);
          insertParentVec.run(rowid, vecToBlob(decodeFloat16Base64(p.embedding_b64)));
          n++;
        }
        return n;
      });
      const parentCount = txParents();
      log(`✓ inserted ${parentCount} parent rollup vector(s)`);
    }
  }

  // ── Acronyms ──────────────────────────────────────────────
  if (acronyms.length > 0) {
    const ins = db.prepare(`INSERT INTO acronyms (acronym, expansion, aliases) VALUES (?, ?, ?)`);
    const tx = db.transaction(() => {
      for (const a of acronyms) {
        ins.run(a.acronym, a.expansion, JSON.stringify(a.aliases ?? []));
      }
    });
    tx();
    log(`✓ inserted ${acronyms.length} acronym(s)`);
  } else {
    log("no acronyms.json entries (skipped)");
  }

  // ── Eval queries ──────────────────────────────────────────
  if (evalQueries.length > 0) {
    const ins = db.prepare(`
      INSERT INTO eval_queries (qid, query, expected_clause_id, stratum, difficulty)
      VALUES (?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      for (const q of evalQueries) {
        ins.run(q.qid, q.query, q.expectedClauseId, q.stratum ?? null, q.difficulty ?? null);
      }
    });
    tx();
    log(`✓ inserted ${evalQueries.length} eval query/queries`);
  } else {
    log("no eval-queries.json entries (skipped)");
  }

  // ── Meta ──────────────────────────────────────────────────
  const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  meta.run("release", report.release);
  meta.run("builtAt", report.builtAt);
  meta.run("specCount", String(report.specs.length));
  meta.run("totalClauses", String(rows.length));
  meta.run("totalFigureImages", String(figImgInserted));
  meta.run("schemaVersion", hasVec ? SCHEMA_VERSION : `${SCHEMA_VERSION}-no-vec`);
  if (hasVec) {
    meta.run("embeddingModel", EMBED_MODEL);
    meta.run("embeddingDim", String(dim));
    meta.run("embeddingDtype", EMBED_DTYPE);
  }

  // ── Optimize ──────────────────────────────────────────────
  log("optimizing (FTS5 optimize + ANALYZE + PRAGMA optimize)…");
  db.exec("INSERT INTO clauses_fts(clauses_fts) VALUES('optimize')");
  db.exec("ANALYZE");
  db.pragma("optimize");
  db.close();

  // VACUUM on a fresh connection (WAL doesn't allow VACUUM inside its txn).
  const db2 = new Database(OUT_SQLITE);
  db2.exec("VACUUM");
  db2.close();

  // ── Golden-clauses validation ─────────────────────────────
  const db3 = new Database(OUT_SQLITE, { readonly: true });
  log("");
  log("validating against golden snippets…");
  const goldenList = (golden as { clauses: Array<{ id: string; citation: string; snippet: string }> }).clauses;
  let goldenFails = 0;
  for (const g of goldenList) {
    const row = db3.prepare("SELECT text, title FROM clauses WHERE id = ?").get(g.id) as { text?: string; title?: string } | undefined;
    if (!row) {
      warn(`  ✗ ${g.citation}: clause not in corpus (id=${g.id})`);
      goldenFails++;
      continue;
    }
    const hay = `${row.title}\n${row.text}`.toLowerCase();
    if (!hay.includes(g.snippet.toLowerCase())) {
      warn(`  ✗ ${g.citation}: snippet '${g.snippet}' not found in parsed text`);
      goldenFails++;
      continue;
    }
    log(`  ✓ ${g.citation}: matched '${g.snippet}'`);
  }
  db3.close();

  // ── Stats ─────────────────────────────────────────────────
  const stat = await fs.stat(OUT_SQLITE);
  log("");
  log(`✓ wrote ${OUT_SQLITE}`);
  log(`  size:       ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  log(`  clauses:    ${rows.length}`);
  log(`  specs:      ${report.specs.length}`);
  log(`  schemaVer:  ${hasVec ? SCHEMA_VERSION : `${SCHEMA_VERSION}-no-vec`}`);
  log(`  golden:     ${goldenList.length - goldenFails}/${goldenList.length} passed`);

  if (goldenFails > 0) {
    warn(`golden validation failed for ${goldenFails} clause(s); review parse output`);
    process.exitCode = 2;
  }
}

await main();
