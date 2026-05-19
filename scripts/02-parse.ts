// ─────────────────────────────────────────────────────────────────
// 02-parse.ts — convert each downloaded .docx into a JSON array of
// leaf-clause records.
//
// v2 changes (SPEC.md §14 ADR-004 / ADR-007):
//   • mammoth styleMap maps 3GPP-internal paragraph styles
//     (ZA/ZB/TT/TAR/TF/ZT) to <h2>/<h3>/<h4>, recovering hundreds of
//     test-case headings in test specs that v1 missed.
//   • Each leaf clause carries structured tables[] and figures[]
//     arrays alongside the flat text. Tables are flattened too,
//     but only as a fallback for FTS coverage.
//   • Each leaf carries a `path` string (ancestor title chain) so
//     03-index.ts can index hierarchy into FTS5.
//   • Output written as JSONL (canonical) plus JSON (legacy).
//
// Strategy (unchanged from v1):
//   1. mammoth.convertToHtml() → HTML with <h1>..<h6> headings.
//   2. Walk the HTML in order. Each heading whose text matches the
//      3GPP numbered-clause pattern (e.g. "6.1.4 PUCCH format 0")
//      opens a clause; subsequent paragraphs / tables / lists belong
//      to that clause until the next numbered heading appears.
//   3. A clause is "leaf" if no deeper-numbered heading appears
//      immediately under it. We track this via depth comparison
//      on the numeric prefix.
//   4. Output rows shape:
//        { id, spec, release, version, clauseNo, title, parentId,
//          parentTitle, path, text, tables, figures, mentions,
//          citation }
//
// Output:
//   dist/clauses.jsonl  — canonical, one record per line (ADR-006)
//   dist/clauses.json   — legacy array (read by 03-index.ts v2 path)
//   dist/parse-report.json — per-spec counts + warning list
// ─────────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(REPO_ROOT, "raw");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const FETCH_MANIFEST = path.join(RAW_DIR, "fetch-manifest.json");
const OUT_CLAUSES_JSON = path.join(DIST_DIR, "clauses.json");
const OUT_CLAUSES_JSONL = path.join(DIST_DIR, "clauses.jsonl");
const OUT_REPORT = path.join(DIST_DIR, "parse-report.json");

const log = (...args: unknown[]) => console.log("[parse]", ...args);
const warn = (...args: unknown[]) => console.warn("[parse] ⚠", ...args);

// ── mammoth styleMap ─────────────────────────────────────────────
// Pass mammoth's mini-language style map. 3GPP test specs (38.508-1,
// 38.521-*, 36.508, 36.521-*, 36.523-1) use these internal styles
// for test-case titles; without the mapping mammoth emits them as
// plain <p> and our heading walker skips them entirely.
//
// The exact style codes are an educated guess based on the v1
// README. The build will warn (via parse-report) if a spec yields
// zero clauses; that's the signal to inspect a sample DOCX and
// add the missing style codes here.
const STYLE_MAP = [
  // Standard Word headings (mammoth maps these by default but we
  // declare them explicitly so adding test-spec styles doesn't
  // accidentally drop them).
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='Heading 4'] => h4:fresh",
  "p[style-name='Heading 5'] => h5:fresh",
  "p[style-name='Heading 6'] => h6:fresh",
  "p[style-name='Heading 7'] => h6:fresh",
  "p[style-name='Heading 8'] => h6:fresh",
  "p[style-name='Heading 9'] => h6:fresh",
  // 3GPP-internal test-spec headings (best-effort).
  "p[style-name='ZA'] => h2:fresh",
  "p[style-name='ZB'] => h3:fresh",
  "p[style-name='ZC'] => h4:fresh",
  "p[style-name='ZT'] => h3:fresh",
  "p[style-name='TT'] => h3:fresh",   // test title
  "p[style-name='TAR'] => h4:fresh",  // test-applicability-rule
  "p[style-name='TF'] => h4:fresh",   // test-feature
  "p[style-name='TS'] => h4:fresh",   // test-step
].join("\n");

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

interface ExtractedTable {
  id: string;          // "38.211#6.3.3.1/Table-1" (assigned at row build)
  caption: string;     // empty if no caption found
  rows: string[][];    // header row first if detectable, else as-emitted
}

