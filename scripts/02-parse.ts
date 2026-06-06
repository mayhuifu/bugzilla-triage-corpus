// ─────────────────────────────────────────────────────────────────
// 02-parse.ts — convert each downloaded .docx into a JSON array of
// leaf-clause records.
//
// v3 (Phase B / rel17-v6): the extractor underneath was swapped from
// mammoth (DOCX→HTML) to **Docling** via a Python sidecar
// (scripts/parse_sidecar.py). Docling parses the DOCX natively into a
// reading-order element stream — headings (with 3GPP clause numbers),
// text, tables (clean structured CELLS, not pipe-flattened HTML), and
// figures (extracted directly as PNG). This fixes mammoth's misformed
// tables and removes the entire WMF/EMF→SVG soffice conversion path
// (Docling rasterises vector diagrams to PNG itself).
//
// The PROVEN leaf-clause logic is unchanged: parseHeading,
// buildPath, leaf-detection by clause-number depth, first-wins dedup,
// pre-"1 Scope" front-matter drop, and the ClauseRow / parse-report
// shapes are all byte-for-byte the same as v2. Only the source of the
// element stream changed (mammoth HTML walk → Docling sidecar).
//
// Strategy:
//   1. parse_sidecar.py converts each part DOCX → ordered element stream.
//      02-parse concatenates the parts' streams in manifest order.
//   2. Walk the stream. Each heading whose text matches the 3GPP
//      numbered-clause pattern opens a clause; subsequent text / tables /
//      figures belong to it until the next numbered heading.
//   3. A clause is "leaf" if no deeper-numbered heading appears under it
//      (numeric prefix depth comparison — unchanged).
//   4. Output rows shape:
//        { id, spec, release, version, clauseNo, title, parentId,
//          parentTitle, path, text, tables, figures, mentions, citation }
//
// Output:
//   dist/clauses.jsonl  — canonical, one record per line (ADR-006)
//   dist/clauses.json   — legacy array (read by 03-index.ts)
//   dist/parse-report.json — per-spec counts + warning list
//
// Requires: a Python env with `docling` installed. Point at it via
// DOCLING_PYTHON (default: /tmp/docling-venv/bin/python). Set up with:
//   uv venv --python 3.12 <venv> && uv pip install --python <venv> docling
// ─────────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(REPO_ROOT, "raw");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const FETCH_MANIFEST = path.join(RAW_DIR, "fetch-manifest.json");
const OUT_CLAUSES_JSON = path.join(DIST_DIR, "clauses.json");
const OUT_CLAUSES_JSONL = path.join(DIST_DIR, "clauses.jsonl");
const OUT_REPORT = path.join(DIST_DIR, "parse-report.json");
// Phase 1: figure images live here under per-spec subdirs:
// `dist/media/<spec>/<mediaId>.png`. 03-index.ts blob-ingests them into
// the `figure_images` SQLite table. (v3: always PNG — Docling rasterises.)
const MEDIA_DIR = path.join(DIST_DIR, "media");
// Docling conversion cache (per DOCX part) — lets a re-parse skip the slow
// Docling convert() when the source DOCX is unchanged. Disable with
// NO_DOCLING_CACHE=1. See parse_sidecar.py for the keying + invalidation.
const DOCLING_CACHE_DIR = process.env.NO_DOCLING_CACHE === "1"
  ? "" : path.join(DIST_DIR, "docling-cache");

// The Docling sidecar + the Python interpreter that has docling installed.
const SIDECAR = path.join(__dirname, "parse_sidecar.py");
const PYTHON = process.env.DOCLING_PYTHON || "/tmp/docling-venv/bin/python";

const log = (...args: unknown[]) => console.log("[parse]", ...args);
const warn = (...args: unknown[]) => console.warn("[parse] ⚠", ...args);

interface FetchedSpec {
  spec: string;
  series: string;
  title: string;
  release: string;
  version: string;
  versionTag: string;
  zipUrl: string;
  parts: string[];
  bytes: number;
}

// One element of the Docling reading-order stream (see parse_sidecar.py).
interface Element {
  kind: "heading" | "text" | "table" | "figure";
  // heading
  level?: number;
  text?: string;
  clauseNo?: string | null;
  title?: string;
  // text
  label?: string;
  _claimed?: boolean; // text element consumed as a figure/table caption
  // table
  rows?: string[][];
  nrows?: number;
  ncols?: number;
  // figure
  mediaFilename?: string | null;
  caption?: string | null;
}

