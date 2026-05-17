// ─────────────────────────────────────────────────────────────────
// 03-index.ts — emit out/corpus.sqlite from dist/clauses.json.
//
// Schema (must match the consumer in bugzilla-triage-desktop
// lib/corpus/retriever.ts):
//
//   clauses        — one row per leaf clause, PK on id
//   clauses_fts    — FTS5 virtual table with porter+unicode tokenizer,
//                    indexes citation/title/text, gives us BM25 for free
//   meta           — { key, value } table for corpus version/release/builtAt
//
// After build:
//   - VACUUM to compact (FTS rebuilds leave deleted pages)
//   - ANALYZE for the query planner
//   - PRAGMA optimize for autoindex hints
//   - validate against scripts/golden-clauses.json: every golden snippet
//     must be present in its corresponding clause text. Build fails if
//     any miss — catches DOCX-parsing regressions before we ship.
// ─────────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import golden from "./golden-clauses.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const OUT_DIR = path.join(REPO_ROOT, "out");
const IN_CLAUSES = path.join(DIST_DIR, "clauses.json");
const IN_REPORT = path.join(DIST_DIR, "parse-report.json");
const OUT_SQLITE = path.join(OUT_DIR, "corpus.sqlite");

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
  text: string;
  citation: string;
}

interface ParseReport {
  builtAt: string;
  release: string;
  totalClauses: number;
  specs: Array<{ spec: string; version: string; clauseCount: number }>;
}

async function main() {
  const rows = JSON.parse(await fs.readFile(IN_CLAUSES, "utf8")) as ClauseRow[];
  const report = JSON.parse(await fs.readFile(IN_REPORT, "utf8")) as ParseReport;
  log(`indexing ${rows.length} clause(s)`);
  await fs.mkdir(OUT_DIR, { recursive: true });
  // Always start from a clean file — incremental builds aren't worth the
  // schema-migration complexity for a corpus that's regenerated.
  try { await fs.unlink(OUT_SQLITE); } catch { /* ENOENT is fine */ }

  const db = new Database(OUT_SQLITE);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  // ── Schema ────────────────────────────────────────────────────
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
      text          TEXT NOT NULL,
      citation      TEXT NOT NULL
    );

    CREATE INDEX idx_clauses_spec_no ON clauses(spec, clause_no);

    -- FTS5 virtual table over the searchable columns. The 'porter' +
    -- 'unicode61' tokenizer handles English morphology and Unicode
    -- punctuation found in 3GPP specs (em-dashes, §, etc.). 'remove_diacritics 2'
    -- normalizes accented characters where 3GPP has them.
    CREATE VIRTUAL TABLE clauses_fts USING fts5(
      citation, title, text,
      content='clauses',
      content_rowid='rowid',
      tokenize='porter unicode61 remove_diacritics 2'
    );

    -- Triggers keep the FTS table in sync with clauses. We populate
    -- once at build time, so the INSERT trigger is what matters.
    CREATE TRIGGER clauses_ai AFTER INSERT ON clauses BEGIN
      INSERT INTO clauses_fts(rowid, citation, title, text)
      VALUES (new.rowid, new.citation, new.title, new.text);
    END;

    CREATE TABLE meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // ── Insert clauses ───────────────────────────────────────────
  const insert = db.prepare(`
    INSERT INTO clauses (id, spec, release, version, clause_no, title,
                         parent_id, parent_title, text, citation)
    VALUES (@id, @spec, @release, @version, @clauseNo, @title,
            @parentId, @parentTitle, @text, @citation)
  `);

  const insertMany = db.transaction((rows: ClauseRow[]) => {
    let i = 0;
    for (const r of rows) {
      insert.run(r);
      if (++i % 5000 === 0) log(`  inserted ${i}/${rows.length}…`);
    }
  });
  insertMany(rows);
  log(`✓ inserted ${rows.length} clauses`);

  // ── Meta ──────────────────────────────────────────────────────
  const meta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  meta.run("release", report.release);
  meta.run("builtAt", report.builtAt);
  meta.run("specCount", String(report.specs.length));
  meta.run("totalClauses", String(rows.length));
  meta.run("schemaVersion", "1");

  // ── Optimize ──────────────────────────────────────────────────
  log("optimizing (VACUUM + ANALYZE + optimize)…");
  db.exec("INSERT INTO clauses_fts(clauses_fts) VALUES('optimize')");
  db.exec("ANALYZE");
  db.pragma("optimize");
  // VACUUM must run outside the WAL transaction the connection started with;
  // close the WAL and run it on a fresh connection.
  db.close();

  const db2 = new Database(OUT_SQLITE);
  db2.exec("VACUUM");
  db2.close();

  // ── Golden-clauses validation ─────────────────────────────────
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

  // ── Stats ─────────────────────────────────────────────────────
  const stat = await fs.stat(OUT_SQLITE);
  log("");
  log(`✓ wrote ${OUT_SQLITE}`);
  log(`  size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  log(`  clauses: ${rows.length}`);
  log(`  specs: ${report.specs.length}`);
  log(`  golden validation: ${goldenList.length - goldenFails}/${goldenList.length} passed`);

  if (goldenFails > 0) {
    warn(`golden validation failed for ${goldenFails} clause(s); review parse output`);
    // Treat this as a soft fail: write the file but exit non-zero so CI
    // can choose to block. For an interactive build the user can inspect
    // and decide.
    process.exitCode = 2;
  }
}

await main();
