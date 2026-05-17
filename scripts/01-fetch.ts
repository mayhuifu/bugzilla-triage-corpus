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
import { fileURLToPath } from "node:url";
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
  docxFilename: string;
  bytes: number;
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
    docxFilename: "",
    bytes: 0,
  };

  if (DRY_RUN) {
    log(`DRY_RUN → would fetch ${url}`);
    return result;
  }

  log(`fetch ${entry.spec} (${version}) ← ${zipFilename}`);
  const buf = (await httpGet(url, true)) as ArrayBuffer;
  result.bytes = buf.byteLength;

  // Unpack the docx out of the zip.
  const zip = new AdmZip(Buffer.from(buf));
  const docxEntry = zip.getEntries().find(e =>
    !e.isDirectory && /\.(docx?)$/i.test(e.entryName)
  );
  if (!docxEntry) {
    throw new Error(`${zipFilename}: no .docx inside (entries: ${zip.getEntries().map(e => e.entryName).join(", ")})`);
  }
  // Normalize the on-disk filename: <stem>-<tag>.docx, regardless of how
  // 3GPP packaged it. Simpler for the parser to pick up later.
  const stem = specStem(entry.spec);
  const outName = `${stem}-${tag}.docx`;
  const outPath = path.join(RAW_DIR, outName);
  await fs.writeFile(outPath, docxEntry.getData());
  result.docxFilename = outName;
  log(`  → wrote ${outName} (${(result.bytes / 1024 / 1024).toFixed(1)} MB zip)`);
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
