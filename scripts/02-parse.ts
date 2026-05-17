// ─────────────────────────────────────────────────────────────────
// 02-parse.ts — convert each downloaded .docx into a JSON array of
// leaf-clause records.
//
// Strategy:
//   1. mammoth.convertToHtml() → HTML with <h1>..<h6> headings.
//   2. Walk the HTML in order. Each heading whose text matches the
//      3GPP numbered-clause pattern (e.g. "6.1.4 PUCCH format 0")
//      opens a clause; subsequent paragraphs / tables / lists belong
//      to that clause until the next numbered heading appears.
//   3. A clause is "leaf" if no deeper-numbered heading appears
//      immediately under it before peer/parent restoration. We track
//      this via depth comparison on the numeric prefix.
//   4. Output rows shape:
//        { id, spec, release, version, clauseNo, title, parentId,
//          parentTitle, text, citation }
//
// Things we strip:
//   - 3GPP front-matter: foreword, contents, scope-of-document boilerplate
//     before clause "1 Scope".
//   - Annex change-history at the back ("Annex Z" or similar).
//   - Field-code artifacts mammoth occasionally surfaces ("PAGEREF",
//     "STYLEREF", "Toc1234567").
//   - Bare table-of-contents lines (text == clause-number followed by
//     leader dots and a page number).
//
// Things we keep:
//   - All running text, lists, tables (tables flattened to "row | row").
//   - The hierarchical structure via parent_id linking.
//
// Output:
//   dist/clauses.json — array of all leaf clauses across all specs
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
const OUT_CLAUSES = path.join(DIST_DIR, "clauses.json");
const OUT_REPORT = path.join(DIST_DIR, "parse-report.json");

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
  docxFilename: string;
  bytes: number;
}

interface ClauseRow {
  id: string;            // "38.211#6.1.4"
  spec: string;          // "TS 38.211"
  release: string;       // "Rel-17"
  version: string;       // "17.10.0"
  clauseNo: string;      // "6.1.4"
  title: string;
  parentId: string | null;
  parentTitle: string | null;
  text: string;
  citation: string;      // "3GPP TS 38.211 §6.1.4"
}

interface ParseReport {
  builtAt: string;
  release: string;
  specs: Array<{ spec: string; version: string; clauseCount: number; warnings: string[] }>;
  totalClauses: number;
}

// A heading text like "6.1.4 PUCCH format 0" → clauseNo + title.
// Also matches "6.1.4.1 …", "A.2 …" (annex), and "6 Physical layer".
// Returns null when the line doesn't look like a numbered 3GPP heading.
function parseHeading(rawText: string): { clauseNo: string; title: string } | null {
  const text = rawText.trim();
  if (!text) return null;
  // Numeric (e.g. "6.1.4 Title"): purely digits + dots, optionally trailing
  // digit. Annex headings ("A.2 Title") use a single uppercase letter root.
  // Single-token clause numbers like "6" or "A" are allowed too.
  const m = text.match(/^([A-Z]?\d+(?:\.\d+)*|[A-Z](?:\.\d+)+)\s+(.+?)\s*$/);
  if (!m) return null;
  const clauseNo = m[1];
  const title = m[2].replace(/\s+/g, " ").trim();
  // Reject obvious false positives: lines ending in page numbers (ToC),
  // overly long "titles" (probably an unbroken paragraph).
  if (/\.\.\.\s*\d+\s*$/.test(text)) return null;
  if (title.length > 200) return null;
  return { clauseNo, title };
}

// Depth of a clause number = count of dot-separated segments. "6" → 1,
// "6.1.4" → 3, "A.2.1" → 3 (the leading letter counts as one segment).
function depthOf(clauseNo: string): number {
  return clauseNo.split(".").length;
}

// Plain-text extraction from an HTML fragment. Preserves paragraph
// breaks as \n\n, list bullets as "  - …", table rows as
// "row | row | …\n". Strips field-code remnants.
function htmlToText(html: string): string {
  // Replace block-level breaks with newlines BEFORE stripping tags so
  // we preserve paragraph structure.
  let s = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "  - ")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<td[^>]*>/gi, " | ")
    .replace(/<th[^>]*>/gi, " | ")
    // Strip remaining tags.
    .replace(/<[^>]+>/g, "");
  // Decode common HTML entities mammoth tends to emit.
  s = s.replace(/&amp;/g, "&")
       .replace(/&lt;/g, "<")
       .replace(/&gt;/g, ">")
       .replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'")
       .replace(/&nbsp;/g, " ");
  // Drop Word field-code artifacts.
  s = s.replace(/\b(PAGEREF|STYLEREF|HYPERLINK|MERGEFORMAT|Toc\d+)\b[^\n]*/g, "");
  // Normalize whitespace per line + collapse 3+ blank lines.
  s = s.split("\n").map(l => l.replace(/\s+/g, " ").trim()).join("\n");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

interface HeadingBlock {
  level: number;          // 1..6 from <hN>
  clauseNo: string;
  title: string;
  bodyHtml: string;       // HTML between this heading and the next heading
}

// Split the entire HTML document into ordered heading-blocks.
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

