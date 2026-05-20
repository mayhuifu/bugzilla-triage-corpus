// ─────────────────────────────────────────────────────────────────
// 01-fetch.ts — download the latest Rel-17 (h*) version of every
// curated 3GPP spec from www.3gpp.org/ftp/Specs/archive/, unzip,
// and extract the .docx into raw/.
//
// 3GPP filename convention (from 3gpp.org/specifications-technologies
// /specifications-by-series/file-name-conventions):
//
//   <spec-no-dots>-<version>.zip      e.g. 38211-h70.zip (TS 38.211 v17.7.0)
//   <spec-no-dots>-<part>-<version>.zip   e.g. 38101-1-h70.zip
//
// Version is 3 base-36 chars: <major-release><technical><editorial>.
// Rel-17 versions start with 'h' (a=10, b=11, ..., h=17, i=18).
//
// Robustness: 3GPP archive sometimes 403s on requests without a real
// User-Agent. Set a reasonable one. Fail loud (and continue with the
// rest) when a single spec can't be fetched, so we get a clean
// "missing specs" report at the end instead of a one-spec abort.
//
// Set DRY_RUN=1 to skip the actual download and just print the URLs
// that would be fetched.
// ─────────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import AdmZip from "adm-zip";

import curated from "./curated-specs.json" with { type: "json" };

interface SpecEntry {
  spec: string;        // "38.211", "38.101-1"
  series: string;      // "38"
  title: string;
}

interface FetchResult {
  spec: string;
  series: string;
  title: string;
  release: string;     // "Rel-17"
  version: string;     // "17.7.0"
  versionTag: string;  // "h70"
  zipUrl: string;
  /** Single-part specs ship one DOCX in the zip; large specs split into
   *  multiple parts (`_cover.docx`, `_s00-s05.docx`, `_s06-s08.docx`,
   *  `_s09-sxx.docx`). We skip the cover and keep every section part in
   *  order. Parts array always has at least one entry; the parser reads
   *  every entry and concatenates the HTML before running the heading
   *  splitter. */
  parts: string[];     // filenames written under raw/, sorted
  bytes: number;       // total bytes across all parts
  /** Number of parts that were Word 97 Composite Documents and went
   *  through the libreoffice fallback (v2, SPEC.md §14 ADR-007). */
  convertedFromLegacyDoc: number;
}

/** OLE2 Compound Document File magic (Word 97-2003 .doc inside a .docx
 *  filename — 3GPP does this on a handful of older specs, e.g. 38.201). */
const OLE2_MAGIC = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);

/** PK\x03\x04 — modern .docx (= zip) magic. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4B, 0x03, 0x04]);

function isLegacyDoc(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(OLE2_MAGIC);
}
function isDocxZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC);
}

let _sofficeChecked = false;
let _sofficeBin: string | null = null;
/** Locate libreoffice's headless CLI once, lazily. Returns null when
 *  not installed (so legacy .doc parts are skipped with a warning
 *  instead of aborting the whole fetch). */
function findSoffice(): string | null {
  if (_sofficeChecked) return _sofficeBin;
  _sofficeChecked = true;
  for (const candidate of ["libreoffice", "soffice"]) {
    const r = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (r.status === 0) {
      _sofficeBin = candidate;
      return candidate;
    }
  }
  warn("libreoffice / soffice not on PATH — legacy .doc parts cannot be upgraded");
  return null;
}

/** Convert an in-memory .doc buffer to .docx via libreoffice headless.
 *  Returns the resulting .docx bytes, or null on conversion failure. */
async function convertDocToDocx(docBuf: Buffer, hint: string): Promise<Buffer | null> {
  const bin = findSoffice();
  if (!bin) return null;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "3gpp-doc-"));
  try {
    const inPath = path.join(tmpDir, "input.doc");
    await fs.writeFile(inPath, docBuf);
    const r = spawnSync(
      bin,
      ["--headless", "--convert-to", "docx", "--outdir", tmpDir, inPath],
      { encoding: "utf8", timeout: 120_000 },
    );
    if (r.status !== 0) {
      warn(`libreoffice conversion failed for ${hint}: ${r.stderr || r.stdout}`);
      return null;
    }
    const outPath = path.join(tmpDir, "input.docx");
    return await fs.readFile(outPath);
  } finally {
    // Best-effort cleanup; ignore failures.
    try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const RAW_DIR = path.join(REPO_ROOT, "raw");
const MANIFEST_PATH = path.join(RAW_DIR, "fetch-manifest.json");

const DRY_RUN = process.env.DRY_RUN === "1";

// Spoof a recent Firefox UA — 3GPP's Apache occasionally 403s the default
// node-fetch UA. This is unauthenticated public content.
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:120.0) Gecko/20100101 Firefox/120.0";

