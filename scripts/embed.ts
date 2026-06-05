// ─────────────────────────────────────────────────────────────────
// embed.ts — read dist/clauses.jsonl, compute one dense embedding
// per leaf clause plus one rollup per non-leaf parent, write
// dist/clauses-with-vec.jsonl + dist/parents-with-vec.jsonl.
//
// Heavy lifting is delegated to scripts/embed_sidecar.py (bge-m3
// by default; override via EMBED_MODEL env). The TS layer only
// orchestrates input/output JSONL files; it never touches model
// weights or floats directly.
//
// Parent rollups: every clause with a non-null parentId contributes
// its embedding to its parent's average. We L2-normalize the mean
// so the rollup lives on the same unit sphere as the leaves.
//
// Output format (one record per line):
//   { id, embedding_b64 }   ← float16 vector, base64-encoded bytes
// The downstream 03-index.ts decodes embedding_b64 into a BLOB
// straight into the sqlite-vec virtual table.
//
// Env:
//   EMBED_MODEL=BAAI/bge-m3           (default)
//   EMBED_BATCH=32
//   EMBED_DEVICE=cpu|cuda|mps         (default: model picks)
//   EMBED_PY=/path/to/python          (default: python3)
//   EMBED_INPUT=dist/clauses.jsonl    (override input path)
// ─────────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const IN_CLAUSES_JSONL = process.env.EMBED_INPUT
  ? path.resolve(process.env.EMBED_INPUT)
  : path.join(DIST_DIR, "clauses.jsonl");
const OUT_LEAF = path.join(DIST_DIR, "clauses-with-vec.jsonl");
const OUT_PARENT = path.join(DIST_DIR, "parents-with-vec.jsonl");

const log = (...args: unknown[]) => console.log("[embed]", ...args);
const warn = (...args: unknown[]) => console.warn("[embed] ⚠", ...args);

const MODEL = process.env.EMBED_MODEL ?? "BAAI/bge-m3";
const BATCH = Number(process.env.EMBED_BATCH ?? "32");
const DEVICE = process.env.EMBED_DEVICE;
const PYTHON = process.env.EMBED_PY ?? "python3";

interface ClauseLike {
  id: string;
  text: string;
  title?: string;
  parentId?: string | null;
  parentTitle?: string | null;
}

/** Read clauses.jsonl (one record per line). */
async function readClausesJsonl(p: string): Promise<ClauseLike[]> {
  const raw = await fs.readFile(p, "utf8");
  const out: ClauseLike[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    out.push(JSON.parse(s));
  }
  return out;
}

/** Build the input the Python sidecar embeds — title + text gives the
 *  encoder a label-rich representation (helps short clauses). */
function asEmbedRecord(c: ClauseLike): { id: string; text: string } {
  const label = c.title ? `${c.title}\n` : "";
  return { id: c.id, text: `${label}${c.text}` };
}

/** Spawn the Python sidecar and wait for completion. */
async function runSidecar(inPath: string, outPath: string): Promise<void> {
  const sidecar = path.join(__dirname, "embed_sidecar.py");
  const args = [
    sidecar,
    "--in", inPath,
    "--out", outPath,
    "--model", MODEL,
    "--batch-size", String(BATCH),
  ];
  if (DEVICE) args.push("--device", DEVICE);
  log(`spawning ${PYTHON} ${args.join(" ")}`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(PYTHON, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`embed_sidecar.py exited with code ${code}`));
    });
  });
}

/** Decode a base64-encoded float16 buffer into a Float32Array (so we can
 *  average parent rollups in JS without dragging in a fp16 lib). */
function decodeFloat16Base64(b64: string): Float32Array {
  const bytes = Buffer.from(b64, "base64");
  const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const f32 = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) f32[i] = fp16ToFp32(u16[i]);
  return f32;
}

/** IEEE 754 half → single. Branchless enough; ~no allocations. */
function fp16ToFp32(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) {
    // subnormal
    if (f === 0) return s ? -0 : 0;
    const v = f * 2 ** -24;
    return s ? -v : v;
  }
  if (e === 0x1f) {
    return f ? NaN : (s ? -Infinity : Infinity);
  }
  const v = (1 + f / 1024) * 2 ** (e - 15);
  return s ? -v : v;
}

/** Encode Float32Array → float16 buffer → base64 string. */
function encodeFloat16Base64(v: Float32Array): string {
  const u16 = new Uint16Array(v.length);
  for (let i = 0; i < v.length; i++) u16[i] = fp32ToFp16(v[i]);
  const bytes = Buffer.from(u16.buffer, u16.byteOffset, u16.byteLength);
  return bytes.toString("base64");
}

