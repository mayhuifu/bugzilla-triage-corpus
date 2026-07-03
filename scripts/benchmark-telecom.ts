// ─────────────────────────────────────────────────────────────────
// benchmark-telecom.ts — run the public telecom QA benchmarks used
// by Chat3GPP (arXiv 2501.13954) against OUR corpus + retriever v2.
// Retrieval-only metrics (no LLM in the loop — we ship no reranker
// and no generator):
//
//   --dataset teleeval   (Tele-Eval, open-ended; gold = short answer)
//     • ans@5 / ans@10 : informative-token recall of the gold answer
//       within the concatenated top-k clause texts ≥ 0.6
//     • spec@5         : top-5 contains ≥1 clause of the gold source spec
//   --dataset teleqna    (TeleQnA R17 standards MCQs)
//     • ctx-acc@5 : deterministic context answerer — pick the option
//       with best token coverage in the retrieved top-5 text
//       (random baseline ≈ 1/#options)
//     • gold@5    : gold option text covered ≥ 0.6 in top-5
//
//   SAMPLE=n     subsample (deterministic, stratified by spec)  default 1500/all
//   TOPK=5       report cutoff
//
// Usage: npx tsx scripts/benchmark-telecom.ts --dataset teleeval
// ─────────────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { createRetrieverV2, tokenize, decodeFloat16Base64, vecToBlob } from "./retriever-v2.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BENCH_DIR = path.join(REPO_ROOT, "dist", "benchmarks");
const OUT_SQLITE = path.join(REPO_ROOT, "out", "corpus.sqlite");
const PYTHON = process.env.EMBED_PY ?? "python3";

const argv = process.argv.slice(2);
const dataset = argv[argv.indexOf("--dataset") + 1] ?? "teleeval";
const TOPK = Number(process.env.TOPK ?? "5");

const GENERIC = new Set([
  ...["what","which","when","where","how","why","does","can","under","during",
     "value","values","used","use","using","following","according","specified",
     "purpose","true","false","none","all","above","mentioned","refer","referred"],
]);
function infoTokens(s: string): string[] {
  return tokenize(s).filter(t => t.length >= 3 && !GENERIC.has(t));
}
function coverage(needle: string, hayLower: string): number {
  const toks = Array.from(new Set(infoTokens(needle)));
  if (toks.length === 0) return 0;
  let hit = 0;
  for (const t of toks) if (hayLower.includes(t)) hit++;
  return hit / toks.length;
}

interface Item { key: string; query: string; gold: string; spec?: string; rel?: string; options?: string[]; goldIdx?: number; }

function loadItems(): Item[] {
  if (dataset === "teleeval") {
    const rows = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, "teleeval-ours.json"), "utf8")) as
      Array<{ q: string; a: string; spec: string; rel: string; doc: string }>;
    return rows.map((r, i) => ({ key: `te${i}`, query: r.q, gold: r.a, spec: r.spec, rel: r.rel }));
  }
  const data = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, "teleqna-r17.json"), "utf8")) as
    Record<string, Record<string, string>>;
  const items: Item[] = [];
  for (const [k, v] of Object.entries(data)) {
    const options: string[] = [];
    for (let i = 1; i <= 6; i++) if (v[`option ${i}`]) options.push(v[`option ${i}`]);
    const m = /^option (\d+):/.exec(v.answer ?? "");
    if (!m) continue;
    items.push({
      key: k.replace(/\s+/g, "_"),
      query: v.question.replace(/\s*\[3GPP Release \d+\]\s*/g, " ").trim(),
      gold: options[Number(m[1]) - 1] ?? "",
      options,
      goldIdx: Number(m[1]) - 1,
    });
  }
  return items;
}

/** deterministic stratified subsample (FNV hash order per spec bucket) */
function sample(items: Item[], n: number): Item[] {
  if (n <= 0 || n >= items.length) return items;
  const h = (s: string) => {
    let x = 2166136261;
    for (const c of s) { x ^= c.charCodeAt(0); x = Math.imul(x, 16777619) >>> 0; }
    return x;
  };
  const bySpec = new Map<string, Item[]>();
  for (const it of items) {
    const k = it.spec ?? "_";
    (bySpec.get(k) ?? bySpec.set(k, []).get(k)!).push(it);
  }
  const out: Item[] = [];
  const frac = n / items.length;
  for (const [, arr] of bySpec) {
    arr.sort((a, b) => h(a.key) - h(b.key));
    out.push(...arr.slice(0, Math.max(1, Math.round(arr.length * frac))));
  }
  return out.slice(0, n + 50);
}

function embedQueries(items: Item[]): Map<string, Buffer> {
  const inPayload = items.map(it => JSON.stringify({ id: it.key, text: it.query })).join("\n") + "\n";
  const tag = crypto.createHash("sha256").update(dataset + inPayload).digest("hex").slice(0, 16);
  const embPath = path.join(BENCH_DIR, `.emb-${dataset}-${tag}.jsonl`);
  if (!fs.existsSync(embPath)) {
    const tmpIn = path.join(BENCH_DIR, `.in-${dataset}.jsonl`);
    fs.writeFileSync(tmpIn, inPayload);
    console.log(`[bench] embedding ${items.length} queries (bge-m3)…`);
    const r = spawnSync(PYTHON, [path.join(__dirname, "embed_sidecar.py"),
      "--in", tmpIn, "--out", embPath, "--model", "BAAI/bge-m3", "--batch-size", "64"],
      { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } });
    if (r.status !== 0) throw new Error("embed sidecar failed");
  } else {
    console.log(`[bench] using cached embeddings ${path.basename(embPath)}`);
  }
  const emb = new Map<string, Buffer>();
  for (const ln of fs.readFileSync(embPath, "utf8").split("\n").filter(Boolean)) {
    const rec = JSON.parse(ln) as { id: string; embedding_b64: string };
    emb.set(rec.id, vecToBlob(decodeFloat16Base64(rec.embedding_b64)));
  }
  return emb;
}