interface ExtractedTable {
  id: string;          // "38.211#6.3.3.1/Table-1" (assigned at row build)
  caption: string;     // empty if no caption found
  rows: string[][];    // header row first if detectable, else as-emitted
}

interface ExtractedFigure {
  id: string;
  caption: string;
  /** The media file on disk that renders this figure (PNG). Empty when a
   *  "Figure N:" caption appears but no image paired with it. */
  mediaFilename?: string;
}

interface ClauseRow {
  id: string;
  spec: string;
  release: string;
  version: string;
  clauseNo: string;
  title: string;
  parentId: string | null;
  parentTitle: string | null;
  /** Ancestor title chain joined with " / ", innermost last. v2 (ADR-004). */
  path: string;
  text: string;
  /** Structured table data from this clause's body (v2). */
  tables: ExtractedTable[];
  /** Figure captions referenced in this clause's body (v2). */
  figures: ExtractedFigure[];
  /** Reserved slot for entity extraction (v3). Always [] here (ADR-005). */
  mentions: string[];
  citation: string;
}

interface ParseReport {
  builtAt: string;
  release: string;
  specs: Array<{
    spec: string;
    version: string;
    clauseCount: number;
    tableCount: number;
    figureCount: number;
    warnings: string[];
  }>;
  totalClauses: number;
  totalTables: number;
  totalFigures: number;
}

// ── Heading detection (UNCHANGED from v2) ───────────────────────────

function parseHeading(rawText: string): { clauseNo: string; title: string } | null {
  const text = (rawText ?? "").trim();
  if (!text) return null;
  const m = text.match(/^([A-Z]?\d+(?:\.\d+)*|[A-Z](?:\.\d+)+)\s+(.+?)\s*$/);
  if (!m) return null;
  const clauseNo = m[1];
  const title = m[2].replace(/\s+/g, " ").trim();
  if (/\.\.\.\s*\d+\s*$/.test(text)) return null;     // ToC line
  if (title.length > 200) return null;                // not a real heading
  // Real 3GPP top-level clauses are 1..9 (Scope, References, …); a pure
  // integer >= 10 is overwhelmingly a frequency band cell, table row
  // number, or other in-table content surfaced as a heading. Reject so we
  // don't generate clauses like `38.101-1#788 MHz`.
  if (/^\d+$/.test(clauseNo) && Number(clauseNo) >= 10) return null;
  return { clauseNo, title };
}

// ── Caption patterns (UNCHANGED from v2) ────────────────────────────

const TABLE_CAPTION_RE = /^Table\s+([\dA-Z][\d.A-Z-]*):?\s*(.+?)$/m;
const FIGURE_CAPTION_RE = /^Figure\s+([\dA-Z][\d.A-Z-]*):?\s*(.+?)$/m;
// STRICT variant for the caption-only (no paired image) fallback. Requires a
// COLON so it matches real captions ("Figure 5.2.2-1: RRC states") but NOT
// cross-reference prose ("Figure 5.2.2-1 shows the states…"), which would
// otherwise emit a spurious duplicate figure record.
const FIGURE_CAPTION_STRICT = /^Figure\s+([\dA-Z][\d.A-Z-]*)\s*:\s+(.+?)$/m;

// ── Element-stream extraction (replaces mammoth HTML walk) ──────────

/** Flatten a structured table to FTS-friendly text (cells " | ", rows "\n") —
 *  mirrors v2's htmlToText table handling so BM25 still indexes table content. */
function flattenTable(rows: string[][]): string {
  return rows
    .map(r => r.map(c => (c ?? "").replace(/\s+/g, " ").trim()).join(" | "))
    .join("\n");
}

/** Build the clause body text from its element stream. Text paragraphs join
 *  with blank lines; tables are flattened inline (FTS fallback); figures
 *  contribute nothing (their "Figure N:" caption is a separate text element,
 *  already included — matching v2 where the caption <p> stayed in the body). */