function fp32ToFp16(val: number): number {
  if (Number.isNaN(val)) return 0x7e00;
  if (!Number.isFinite(val)) return val > 0 ? 0x7c00 : 0xfc00;
  if (val === 0) return Object.is(val, -0) ? 0x8000 : 0;
  const s = val < 0 ? 1 : 0;
  const av = Math.abs(val);
  if (av >= 65504) return s ? 0xfc00 : 0x7c00;
  if (av < 6.10352e-5) {
    // subnormal
    const f = Math.round(av / 2 ** -24);
    return (s << 15) | (f & 0x3ff);
  }
  const e = Math.floor(Math.log2(av));
  const f = Math.round((av / 2 ** e - 1) * 1024);
  return (s << 15) | ((e + 15) << 10) | (f & 0x3ff);
}

interface EmbeddingRecord {
  id: string;
  embedding_b64: string;
}

async function main() {
  await fs.mkdir(DIST_DIR, { recursive: true });

  log(`reading ${IN_CLAUSES_JSONL}`);
  const clauses = await readClausesJsonl(IN_CLAUSES_JSONL);
  if (clauses.length === 0) {
    console.error("[embed] empty input — did you run `npm run parse`?");
    process.exit(1);
  }
  log(`embedding ${clauses.length} clause(s) with ${MODEL}`);

  // ── Leaf embeddings ──────────────────────────────────────────
  const tmpIn = path.join(DIST_DIR, ".embed-in.jsonl");
  const tmpOut = path.join(DIST_DIR, ".embed-out.jsonl");
  const inLines = clauses.map(c => JSON.stringify(asEmbedRecord(c))).join("\n") + "\n";
  await fs.writeFile(tmpIn, inLines);
  await runSidecar(tmpIn, tmpOut);

  // Pipe sidecar output straight to OUT_LEAF (no further processing).
  await fs.copyFile(tmpOut, OUT_LEAF);
  log(`✓ wrote ${OUT_LEAF}`);

  // ── Parent rollups ───────────────────────────────────────────
  // For each non-leaf parent referenced by parentId, average its
  // children's vectors and L2-normalize so the rollup stays on the
  // unit sphere. These rollups feed parent_vec in 03-index.ts and
  // enable parent-document retrieval (a hierarchical-retrieval win
  // documented in Chat3GPP).
  log("computing parent rollups…");
  const leafRecords = await readEmbeddingsJsonl(tmpOut);
  const leafIdx = new Map(leafRecords.map(r => [r.id, decodeFloat16Base64(r.embedding_b64)]));
  const childrenByParent = new Map<string, Float32Array[]>();
  for (const c of clauses) {
    if (!c.parentId) continue;
    const v = leafIdx.get(c.id);
    if (!v) continue;
    const arr = childrenByParent.get(c.parentId) ?? [];
    arr.push(v);
    childrenByParent.set(c.parentId, arr);
  }

  let parentCount = 0;
  const parentLines: string[] = [];
  for (const [parentId, vecs] of childrenByParent) {
    if (vecs.length === 0) continue;
    const dim = vecs[0].length;
    const acc = new Float32Array(dim);
    for (const v of vecs) for (let i = 0; i < dim; i++) acc[i] += v[i];
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      acc[i] /= vecs.length;
      norm += acc[i] * acc[i];
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) acc[i] /= norm;
    parentLines.push(JSON.stringify({
      id: parentId,
      childCount: vecs.length,
      embedding_b64: encodeFloat16Base64(acc),
    }));
    parentCount++;
  }
  await fs.writeFile(OUT_PARENT, parentLines.join("\n") + "\n");
  log(`✓ wrote ${OUT_PARENT} (${parentCount} parent rollup(s))`);

  // Clean up tmp files. Keep them if EMBED_KEEP_TMP=1 for debugging.
  if (!process.env.EMBED_KEEP_TMP) {
    try { await fs.unlink(tmpIn); } catch { /* ignore */ }
    try { await fs.unlink(tmpOut); } catch { /* ignore */ }
  }

  // Record the model that ACTUALLY produced these vectors so 03-index stamps
  // meta.embeddingModel correctly regardless of its own env default. The
  // desktop matches its bundled embedder against meta.embeddingModel — a wrong
  // value silently drops hybrid → BM25, so this must be authoritative.
  await fs.writeFile(
    path.join(DIST_DIR, "embed-meta.json"),
    JSON.stringify({ model: MODEL, dtype: "float16", builtAt: new Date().toISOString() }, null, 2),
  );

  // ── Stats ────────────────────────────────────────────────────
  const leafBytes = (await fs.stat(OUT_LEAF)).size;
  const parentBytes = (await fs.stat(OUT_PARENT)).size;
  log("");
  log(`✓ embeddings ready`);
  log(`  model:   ${MODEL}`);
  log(`  leaves:  ${clauses.length} (${(leafBytes / 1024 / 1024).toFixed(1)} MB)`);
  log(`  parents: ${parentCount} (${(parentBytes / 1024 / 1024).toFixed(1)} MB)`);
}

async function readEmbeddingsJsonl(p: string): Promise<EmbeddingRecord[]> {
  const raw = await fs.readFile(p, "utf8");
  const out: EmbeddingRecord[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    out.push(JSON.parse(s));
  }
  return out;
}

await main();