async function main() {
  const db = new Database(OUT_SQLITE, { readonly: true });
  sqliteVec.load(db);
  const retriever = createRetrieverV2(db, {
    indegreeCachePath: path.join(REPO_ROOT, "dist", ".citation-indegree.json"),
  });
  const textSql = db.prepare("SELECT text FROM clauses WHERE id = ?").pluck();

  let items = loadItems();
  const SAMPLE = Number(process.env.SAMPLE ?? (dataset === "teleeval" ? "1500" : "0"));
  items = sample(items, SAMPLE);
  console.log(`[bench] dataset=${dataset} items=${items.length} topk=${TOPK}`);
  const emb = embedQueries(items);

  let n = 0;
  const dumps: unknown[] = [];
  const agg = { ans5: 0, ans10: 0, spec5: 0, ctxAcc: 0, gold5: 0, options: 0 };
  const byRel: Record<string, { n: number; ans5: number }> = {};
  const bySpec: Record<string, { n: number; ans5: number; spec5: number }> = {};
  const t0 = Date.now();

  for (const it of items) {
    const qEmb = emb.get(it.key);
    if (!qEmb) continue;
    const ids = retriever.retrieve(it.query, qEmb);
    const texts = ids.slice(0, 10).map(id => (textSql.get(id) as string | undefined) ?? "");
    const top5 = texts.slice(0, TOPK).join("\n").toLowerCase();
    const top10 = texts.join("\n").toLowerCase();
    n++;

    if (dataset === "teleeval") {
      const c5 = coverage(it.gold, top5) >= 0.6 ? 1 : 0;
      const c10 = coverage(it.gold, top10) >= 0.6 ? 1 : 0;
      const s5 = ids.slice(0, TOPK).some(id => id.startsWith(it.spec + "#")) ? 1 : 0;
      agg.ans5 += c5; agg.ans10 += c10; agg.spec5 += s5;
      const r = (byRel[it.rel!] ??= { n: 0, ans5: 0 }); r.n++; r.ans5 += c5;
      const s = (bySpec[it.spec!] ??= { n: 0, ans5: 0, spec5: 0 }); s.n++; s.ans5 += c5; s.spec5 += s5;
    } else {
      const scores = it.options!.map(o => coverage(o, top5));
      const best = scores.indexOf(Math.max(...scores));
      agg.ctxAcc += best === it.goldIdx ? 1 : 0;
      agg.gold5 += coverage(it.gold, top5) >= 0.6 ? 1 : 0;
      agg.options += it.options!.length;
    }
    if (n % 200 === 0) console.log(`  ${n}/${items.length}  (${((Date.now() - t0) / n).toFixed(0)} ms/q)`);
    if (process.env.DUMP === "1") {
      dumps.push({
        key: it.key, query: it.query, options: it.options, goldIdx: it.goldIdx,
        gold: it.gold, spec: it.spec, rel: it.rel,
        top: ids.slice(0, TOPK).map(id => ({ id, text: ((textSql.get(id) as string | undefined) ?? "").slice(0, 1800) })),
      });
    }
  }

  console.log(`\n===== ${dataset} results (n=${n}) =====`);
  if (dataset === "teleeval") {
    console.log(`answer-containment@${TOPK}: ${(agg.ans5 / n * 100).toFixed(1)}%`);
    console.log(`answer-containment@10:     ${(agg.ans10 / n * 100).toFixed(1)}%`);
    console.log(`source-spec-hit@${TOPK}:    ${(agg.spec5 / n * 100).toFixed(1)}%`);
    console.log(`\nby source release:`);
    for (const [rel, v] of Object.entries(byRel))
      console.log(`  R${rel}: n=${v.n}  ans@${TOPK}=${(v.ans5 / v.n * 100).toFixed(1)}%`);
    console.log(`\nby spec (n≥30):`);
    for (const [sp, v] of Object.entries(bySpec).sort((a, b) => b[1].n - a[1].n)) {
      if (v.n < 30) continue;
      console.log(`  ${sp.padEnd(9)} n=${String(v.n).padStart(4)}  ans@${TOPK}=${(v.ans5 / v.n * 100).toFixed(1).padStart(5)}%  spec@${TOPK}=${(v.spec5 / v.n * 100).toFixed(1).padStart(5)}%`);
    }
  } else {
    console.log(`ctx-answerer accuracy@${TOPK}: ${(agg.ctxAcc / n * 100).toFixed(1)}%  (random ≈ ${(n / agg.options * 100).toFixed(1)}%)`);
    console.log(`gold-option containment@${TOPK}: ${(agg.gold5 / n * 100).toFixed(1)}%`);
  }
  fs.writeFileSync(path.join(BENCH_DIR, `results-${dataset}.json`),
    JSON.stringify({ dataset, n, topk: TOPK, agg, byRel, bySpec, at: new Date().toISOString() }, null, 2));
  if (dumps.length > 0) {
    fs.writeFileSync(path.join(BENCH_DIR, `dump-${dataset}.json`), JSON.stringify(dumps, null, 1));
    console.log(`[bench] dumped ${dumps.length} items with contexts`);
  }
  db.close();
}

await main();