// Group blocks into a hierarchy and emit only LEAF clauses (clauses with
// no deeper descendants in the document order at our level). We use
// clauseNo depth to determine parent/child rather than HTML <hN> level,
// because 3GPP docs are inconsistent about heading levels but the
// numbering is strict.
function buildLeafClauses(
  spec: FetchedSpec,
  blocks: HeadingBlock[],
): { rows: ClauseRow[]; warnings: string[] } {
  const warnings: string[] = [];

  // Track the parent chain by clauseNo depth. parentByDepth[d] = the
  // clauseNo most recently seen at depth d. When a new clause arrives
  // at depth D, its parent is parentByDepth[D-1].
  const titleByClauseNo = new Map<string, string>();
  const rows: ClauseRow[] = [];

  // First pass: record every clause's title for parent-title lookup.
  for (const b of blocks) titleByClauseNo.set(b.clauseNo, b.title);

  // Second pass: emit one row per *leaf* clause. A clause is leaf if no
  // SUBSEQUENT block in the document has a clauseNo strictly extending
  // ours (i.e. starts with `${cn}.`). For specs that are dense at the
  // leaf level (e.g. 38.211 §6.1.4.1), this gives us small focused chunks.
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const prefix = b.clauseNo + ".";
    let isLeaf = true;
    // Walk forward looking for a descendant before another peer/ancestor.
    // For "6.1.4", a descendant is "6.1.4.1"; a peer "6.1.5" closes us.
    for (let j = i + 1; j < blocks.length; j++) {
      const nxt = blocks[j];
      if (nxt.clauseNo.startsWith(prefix)) { isLeaf = false; break; }
      // If we hit a clause that doesn't extend us, we're done looking.
      if (!nxt.clauseNo.startsWith(b.clauseNo + ".")) break;
    }
    if (!isLeaf) continue;

    // Build the parent reference. Strip the trailing segment of clauseNo.
    let parentNo: string | null = null;
    if (b.clauseNo.includes(".")) {
      parentNo = b.clauseNo.slice(0, b.clauseNo.lastIndexOf("."));
    }
    const parentTitle = parentNo ? (titleByClauseNo.get(parentNo) ?? null) : null;

    const text = htmlToText(b.bodyHtml);
    if (text.length < 30) {
      // Too short — likely a stub like "Void." Keep it but warn so we
      // can identify if a real clause is being mis-parsed.
      warnings.push(`${b.clauseNo} ${b.title.slice(0, 40)}: only ${text.length} chars`);
    }

    rows.push({
      id: `${spec.spec}#${b.clauseNo}`,
      spec: `TS ${spec.spec}`,
      release: spec.release,
      version: spec.version,
      clauseNo: b.clauseNo,
      title: b.title,
      parentId: parentNo ? `${spec.spec}#${parentNo}` : null,
      parentTitle,
      text,
      citation: `3GPP TS ${spec.spec} §${b.clauseNo}`,
    });
  }

  // Drop pre-"1 Scope" front-matter rows. 3GPP specs always have clause 1
  // as the Scope; everything numbered before that is foreword/contents.
  // Annex sections (A.*, B.*, …) come after the body and are valid.
  const oneScopeIdx = rows.findIndex(r => r.clauseNo === "1");
  if (oneScopeIdx > 0) {
    warnings.push(`dropped ${oneScopeIdx} pre-Scope row(s)`);
  }
  const finalRows = oneScopeIdx >= 0 ? rows.slice(oneScopeIdx) : rows;

  return { rows: finalRows, warnings };
}

async function parseSpec(spec: FetchedSpec): Promise<{ rows: ClauseRow[]; warnings: string[] }> {
  const docxPath = path.join(RAW_DIR, spec.docxFilename);
  log(`parsing ${spec.spec} (${spec.docxFilename})`);
  const { value: html, messages } = await mammoth.convertToHtml({ path: docxPath });
  const conversionWarnings = messages
    .filter(m => m.type === "warning")
    .map(m => m.message)
    .slice(0, 5); // cap noise

  const blocks = splitOnHeadings(html);
  if (blocks.length === 0) {
    return {
      rows: [],
      warnings: [`no numbered headings parsed from ${spec.docxFilename}`, ...conversionWarnings],
    };
  }
  const { rows, warnings } = buildLeafClauses(spec, blocks);
  return { rows, warnings: [...warnings, ...conversionWarnings] };
}

async function main() {
  const manifestRaw = await fs.readFile(FETCH_MANIFEST, "utf8");
  const manifest = JSON.parse(manifestRaw) as { specs: FetchedSpec[] };
  const specs = manifest.specs.filter(s => s.docxFilename && s.docxFilename.length > 0);
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
  };

  for (const spec of specs) {
    try {
      const { rows, warnings } = await parseSpec(spec);
      allRows.push(...rows);
      report.specs.push({
        spec: spec.spec,
        version: spec.version,
        clauseCount: rows.length,
        warnings,
      });
      log(`  ${spec.spec}: ${rows.length} leaf clause(s)`);
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
        warnings: [`parse failed: ${msg}`],
      });
    }
  }

  report.totalClauses = allRows.length;
  await fs.writeFile(OUT_CLAUSES, JSON.stringify(allRows));
  await fs.writeFile(OUT_REPORT, JSON.stringify(report, null, 2));

  log("");
  log(`✓ parsed ${allRows.length} leaf clause(s) from ${specs.length} spec(s)`);
  log(`wrote ${OUT_CLAUSES} (${(JSON.stringify(allRows).length / 1024 / 1024).toFixed(1)} MB)`);
  log(`wrote ${OUT_REPORT}`);
}

await main();