function buildBodyText(body: Element[]): string {
  const parts: string[] = [];
  for (const el of body) {
    if (el.kind === "text") {
      const t = (el.text ?? "").trim();
      if (t) parts.push(t);
    } else if (el.kind === "table") {
      const f = flattenTable(el.rows ?? []);
      if (f) parts.push(f);
    }
  }
  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Pull structured tables + figures from a clause's element stream, and build
 *  its body text. Mirrors v2 extractTablesAndFigures + htmlToText, but over
 *  Docling elements (with captions already paired in the sidecar). */
function extractFromElements(
  body: Element[],
  clauseId: string,
): { tables: ExtractedTable[]; figures: ExtractedFigure[]; text: string } {
  const tables: ExtractedTable[] = [];
  const figures: ExtractedFigure[] = [];
  const seenFig = new Set<string>();   // dedup figure ids within this clause
  let tIdx = 0;

  for (const el of body) {
    if (el.kind === "table") {
      const rows = (el.rows ?? []).map(r => r.map(c => (c ?? "").replace(/\s+/g, " ").trim()));
      if (rows.length === 0) continue;           // empty/degenerate table
      tIdx++;
      let captionId = `Table-${tIdx}`;
      let captionText = "";
      if (el.caption) {
        const cm = el.caption.match(TABLE_CAPTION_RE);
        if (cm) { captionId = `Table-${cm[1]}`; captionText = cm[2].trim(); }
      }
      tables.push({ id: `${clauseId}/${captionId}`, caption: captionText, rows });
    } else if (el.kind === "figure" && el.caption) {
      // A captioned image. Emit a figure record keyed by the figure number.
      const fm = el.caption.match(FIGURE_CAPTION_RE);
      if (fm) {
        const id = `${clauseId}/Figure-${fm[1]}`;
        if (!seenFig.has(id)) {
          seenFig.add(id);
          figures.push({ id, caption: fm[2].trim(), mediaFilename: el.mediaFilename || undefined });
        }
      }
    } else if (el.kind === "text" && !el._claimed) {
      // A "Figure N:" caption paragraph with NO paired image (genuinely
      // image-less figure). STRICT colon match so cross-reference prose
      // ("Figure N shows…") doesn't emit a spurious record; dedup so it
      // can't duplicate a captioned image already emitted above.
      const fm = (el.text ?? "").match(FIGURE_CAPTION_STRICT);
      if (fm) {
        const id = `${clauseId}/Figure-${fm[1]}`;
        if (!seenFig.has(id)) {
          seenFig.add(id);
          figures.push({ id, caption: fm[2].trim() });
        }
      }
    }
  }

  return { tables, figures, text: buildBodyText(body) };
}

// ── Heading-block splitter (element-stream version of splitOnHeadings) ──

interface HeadingBlock {
  level: number;
  clauseNo: string;
  title: string;
  body: Element[];
}

/** Split the element stream into clause blocks. Each block runs from a
 *  numbered heading to the NEXT heading element (numbered or not) — exactly
 *  matching v2's splitOnHeadings, which bounded each body at the next <hN>
 *  regardless of whether that heading parsed as a clause. */
function splitOnHeadings(elements: Element[]): HeadingBlock[] {
  const headingIdx: number[] = [];
  elements.forEach((el, i) => { if (el.kind === "heading") headingIdx.push(i); });
  const blocks: HeadingBlock[] = [];
  for (let k = 0; k < headingIdx.length; k++) {
    const hi = headingIdx[k];
    const parsed = parseHeading(elements[hi].text ?? "");
    if (!parsed) continue;
    const bodyStart = hi + 1;
    const bodyEnd = k + 1 < headingIdx.length ? headingIdx[k + 1] : elements.length;
    blocks.push({
      level: elements[hi].level ?? 1,
      clauseNo: parsed.clauseNo,
      title: parsed.title,
      body: elements.slice(bodyStart, bodyEnd),
    });
  }
  return blocks;
}

// ── Path / leaf builder (UNCHANGED from v2) ─────────────────────────

/** Compute ancestor title chain (excluding self) for a clauseNo by walking
 *  the dotted-prefix hierarchy. Returns "" if the clause is top-level. */
function buildPath(clauseNo: string, titleByClauseNo: Map<string, string>): string {
  const parts = clauseNo.split(".");
  const ancestors: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join(".");
    const t = titleByClauseNo.get(prefix);
    if (t) ancestors.push(t);
  }
  return ancestors.join(" / ");
}