interface ExtractedFigure {
  id: string;
  caption: string;
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
  /** Reserved slot for entity extraction (v3). Always [] in v2 (ADR-005). */
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

// ── Heading detection ────────────────────────────────────────────

function parseHeading(rawText: string): { clauseNo: string; title: string } | null {
  const text = rawText.trim();
  if (!text) return null;
  const m = text.match(/^([A-Z]?\d+(?:\.\d+)*|[A-Z](?:\.\d+)+)\s+(.+?)\s*$/);
  if (!m) return null;
  const clauseNo = m[1];
  const title = m[2].replace(/\s+/g, " ").trim();
  if (/\.\.\.\s*\d+\s*$/.test(text)) return null;     // ToC line
  if (title.length > 200) return null;                // not a real heading
  return { clauseNo, title };
}

// ── HTML → text helpers ─────────────────────────────────────────

function htmlToText(html: string): string {
  let s = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "  - ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<td[^>]*>/gi, " | ")
    .replace(/<th[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  s = s.replace(/&amp;/g, "&")
       .replace(/&lt;/g, "<")
       .replace(/&gt;/g, ">")
       .replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'")
       .replace(/&nbsp;/g, " ");
  s = s.replace(/\b(PAGEREF|STYLEREF|HYPERLINK|MERGEFORMAT|Toc\d+)\b[^\n]*/g, "");
  s = s.split("\n").map(l => l.replace(/\s+/g, " ").trim()).join("\n");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

/** Strip tags from a small fragment (table cell, caption candidate). */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Table extraction ────────────────────────────────────────────

const TABLE_CAPTION_RE = /^Table\s+([\dA-Z][\d.A-Z-]*):?\s*(.+?)$/m;
const FIGURE_CAPTION_RE = /^Figure\s+([\dA-Z][\d.A-Z-]*):?\s*(.+?)$/m;

interface ExtractedHtml {
  tables: ExtractedTable[];
  figures: ExtractedFigure[];
}

/** Walk a clause body, pulling out structured tables (with their preceding
 *  caption when present) and figure references. Captions live in the
 *  paragraph immediately *preceding* the <table> in 3GPP convention. */
function extractTablesAndFigures(
  bodyHtml: string,
  clauseId: string,
): ExtractedHtml {
  const tables: ExtractedTable[] = [];
  const figures: ExtractedFigure[] = [];

  // ── Tables ──
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(bodyHtml)) !== null) {
    tIdx++;
    const tableInner = m[1];
    // Caption: scan backward from the table for a <p> that looks like
    // "Table N: caption". Cap the look-back to 800 chars (≈ 2 paragraphs).
    const lookBackStart = Math.max(0, m.index - 800);
    const before = bodyHtml.slice(lookBackStart, m.index);
    const preceding = Array.from(before.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi));
    let captionId = `Table-${tIdx}`;
    let captionText = "";
    if (preceding.length > 0) {
      const cand = stripTags(preceding[preceding.length - 1][1]);
      const cm = cand.match(TABLE_CAPTION_RE);
      if (cm) {
        captionId = `Table-${cm[1]}`;
        captionText = cm[2].trim();
      }
    }
    // Rows: each <tr>...</tr>, cells are <th>/<td>.
    const rows: string[][] = [];
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr: RegExpExecArray | null;
    while ((tr = trRe.exec(tableInner)) !== null) {
      const cellRe = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
      const cells: string[] = [];
      let cm2: RegExpExecArray | null;
      while ((cm2 = cellRe.exec(tr[1])) !== null) {
        cells.push(stripTags(cm2[1]));
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length === 0) continue;   // empty/degenerate table
    tables.push({
      id: `${clauseId}/${captionId}`,
      caption: captionText,
      rows,
    });
  }

  // ── Figures ──
  // Figure captions live as plain paragraphs; the image may or may
  // not be present in the DOCX. We capture the caption either way.
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let p: RegExpExecArray | null;
  while ((p = pRe.exec(bodyHtml)) !== null) {
    const t = stripTags(p[1]);
    const fm = t.match(FIGURE_CAPTION_RE);
    if (fm) {
      figures.push({
        id: `${clauseId}/Figure-${fm[1]}`,
        caption: fm[2].trim(),
      });
    }
  }

  return { tables, figures };
}

// ── Heading-block splitter (unchanged from v1) ──────────────────

interface HeadingBlock {
  level: number;
  clauseNo: string;
  title: string;
  bodyHtml: string;
}

function splitOnHeadings(html: string): HeadingBlock[] {
  const blocks: HeadingBlock[] = [];
  const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const matches: Array<{ level: number; text: string; start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const innerText = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    matches.push({ level: Number(m[1]), text: innerText, start: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < matches.length; i++) {
    const hdr = matches[i];
    const parsed = parseHeading(hdr.text);
    if (!parsed) continue;
    const bodyStart = hdr.end;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].start : html.length;
    blocks.push({
      level: hdr.level,
      clauseNo: parsed.clauseNo,
      title: parsed.title,
      bodyHtml: html.slice(bodyStart, bodyEnd),
    });
  }
  return blocks;
}

// ── Path / leaf builder ─────────────────────────────────────────

/** Compute ancestor title chain (excluding self) for a clauseNo by
 *  walking the dotted-prefix hierarchy. Returns "" if the clause is
 *  top-level. */
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
    const { tables, figures } = extractTablesAndFigures(b.bodyHtml, clauseId);
    const text = htmlToText(b.bodyHtml);
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

  // Drop pre-"1 Scope" front-matter rows.
  const oneScopeIdx = rows.findIndex(r => r.clauseNo === "1");
  if (oneScopeIdx > 0) {
    warnings.push(`dropped ${oneScopeIdx} pre-Scope row(s)`);
  }
  const finalRows = oneScopeIdx >= 0 ? rows.slice(oneScopeIdx) : rows;

  return { rows: finalRows, warnings };
}

async function parseSpec(spec: FetchedSpec): Promise<{ rows: ClauseRow[]; warnings: string[] }> {
  if (!spec.parts || spec.parts.length === 0) {
    return { rows: [], warnings: ["no parts listed in manifest"] };
  }
  log(`parsing ${spec.spec} (${spec.parts.length} part${spec.parts.length > 1 ? "s" : ""})`);

  let combinedHtml = "";
  const conversionWarnings: string[] = [];
  for (const partName of spec.parts) {
    const partPath = path.join(RAW_DIR, partName);
    const { value: html, messages } = await mammoth.convertToHtml(
      { path: partPath },
      { styleMap: STYLE_MAP },
    );
    combinedHtml += html + "\n";
    for (const m of messages) {
      if (m.type === "warning" && conversionWarnings.length < 5) {
        conversionWarnings.push(`${partName}: ${m.message}`);
      }
    }
  }

  const blocks = splitOnHeadings(combinedHtml);
  if (blocks.length === 0) {
    return {
      rows: [],
      warnings: [`no numbered headings parsed (parts=${spec.parts.length})`, ...conversionWarnings],
    };
  }
  const { rows, warnings } = buildLeafClauses(spec, blocks);
  return { rows, warnings: [...warnings, ...conversionWarnings] };
}

async function main() {
  const manifestRaw = await fs.readFile(FETCH_MANIFEST, "utf8");
  const manifest = JSON.parse(manifestRaw) as { specs: FetchedSpec[] };
  const specs = manifest.specs.filter(s => s.parts && s.parts.length > 0);
  if (specs.length === 0) {
    console.error("[parse] no parsed-able specs — did you run `npm run fetch` (non-dry)?");
    process.exit(1);
  }
  log(`parsing ${specs.length} spec(s)`);
  await fs.mkdir(DIST_DIR, { recursive: true });

  const allRows: ClauseRow[] = [];
  const report: ParseReport = {
    builtAt: new Date().toISOString(),
    release: "Rel-17",
    specs: [],
    totalClauses: 0,
    totalTables: 0,
    totalFigures: 0,
  };

  for (const spec of specs) {
    try {
      const { rows, warnings } = await parseSpec(spec);
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
      log(`  ${spec.spec}: ${rows.length} clause(s), ${tableCount} table(s), ${figureCount} figure(s)`);
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

  // Canonical JSONL (v2) and legacy JSON (v1, kept until consumers migrate).
  const jsonlBody = allRows.map(r => JSON.stringify(r)).join("\n") + "\n";
  await fs.writeFile(OUT_CLAUSES_JSONL, jsonlBody);
  await fs.writeFile(OUT_CLAUSES_JSON, JSON.stringify(allRows));
  await fs.writeFile(OUT_REPORT, JSON.stringify(report, null, 2));

  log("");
  log(`✓ parsed ${allRows.length} leaf clause(s) from ${specs.length} spec(s)`);
  log(`  ${report.totalTables} table(s), ${report.totalFigures} figure ref(s)`);
  log(`wrote ${OUT_CLAUSES_JSONL} (${(jsonlBody.length / 1024 / 1024).toFixed(1)} MB)`);
  log(`wrote ${OUT_CLAUSES_JSON}`);
  log(`wrote ${OUT_REPORT}`);
}

await main();
