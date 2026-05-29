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
import { mimeToExt, convertVectorMedia, sanitizeSvg } from "./media-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(REPO_ROOT, "raw");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const FETCH_MANIFEST = path.join(RAW_DIR, "fetch-manifest.json");
const OUT_CLAUSES_JSON = path.join(DIST_DIR, "clauses.json");
const OUT_CLAUSES_JSONL = path.join(DIST_DIR, "clauses.jsonl");
const OUT_REPORT = path.join(DIST_DIR, "parse-report.json");
// Phase 1: figure images live here under per-spec subdirs:
// `dist/media/<spec>/<mediaId>.{svg,png,jpeg,gif}`. 03-index.ts blob-
// ingests them into the `figure_images` SQLite table.
const MEDIA_DIR = path.join(DIST_DIR, "media");

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
  // 3GPP-internal test-spec headings. Only the four codes documented
  // in the v1 README hypothesis are mapped — speculative additions
  // like 'TS', 'TF' turned out to be table-related styles (Table
  // Subhead / Table Footer) that produce junk like '<h4>788 MHz</h4>'
  // when mapped to a heading level.
  "p[style-name='ZA'] => h2:fresh",
  "p[style-name='ZT'] => h3:fresh",
  "p[style-name='TT'] => h3:fresh",   // test title
  "p[style-name='TAR'] => h4:fresh",  // test-applicability-rule
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
  /** Phase 1 (figures-as-SVG): the media file on disk that renders
   *  this figure. Empty when the figure caption appears in the DOCX
   *  but the actual image lives further away than our look-back/
   *  look-ahead window — common for figures whose caption was
   *  reused as a cross-reference somewhere else in the text. */
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
  // Real 3GPP top-level clauses are 1..9 (Scope, References, …); a pure
  // integer >= 10 is overwhelmingly a frequency band cell, table row
  // number, or other in-table content that mammoth happened to surface
  // as a paragraph. Reject so we don't generate clauses like
  // `38.101-1#788 MHz`.
  if (/^\d+$/.test(clauseNo) && Number(clauseNo) >= 10) return null;
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
  //
  // Phase 1: each `<img data-media-filename="...">` placeholder (emitted
  // by mammoth's convertImage callback in parseSpec) gets paired with
  // the nearest "Figure N:" caption. 3GPP convention: the image
  // paragraph appears IMMEDIATELY BEFORE the caption paragraph
  // ("Figure 5.2.1-1: Resource grid"). Some specs invert this — image
  // after caption — so we accept both within a small look-window.
  // Pairing is one-to-one: each image is consumed by the first
  // caption that matches it, preventing the same SVG from being
  // claimed by two figures.
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let p: RegExpExecArray | null;

  // First pass — collect every paragraph with its byte offset + parsed
  // content so we can do positional pairing in pass two.
  interface ParaInfo {
    start: number;        // byte offset in bodyHtml
    text: string;         // stripped text
    mediaFilenames: string[]; // filenames extracted from `<img data-media-filename="...">`
    captionMatch: RegExpMatchArray | null;
  }
  const paras: ParaInfo[] = [];
  while ((p = pRe.exec(bodyHtml)) !== null) {
    const rawInner = p[1];
    const text = stripTags(rawInner);
    // Pull out every image media filename in this paragraph. Multiple
    // images per paragraph is unusual but possible (e.g. side-by-side
    // diagrams sharing one caption); pairing logic below uses the
    // first one.
    const mediaFilenames: string[] = [];
    const imgRe = /<img\b[^>]*data-media-filename=["']([^"']+)["'][^>]*\/?>/gi;
    let im: RegExpExecArray | null;
    while ((im = imgRe.exec(rawInner)) !== null) {
      mediaFilenames.push(im[1]);
    }
    paras.push({
      start: p.index,
      text,
      mediaFilenames,
      captionMatch: text.match(FIGURE_CAPTION_RE),
    });
  }

  // Second pass — for each captioned paragraph, find the closest
  // image-bearing paragraph within ± 3 paragraphs that hasn't been
  // claimed yet. Bias toward the immediately preceding paragraph
  // (3GPP standard layout), then look ahead.
  const claimed = new Set<string>();
  for (let i = 0; i < paras.length; i++) {
    const para = paras[i];
    if (!para.captionMatch) continue;
    const fm = para.captionMatch;
    let pickedFilename: string | undefined;
    // Search radius — wide enough to catch figures with a blank
    // paragraph or a small note between the image and its caption,
    // tight enough not to claim an unrelated diagram earlier in the
    // clause.
    for (const dist of [1, 2, 3, -1, -2, -3, 0]) {
      const idx = i + dist;
      if (idx < 0 || idx >= paras.length) continue;
      // dist=0 = image and caption in the SAME paragraph, which 3GPP
      // does occasionally with inline equations + a caption suffix.
      const candidate = paras[idx];
      for (const fn of candidate.mediaFilenames) {
        if (!claimed.has(fn)) {
          pickedFilename = fn;
          claimed.add(fn);
          break;
        }
      }
      if (pickedFilename) break;
    }
    figures.push({
      id: `${clauseId}/Figure-${fm[1]}`,
      caption: fm[2].trim(),
      mediaFilename: pickedFilename,
    });
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
    // clauseNo across parts (e.g. a recap heading in an annex, or a
    // boundary section repeated by accident). Keep the first occurrence
    // — usually the canonical definition — and warn on the rest so a
    // future maintainer can investigate without the build crashing on
    // the PK constraint downstream.
    if (emittedIds.has(clauseId)) {
      duplicateSkips++;
      continue;
    }
    emittedIds.add(clauseId);

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

async function parseSpec(spec: FetchedSpec): Promise<{ rows: ClauseRow[]; warnings: string[] }> {
  if (!spec.parts || spec.parts.length === 0) {
    return { rows: [], warnings: ["no parts listed in manifest"] };
  }
  log(`parsing ${spec.spec} (${spec.parts.length} part${spec.parts.length > 1 ? "s" : ""})`);

  // Phase 1: every embedded figure (WMF/EMF/PNG/JPEG) lands here. We
  // pass a `convertImage` callback to mammoth that writes the raw
  // bytes to this dir under a stable `<spec>-image-<counter>.<ext>`
  // filename, then returns a tiny `<img data-media-filename="...">`
  // placeholder in the HTML (no base64 → no HTML bloat). The figure
  // extractor below pairs each placeholder with its nearest
  // "Figure N:" caption.
  const specMediaDir = path.join(MEDIA_DIR, spec.spec);
  await fs.mkdir(specMediaDir, { recursive: true });
  // Wipe any media left behind from a previous build of this spec —
  // counter restarts at 1 each run, so stale files would otherwise
  // become orphans that 03-index.ts might pick up.
  for (const existing of await fs.readdir(specMediaDir)) {
    await fs.unlink(path.join(specMediaDir, existing)).catch(() => {});
  }

  let mediaCounter = 0;
  const captureImage = mammoth.images.imgElement(async (image) => {
    mediaCounter++;
    const ext = mimeToExt(image.contentType || "");
    // Files we don't recognise (.bin) get a placeholder src but no
    // on-disk write — the figure-extractor will treat it as "no
    // media available" and just keep the caption.
    if (ext === "bin") {
      return { src: "", "data-media-filename": "" };
    }
    const filename = `${spec.spec}-image-${mediaCounter}.${ext}`;
    const outPath = path.join(specMediaDir, filename);
    const buffer = await image.read();
    await fs.writeFile(outPath, buffer);
    return {
      // mammoth requires `src` — we give it a stable token that the
      // figure extractor can find via the same `media:` scheme. The
      // browser never sees this HTML so the URL doesn't have to
      // resolve; only the data-* attribute below matters downstream.
      src: `media:${filename}`,
      "data-media-filename": filename,
      alt: filename,
    };
  });

  let combinedHtml = "";
  const conversionWarnings: string[] = [];
  for (const partName of spec.parts) {
    const partPath = path.join(RAW_DIR, partName);
    const { value: html, messages } = await mammoth.convertToHtml(
      { path: partPath },
      { styleMap: STYLE_MAP, convertImage: captureImage },
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

  // ── Drop unreferenced media before conversion ────────────────
  // mammoth's convertImage callback saves EVERY embedded image —
  // including the ~1000 inline math equations that Word renders to
  // WMF (e.g. 38.211 has 627 WMF + 2 EMF, of which only 2 are
  // captioned "Figure N:" diagrams). We don't want to convert,
  // store, or ship those — they're equations, not figures, and the
  // LLM reads them better from the surrounding text anyway.
  //
  // Walk every clause's figures[].mediaFilename to collect the set
  // of "referenced" files, then unlink everything else in the spec's
  // media dir. The conversion step (next) then only processes the
  // small captioned subset.
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
      `  ${spec.spec}: kept ${referenced.size} caption-paired media file(s), ` +
      `dropped ${unrefDeleted} unreferenced (mostly inline equations)`,
    );
  }

  // Batch-convert vector media (WMF/EMF) → SVG via libreoffice. Done
  // once per spec so the JVM startup cost is amortised across the
  // spec's full figure set. PNG/JPEG were already passed through
  // as-is by the convertImage callback above. After the orphan-
  // cleanup above, this only processes the referenced subset.
  const conv = await convertVectorMedia(specMediaDir);
  if (conv.failed > 0) {
    warnings.push(`vector→SVG: ${conv.converted} ok, ${conv.failed} failed`);
  } else if (conv.converted > 0) {
    log(`  ${spec.spec}: converted ${conv.converted} vector figure(s) to SVG`);
  }
  // Light sanitisation pass over the SVGs to drop libreoffice's
  // occasional file:// font references that would break the desktop's
  // in-browser render.
  for (const f of await fs.readdir(specMediaDir)) {
    if (f.endsWith(".svg")) await sanitizeSvg(path.join(specMediaDir, f));
  }

  // After conversion, the figure records still reference the original
  // .wmf/.emf filenames. Rewrite those to the .svg files we just
  // produced (the source files have been unlinked by convertVectorMedia).
  for (const row of rows) {
    for (const fig of row.figures) {
      if (!fig.mediaFilename) continue;
      if (/\.(wmf|emf)$/i.test(fig.mediaFilename)) {
        fig.mediaFilename = fig.mediaFilename.replace(/\.(wmf|emf)$/i, ".svg");
      }
    }
  }

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