function buildLeafClauses(
  spec: FetchedSpec,
  blocks: HeadingBlock[],
): { rows: ClauseRow[]; warnings: string[] } {
  const warnings: string[] = [];
  const titleByClauseNo = new Map<string, string>();
  for (const b of blocks) titleByClauseNo.set(b.clauseNo, b.title);

  const rows: ClauseRow[] = [];

  const emittedIds = new Set<string>();
  let duplicateSkips = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const prefix = b.clauseNo + ".";
    let isLeaf = true;
    for (let j = i + 1; j < blocks.length; j++) {
      const nxt = blocks[j];
      if (nxt.clauseNo.startsWith(prefix)) { isLeaf = false; break; }
      if (!nxt.clauseNo.startsWith(b.clauseNo + ".")) break;
    }
    if (!isLeaf) continue;

    let parentNo: string | null = null;
    if (b.clauseNo.includes(".")) {
      parentNo = b.clauseNo.slice(0, b.clauseNo.lastIndexOf("."));
    }
    const parentTitle = parentNo ? (titleByClauseNo.get(parentNo) ?? null) : null;

    const clauseId = `${spec.spec}#${b.clauseNo}`;
    // First-wins dedup. Multi-part DOCXes occasionally re-use the same
    // clauseNo across parts; keep the first occurrence and warn on the rest.
    if (emittedIds.has(clauseId)) {
      duplicateSkips++;
      continue;
    }
    emittedIds.add(clauseId);

    const { tables, figures, text } = extractFromElements(b.body, clauseId);
    if (text.length < 30) {
      warnings.push(`${b.clauseNo} ${b.title.slice(0, 40)}: only ${text.length} chars`);
    }

    rows.push({
      id: clauseId,
      spec: `TS ${spec.spec}`,
      release: spec.release,
      version: spec.version,
      clauseNo: b.clauseNo,
      title: b.title,
      parentId: parentNo ? `${spec.spec}#${parentNo}` : null,
      parentTitle,
      path: buildPath(b.clauseNo, titleByClauseNo),
      text,
      tables,
      figures,
      mentions: [],
      citation: `3GPP TS ${spec.spec} §${b.clauseNo}`,
    });
  }
  if (duplicateSkips > 0) {
    warnings.push(`skipped ${duplicateSkips} duplicate clauseNo occurrence(s)`);
  }

  // Drop pre-"1 Scope" front-matter rows.
  const oneScopeIdx = rows.findIndex(r => r.clauseNo === "1");
  if (oneScopeIdx > 0) {
    warnings.push(`dropped ${oneScopeIdx} pre-Scope row(s)`);
  }
  const finalRows = oneScopeIdx >= 0 ? rows.slice(oneScopeIdx) : rows;

  return { rows: finalRows, warnings };
}

// ── Docling sidecar invocation ──────────────────────────────────────

/** Run parse_sidecar.py on one DOCX part. Resolves to its element stream.
 *  The sidecar writes any figure images into `mediaDir` (named
 *  `<prefix>-image-N.png`) and prints the JSON element stream to stdout; a
 *  one-line summary goes to stderr (surfaced as a log). */
const SIDECAR_TIMEOUT_MS = Number(process.env.SIDECAR_TIMEOUT_MS) || 1_200_000; // 20 min/part

function runSidecar(docxPath: string, mediaDir: string, prefix: string): Promise<Element[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [SIDECAR, docxPath, mediaDir, prefix], {
      env: { ...process.env, SIDECAR_SUMMARY: "1", DOCLING_CACHE_DIR },
    });
    let out = "";
    let err = "";
    // Bound each part so one pathological DOCX can't stall the whole rebuild —
    // on timeout, kill the child and reject (parseSpec catches → spec warned + skipped).
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`sidecar timed out after ${SIDECAR_TIMEOUT_MS}ms on ${path.basename(docxPath)}`));
    }, SIDECAR_TIMEOUT_MS);
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", d => { out += d; });
    proc.stderr.on("data", d => { err += d; });
    proc.on("error", e => { clearTimeout(timer); reject(e); });
    proc.on("close", code => {
      clearTimeout(timer);
      const summary = err.split("\n").find(l => l.includes("[sidecar]"));
      if (summary) log(`  ${path.basename(docxPath)}: ${summary.replace("[sidecar] ", "")}`);
      if (code !== 0) {
        return reject(new Error(`sidecar exited ${code} on ${path.basename(docxPath)}: ${err.slice(-500)}`));
      }
      try {
        resolve(JSON.parse(out) as Element[]);
      } catch (e) {
        reject(new Error(`sidecar JSON parse failed for ${path.basename(docxPath)}: ${(e as Error).message}; stderr: ${err.slice(-300)}`));
      }
    });
  });
}

