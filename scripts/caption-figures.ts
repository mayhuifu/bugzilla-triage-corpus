// ─────────────────────────────────────────────────────────────────
// caption-figures.ts — Phase B (rel17-v6) build step: VLM figure captioning.
//
// Makes diagrams searchable by CONTENT, not just their "Figure N:" label.
// For each captioned figure in dist/clauses.json, sends the extracted PNG +
// context to a vision LLM and gets a concise factual caption, then:
//   • sets `vlmCaption` on the figures_json entry (→ desktop display), and
//   • appends "Figure N (diagram): <vlmCaption>" to the clause's `text` so it
//     flows into BOTH FTS5 (03-index) and the dense embeddings (embed step) —
//     i.e. the figure becomes matchable by what it shows.
//
// Runs AFTER 02-parse, BEFORE embed/index (so captions are embedded). Output
// rewrites dist/clauses.json + dist/clauses.jsonl in place and writes
// dist/caption-meta.json (model + count) which 03-index records into meta.
//
// Idempotent: caches by image SHA-256 in dist/caption-cache.json, so re-runs
// only caption new/changed images. Knobs (env):
//   CAPTION_MODEL       vision model id            (default claude-3-5-sonnet-latest)
//   CAPTION_BUDGET      max NEW figures to caption  (default Infinity)
//   CAPTION_CONCURRENCY parallel API calls          (default 4)
//   ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL — required; if the key is absent the
//   step is a graceful NO-OP (logs a warning, leaves text/captions untouched →
//   a valid schema-4 corpus without captions, so the build never hard-fails).
// ─────────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const MEDIA_DIR = path.join(DIST_DIR, "media");
const CLAUSES_JSON = path.join(DIST_DIR, "clauses.json");
const CLAUSES_JSONL = path.join(DIST_DIR, "clauses.jsonl");
const CACHE_PATH = path.join(DIST_DIR, "caption-cache.json");
const META_PATH = path.join(DIST_DIR, "caption-meta.json");

const MODEL = process.env.CAPTION_MODEL || "claude-3-5-sonnet-latest";
const BUDGET = Number(process.env.CAPTION_BUDGET) || Infinity;
const CONCURRENCY = Math.max(1, Number(process.env.CAPTION_CONCURRENCY) || 4);
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const BASE_URL = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";

const log = (...a: unknown[]) => console.log("[caption]", ...a);
const warn = (...a: unknown[]) => console.warn("[caption] ⚠", ...a);

interface Figure { id: string; caption: string; mediaFilename?: string; vlmCaption?: string }
interface ClauseRow { id: string; spec: string; citation: string; title: string; text: string; figures?: Figure[]; [k: string]: unknown }

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif" };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Caption one image via the Anthropic vision API. Retries transient errors. */
async function captionImage(imgB64: string, mime: string, ctx: { citation: string; title: string; caption: string }): Promise<string> {
  const prompt =
    `This image is a figure from the 3GPP telecom standard ${ctx.citation} ` +
    `("${ctx.title}"). Its label is "${ctx.caption}". Write 1–2 concise, factual ` +
    `sentences describing what the diagram actually SHOWS — the entities, signals, ` +
    `channels, timing, states, or relationships visible — so an engineer can find ` +
    `it by searching for its content. No preamble, no "this figure shows".`;
  const body = {
    model: MODEL,
    max_tokens: 200,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mime, data: imgB64 } },
        { type: "text", text: prompt },
      ],
    }],
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 1000));
      continue;
    }
    if (res.ok) {
      const j = await res.json() as { content?: Array<{ type: string; text?: string }> };
      return (j.content ?? []).filter(c => c.type === "text").map(c => c.text ?? "").join(" ").trim();
    }
    if (![429, 500, 502, 503, 504].includes(res.status) || attempt === 4) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    await sleep(Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 1000));
  }
  throw new Error("unreachable");
}