const log = (...args: unknown[]) => console.log("[fetch]", ...args);
const warn = (...args: unknown[]) => console.warn("[fetch] ⚠", ...args);

/** Convert a 3GPP base-36 version tag like "h70" to a readable "17.7.0". */
function decodeVersion(tag: string): string {
  if (!/^[a-z][a-z0-9][a-z0-9]$/i.test(tag)) return tag;
  const major = parseInt(tag[0], 36);    // 'h' = 17
  const tech = parseInt(tag[1], 36);
  const edit = parseInt(tag[2], 36);
  return `${major}.${tech}.${edit}`;
}

/** Spec "38.211" or "38.101-1" → 3GPP filename stem "38211" or "38101-1". */
function specStem(spec: string): string {
  // Remove the first '.' only; preserve subsequent hyphens (part numbers).
  const idx = spec.indexOf(".");
  if (idx < 0) return spec;
  return spec.slice(0, idx) + spec.slice(idx + 1);
}

/** GET helper with retry, fetch API. */
async function httpGet(url: string, asBuffer = false): Promise<string | ArrayBuffer> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, "Accept": "*/*" },
        redirect: "follow",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return asBuffer ? await r.arrayBuffer() : await r.text();
    } catch (err) {
      lastErr = err;
      warn(`attempt ${attempt} failed for ${url}: ${(err as Error).message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

/** List the directory for a spec, returning every `.zip` filename present. */
async function listDir(series: string, spec: string): Promise<string[]> {
  const url = `https://www.3gpp.org/ftp/Specs/archive/${series}_series/${spec}/`;
  const html = (await httpGet(url)) as string;
  // Apache directory listings use simple <a href="filename.zip">…</a>.
  const matches = Array.from(html.matchAll(/href="([^"]+\.zip)"/gi)).map(m => m[1]);
  return matches.map(m => m.split("/").pop() || m);
}

/** Pick the latest Rel-17 (h*) zip from a directory listing. */
function pickLatestRel17(spec: string, listing: string[]): string | null {
  const stem = specStem(spec);
  // Match "<stem>-h<2chars>.zip" — accept upper/lower-case.
  const re = new RegExp(`^${stem.replace(/\./g, "\\.")}-(h[a-z0-9]{2})\\.zip$`, "i");
  const candidates = listing
    .map(f => ({ f, m: f.match(re) }))
    .filter(x => x.m)
    .map(x => ({ filename: x.f, tag: x.m![1].toLowerCase() }));
  if (candidates.length === 0) return null;
  // Lexical sort works for base-36: 0-9 < a-z; 'h00' < 'h10' < ... < 'h99' < 'ha0'.
  candidates.sort((a, b) => a.tag.localeCompare(b.tag));
  return candidates[candidates.length - 1].filename;
}

/** Download and extract DOCX from a single 3GPP ZIP. */
async function fetchAndExtract(entry: SpecEntry, zipFilename: string): Promise<FetchResult> {
  const url = `https://www.3gpp.org/ftp/Specs/archive/${entry.series}_series/${entry.spec}/${zipFilename}`;
  const tag = zipFilename.match(/-(h[a-z0-9]{2})\.zip$/i)?.[1] || "";
  const version = decodeVersion(tag);

  const result: FetchResult = {
    spec: entry.spec,
    series: entry.series,
    title: entry.title,
    release: "Rel-17",
    version,
    versionTag: tag,
    zipUrl: url,
    parts: [],
    bytes: 0,
    convertedFromLegacyDoc: 0,
  };

  if (DRY_RUN) {
    log(`DRY_RUN → would fetch ${url}`);
    return result;
  }

  log(`fetch ${entry.spec} (${version}) ← ${zipFilename}`);
  const buf = (await httpGet(url, true)) as ArrayBuffer;
  const zipBytes = buf.byteLength;

  // Identify every .doc/.docx inside the zip, skipping the small "cover"
  // sheet that 3GPP includes with multi-part specs (e.g. for 36.211 the
  // zip has 36211-h40_cover.docx + three section parts; we want only the
  // section parts). Pure cover ZIPs (single-file specs like 38.211) are
  // not affected because their lone file has no _cover suffix.
  const zip = new AdmZip(Buffer.from(buf));
  const allDocxEntries = zip.getEntries()
    .filter(e => !e.isDirectory && /\.(docx?)$/i.test(e.entryName))
    .filter(e => !/_cover\.docx?$/i.test(e.entryName))
    // Sort by name so the parser walks parts in section order
    // (s00-s05 < s06-s08 < s09-sxx < sAnnexes).
    .sort((a, b) => a.entryName.localeCompare(b.entryName));
  if (allDocxEntries.length === 0) {
    throw new Error(`${zipFilename}: no non-cover .docx inside (entries: ${zip.getEntries().map(e => e.entryName).join(", ")})`);
  }

  const stem = specStem(entry.spec);
  for (let i = 0; i < allDocxEntries.length; i++) {
    const innerEntry = allDocxEntries[i];
    // Preserve the original inner-name suffix when present (e.g. "_s00-05",
    // "_sAnnexes") so it's obvious which part of the spec each file holds.
    // For single-part specs (no underscore in the inner name) use a
    // numeric suffix to keep the on-disk name unique per spec.
    const baseName = innerEntry.entryName.split("/").pop() || innerEntry.entryName;
    const suffixMatch = baseName.match(/[_-]([a-z0-9-]+)\.docx?$/i);
    const suffix = allDocxEntries.length === 1
      ? ""                                 // single file → no suffix
      : `__${suffixMatch ? suffixMatch[1] : `part${i + 1}`}`;
    const outName = `${stem}-${tag}${suffix}.docx`;
    const outPath = path.join(RAW_DIR, outName);

    let bytes = innerEntry.getData();
    // ADR-007: detect Word 97 Composite Document (legacy .doc shipped
    // under a .docx filename — happens on 38.201 and a couple of older
    // specs). Run libreoffice headless to upgrade before mammoth sees it.
    if (isLegacyDoc(bytes)) {
      log(`  ⤷ ${baseName} is legacy .doc, converting via libreoffice…`);
      const upgraded = await convertDocToDocx(bytes, `${entry.spec}/${baseName}`);
      if (upgraded && isDocxZip(upgraded)) {
        bytes = upgraded;
        result.convertedFromLegacyDoc++;
      } else {
        warn(`${entry.spec}: legacy-doc conversion failed for ${baseName}; skipping this part`);
        continue;
      }
    } else if (!isDocxZip(bytes)) {
      warn(`${entry.spec}: ${baseName} has unrecognized magic; treating as opaque and writing as-is`);
    }

    await fs.writeFile(outPath, bytes);
    result.parts.push(outName);
    result.bytes += bytes.length;
  }
  log(`  → wrote ${result.parts.length} part(s) for ${entry.spec} (${(zipBytes / 1024 / 1024).toFixed(1)} MB zip, ${(result.bytes / 1024 / 1024).toFixed(1)} MB extracted)`);
  return result;
}

async function main() {
  await fs.mkdir(RAW_DIR, { recursive: true });
  const specs = (curated as { specs: SpecEntry[] }).specs;
  log(`fetching ${specs.length} spec(s) for ${(curated as { release: string }).release}`);
  if (DRY_RUN) log("DRY_RUN=1 → no downloads, just URL discovery");

  const results: FetchResult[] = [];
  const missing: { spec: string; reason: string }[] = [];

  for (const entry of specs) {
    try {
      const listing = await listDir(entry.series, entry.spec);
      const zipName = pickLatestRel17(entry.spec, listing);
      if (!zipName) {
        missing.push({ spec: entry.spec, reason: `no Rel-17 (h*) ZIP in directory listing` });
        warn(`${entry.spec}: no Rel-17 version found among ${listing.length} listing entries`);
        continue;
      }
      const result = await fetchAndExtract(entry, zipName);
      results.push(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      missing.push({ spec: entry.spec, reason: msg });
      warn(`${entry.spec}: ${msg}`);
    }
  }

  await fs.writeFile(
    MANIFEST_PATH,
    JSON.stringify({ release: "Rel-17", builtAt: new Date().toISOString(), specs: results, missing }, null, 2),
  );

  log("");
  log(`✓ ${results.length} spec(s) fetched`);
  if (missing.length) {
    log(`✗ ${missing.length} spec(s) failed/missing:`);
    for (const m of missing) log(`    - ${m.spec}: ${m.reason}`);
  }
  log(`wrote ${MANIFEST_PATH}`);

  if (missing.length > 0 && !DRY_RUN) {
    // Don't auto-abort — the parse step skips missing specs gracefully.
    // But surface a non-zero exit so CI fails if anything is unfetchable.
    process.exitCode = 1;
  }
}

await main();