async function parseSpec(spec: FetchedSpec): Promise<{ rows: ClauseRow[]; warnings: string[] }> {
  if (!spec.parts || spec.parts.length === 0) {
    return { rows: [], warnings: ["no parts listed in manifest"] };
  }
  log(`parsing ${spec.spec} (${spec.parts.length} part${spec.parts.length > 1 ? "s" : ""})`);

  // Figure images land under dist/media/<spec>/. Wipe stale files first —
  // the sidecar's per-part image counter restarts each run, so leftovers
  // from a previous build would become orphans 03-index.ts might pick up.
  const specMediaDir = path.join(MEDIA_DIR, spec.spec);
  await fs.mkdir(specMediaDir, { recursive: true });
  for (const existing of await fs.readdir(specMediaDir)) {
    await fs.unlink(path.join(specMediaDir, existing)).catch(() => {});
  }

  // Convert each part via the Docling sidecar; concatenate the element
  // streams in manifest (clause) order. Per-part media prefix keeps image
  // filenames unique across parts.
  const elements: Element[] = [];
  const sidecarWarnings: string[] = [];
  for (let i = 0; i < spec.parts.length; i++) {
    const partPath = path.join(RAW_DIR, spec.parts[i]);
    try {
      const els = await runSidecar(partPath, specMediaDir, `${spec.spec}-p${i}`);
      elements.push(...els);
    } catch (e) {
      sidecarWarnings.push((e as Error).message.slice(0, 200));
    }
  }

  const blocks = splitOnHeadings(elements);
  if (blocks.length === 0) {
    return {
      rows: [],
      warnings: [`no numbered headings parsed (parts=${spec.parts.length})`, ...sidecarWarnings],
    };
  }
  const { rows, warnings } = buildLeafClauses(spec, blocks);

  // ── Drop unreferenced media ──────────────────────────────────────
  // Docling extracts EVERY embedded image, including uncaptioned inline
  // diagrams / decorative bits. Only images paired with a "Figure N:"
  // caption (i.e. that ended up in some clause's figures[].mediaFilename)
  // are real figures worth shipping; unlink the rest.
  const referenced = new Set<string>();
  for (const r of rows) {
    for (const fig of r.figures) {
      if (fig.mediaFilename) referenced.add(fig.mediaFilename);
    }
  }
  const beforeFiles = await fs.readdir(specMediaDir);
  let unrefDeleted = 0;
  for (const f of beforeFiles) {
    if (!referenced.has(f)) {
      await fs.unlink(path.join(specMediaDir, f)).catch(() => {});
      unrefDeleted++;
    }
  }
  if (unrefDeleted > 0) {
    log(
      `  ${spec.spec}: kept ${referenced.size} caption-paired figure(s), ` +
      `dropped ${unrefDeleted} unreferenced image(s)`,
    );
  }

  return { rows, warnings: [...warnings, ...sidecarWarnings] };
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function main() {
  const manifestRaw = await fs.readFile(FETCH_MANIFEST, "utf8");
  const manifest = JSON.parse(manifestRaw) as { specs: FetchedSpec[] };
  const specs = manifest.specs.filter(s => s.parts && s.parts.length > 0);
  if (specs.length === 0) {
    console.error("[parse] no parsed-able specs — did you run `npm run fetch` (non-dry)?");
    process.exit(1);
  }
  // Honour a SPEC_FILTER env (comma-separated spec ids) for fast iteration /
  // validation on a subset without re-parsing all ~35 specs.
  const filter = (process.env.SPEC_FILTER || "").split(",").map(s => s.trim()).filter(Boolean);
  const selected = filter.length ? specs.filter(s => filter.includes(s.spec)) : specs;
  log(`parsing ${selected.length} spec(s)${filter.length ? ` (filtered: ${filter.join(", ")})` : ""}`);
  log(`using docling sidecar via ${PYTHON}`);
  await fs.mkdir(DIST_DIR, { recursive: true });
  // Per-spec checkpoint cache → RESUMABLE parse. Each spec's parsed rows are
  // persisted to dist/parse-cache/<spec>.json the moment it finishes, and
  // reused on re-run — so a long build can be stopped (Ctrl-C / shutdown) and
  // restarted, skipping already-parsed specs. Force a fresh parse of a spec by
  // deleting its cache file, or all with PARSE_FORCE=1.
  const CKPT_DIR = path.join(DIST_DIR, "parse-cache");
  await fs.mkdir(CKPT_DIR, { recursive: true });
  if (DOCLING_CACHE_DIR) await fs.mkdir(DOCLING_CACHE_DIR, { recursive: true });
  const force = process.env.PARSE_FORCE === "1";

  const allRows: ClauseRow[] = [];
  const report: ParseReport = {
    builtAt: new Date().toISOString(),
    release: "Rel-17",
    specs: [],
    totalClauses: 0,
    totalTables: 0,
    totalFigures: 0,
  };

  for (const spec of selected) {
    const ckptPath = path.join(CKPT_DIR, `${spec.spec}.json`);
    try {
      let rows: ClauseRow[];
      let warnings: string[];
      let cached = false;
      if (!force && await fileExists(ckptPath)) {
        const c = JSON.parse(await fs.readFile(ckptPath, "utf8")) as { rows: ClauseRow[]; warnings: string[] };
        rows = c.rows; warnings = c.warnings ?? []; cached = true;
      } else {
        ({ rows, warnings } = await parseSpec(spec));
        // Persist immediately so this spec survives a stop/restart.
        await fs.writeFile(ckptPath, JSON.stringify({ rows, warnings }));
      }
      allRows.push(...rows);
      const tableCount = rows.reduce((a, r) => a + r.tables.length, 0);
      const figureCount = rows.reduce((a, r) => a + r.figures.length, 0);
      report.specs.push({
        spec: spec.spec,
        version: spec.version,
        clauseCount: rows.length,
        tableCount,
        figureCount,
        warnings,
      });
      report.totalTables += tableCount;
      report.totalFigures += figureCount;
      log(`  ${spec.spec}: ${rows.length} clause(s), ${tableCount} table(s), ${figureCount} figure(s)${cached ? "  (cached ↺)" : ""}`);
      if (warnings.length > 0) {
        warn(`  ${spec.spec}: ${warnings.length} warning(s)`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`  ${spec.spec}: ${msg}`);
      report.specs.push({
        spec: spec.spec,
        version: spec.version,
        clauseCount: 0,
        tableCount: 0,
        figureCount: 0,
        warnings: [`parse failed: ${msg}`],
      });
    }
  }

  report.totalClauses = allRows.length;

  // When parsing a filtered subset, MERGE into the existing outputs rather
  // than clobbering the full corpus (so a subset validation run doesn't wipe
  // the other specs' clauses). Full runs overwrite.
  let merged = allRows;
  if (filter.length) {
    try {
      const prev = JSON.parse(await fs.readFile(OUT_CLAUSES_JSON, "utf8")) as ClauseRow[];
      const keptSpecs = new Set(selected.map(s => `TS ${s.spec}`));
      merged = [...prev.filter(r => !keptSpecs.has(r.spec)), ...allRows];
    } catch { /* no previous output — write just the subset */ }
  }

  const jsonlBody = merged.map(r => JSON.stringify(r)).join("\n") + "\n";
  await fs.writeFile(OUT_CLAUSES_JSONL, jsonlBody);
  await fs.writeFile(OUT_CLAUSES_JSON, JSON.stringify(merged));
  await fs.writeFile(OUT_REPORT, JSON.stringify(report, null, 2));

  log("");
  log(`✓ parsed ${allRows.length} leaf clause(s) from ${selected.length} spec(s)`);
  log(`  ${report.totalTables} table(s), ${report.totalFigures} figure ref(s)`);
  log(`wrote ${OUT_CLAUSES_JSONL} (${(jsonlBody.length / 1024 / 1024).toFixed(1)} MB total)`);
  log(`wrote ${OUT_CLAUSES_JSON}`);
  log(`wrote ${OUT_REPORT}`);
}

await main();