async function main() {
  const rows = JSON.parse(await fs.readFile(CLAUSES_JSON, "utf8")) as ClauseRow[];

  // Collect captioned figures that have an on-disk image.
  type Job = { row: ClauseRow; fig: Figure; imgPath: string };
  const jobs: Job[] = [];
  for (const row of rows) {
    const specDir = row.spec.replace(/^TS\s+/, "");
    for (const fig of row.figures ?? []) {
      if (!fig.mediaFilename) continue;
      const imgPath = path.join(MEDIA_DIR, specDir, fig.mediaFilename);
      if (fsSync.existsSync(imgPath)) jobs.push({ row, fig, imgPath });
    }
  }
  log(`${jobs.length} captioned figure image(s) across ${rows.length} clause(s)`);

  if (!API_KEY) {
    warn("ANTHROPIC_API_KEY not set — skipping VLM captioning (corpus stays valid schema-4, no captions).");
    await fs.writeFile(META_PATH, JSON.stringify({ model: null, captioned: 0, skipped: jobs.length, builtAt: new Date().toISOString() }, null, 2));
    return;
  }

  // Cache by image SHA-256 so re-runs only caption new images.
  const cache: Record<string, string> = await readJsonOptional(CACHE_PATH) ?? {};
  let captioned = 0, fromCache = 0, failed = 0, budgetLeft = BUDGET;

  // Build a worklist of unique (hash → job representative) plus all jobs to apply.
  const hashOf = (p: string) => crypto.createHash("sha256").update(fsSync.readFileSync(p)).digest("hex");
  const jobHash = new Map<Job, string>();
  for (const j of jobs) jobHash.set(j, hashOf(j.imgPath));

  // Caption unique uncached hashes with bounded concurrency.
  const uncached = [...new Set(jobs.filter(j => !(jobHash.get(j)! in cache)).map(j => jobHash.get(j)!))];
  log(`${uncached.length} new image hash(es) to caption (model=${MODEL}, concurrency=${CONCURRENCY}, budget=${BUDGET})`);
  const repByHash = new Map<string, Job>();
  for (const j of jobs) if (!repByHash.has(jobHash.get(j)!)) repByHash.set(jobHash.get(j)!, j);

  let idx = 0;
  async function worker() {
    while (idx < uncached.length && budgetLeft > 0) {
      const hash = uncached[idx++];
      budgetLeft--;
      const j = repByHash.get(hash)!;
      const ext = (j.fig.mediaFilename!.split(".").pop() || "png").toLowerCase();
      try {
        const b64 = fsSync.readFileSync(j.imgPath).toString("base64");
        const cap = await captionImage(b64, MIME[ext] || "image/png", { citation: j.row.citation, title: j.row.title, caption: j.fig.caption });
        if (cap) { cache[hash] = cap; captioned++; }
        if (captioned % 25 === 0 && captioned) log(`  …${captioned} captioned`);
      } catch (e) {
        failed++;
        if (failed <= 5) warn(`  ${j.fig.id}: ${(e as Error).message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 0));

  // Apply captions: set vlmCaption on each figure + append to its clause text
  // (so FTS + embeddings pick it up). Append once per clause.
  for (const j of jobs) {
    const cap = cache[jobHash.get(j)!];
    if (!cap) continue;
    j.fig.vlmCaption = cap;
    fromCache++;
  }
  for (const row of rows) {
    const caps = (row.figures ?? []).filter(f => f.vlmCaption);
    if (caps.length === 0) continue;
    const appendix = caps.map(f => {
      const num = f.id.split("/Figure-")[1] ?? "";
      return `Figure ${num} (diagram): ${f.vlmCaption}`;
    }).join("\n");
    row.text = `${row.text}\n\n${appendix}`.trim();
  }

  // Rewrite outputs.
  await fs.writeFile(CLAUSES_JSON, JSON.stringify(rows));
  await fs.writeFile(CLAUSES_JSONL, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  await fs.writeFile(META_PATH, JSON.stringify({ model: MODEL, captioned: Object.keys(cache).length, applied: fromCache, failed, builtAt: new Date().toISOString() }, null, 2));

  log(`✓ captioned ${captioned} new image(s) (${failed} failed); applied to ${fromCache} figure record(s)`);
  log(`  cache: ${Object.keys(cache).length} entries → ${CACHE_PATH}`);
  log(`  rewrote ${CLAUSES_JSON} + ${CLAUSES_JSONL}`);
}

async function readJsonOptional<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(p, "utf8")) as T; } catch { return null; }
}

await main();
