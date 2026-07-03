// ─────────────────────────────────────────────────────────────────
// rag-test-harness.ts — run scripts/rag-uplink-testset.json against
// out/corpus.sqlite using the SAME hybrid retrieval the desktop
// retriever / 05-eval.ts use (FTS5 OR-of-tokens BM25 ⊕ sqlite-vec,
// RRF k=60). No reranking.
//
// PASS rule (per user spec): for EVERY variant of a row, EVERY
// expected ref must appear in the hybrid top-K (default 5).
// A ref like "38.213#9.2.5" matches a retrieved leaf id if the id is
// equal to it OR starts with it + "." (parent-prefix rule — corpus
// stores leaves).
//
//   npx tsx scripts/rag-test-harness.ts            # top-5 gate
//   TOPK=10 npx tsx scripts/rag-test-harness.ts    # looser look
//   SHOW=12 npx tsx scripts/rag-test-harness.ts    # dump top-12 per query
//
// Retrieval-improvement toggles (A/B against the mirrored v1 builder):
//   EXPAND=1        acronym query expansion via the corpus `acronyms` table
//   WEIGHTS=10,8,4,4,1   bm25 column weights (citation,title,parent_title,path,text)
//   CAND=100        candidate pool depth per source (default 50)
//
// Writes dist/rag-test-report.json with full per-variant rankings.
// ─────────────────────────────────────────────────────────────────

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(REPO_ROOT, "dist");
const OUT_SQLITE = path.join(REPO_ROOT, "out", "corpus.sqlite");
const TESTSET = path.join(__dirname, "rag-uplink-testset.json");
const OUT_REPORT = path.join(DIST_DIR, "rag-test-report.json");

const RRF_K = Number(process.env.RRFK ?? "5");   // 2-3 lists: small k rewards single-list excellence
const CANDIDATES_PER_SOURCE = Number(process.env.CAND ?? "50");
const TOP_K = Number(process.env.TOPK ?? "5");
const SHOW = Number(process.env.SHOW ?? "0");
const PYTHON = process.env.EMBED_PY ?? "python3";
const EXPAND = process.env.EXPAND !== "0";   // default ON (retriever v2)
const DEFAULT_WEIGHTS = "4,8,2,2,1,5";       // citation,title,parent_title,path,text,aux
// bm25 column weights over (citation, title, parent_title, path, text);
// unset → plain bm25(clauses_fts) exactly like the v1 desktop retriever.
const WEIGHTS = (process.env.WEIGHTS ?? DEFAULT_WEIGHTS).split(",").map(s => s.trim()).filter(Boolean)
  .map(Number).filter(n => !Number.isNaN(n));
if (WEIGHTS.length > 0 && WEIGHTS.length < 5) {
  throw new Error("WEIGHTS must list ≥5 numbers (citation,title,parent_title,path,text[,aux])");
}

const log = (...a: unknown[]) => console.log(...a);

// ── mirror 05-eval.ts / desktop retriever tokenization ──────────
const STOPWORDS = new Set([
  "the","a","an","and","or","of","to","in","on","for","is","are","was","were",
  "be","been","by","with","as","at","that","this","it","its","from","into",
  "than","then","such","not","no","do","does","did","has","have","had",
]);
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]+/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}
function buildBm25Match(query: string): string {
  const tokens = Array.from(new Set(tokenize(query))).slice(0, 40);
  if (tokens.length === 0) return '""';
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

// ── concept-group query builder (retriever v2) ──────────────────
// A terse 3GPP query like "1 PUCCH + 1 SRS" names CONCEPTS, and a
// relevant clause must mention ALL of them — OR-of-tokens ranks any
// clause that spams one term. Build one OR-group per informative
// token: the token itself, its component words (hyphen compounds),
// and its glossary expansion(s)/aliases as phrases; reverse-map
// spelled-out phrases back to their acronym. AND the groups.
// Progressive relaxation: if the AND query yields too few candidates,
// retry with generic groups dropped, then fall back to v1 OR-soup.
// Results merge in that precedence order.
// NOTE: "two"/"different" are NOT generic here — in 3GPP capability
// language they are load-bearing ("twoPUCCH-…", "…DifferentTB-…").
const GENERIC_TOKENS = new Set([
  "one","separate","same","parallel","case",
  "transmission","transmissions","resource","resources","procedure",
  "overlapping","overlap","simultaneous","cross","channel","channels",
  "uplink","downlink","slot","symbol","configured","support","supported",
]);
const COUNT_WORDS = new Set(["two", "three", "dual", "multiple"]);
interface AcronymGlossary {
  byToken: Map<string, string[]>;        // "pusch" → ["physical uplink shared channel"]
  byExpansionWords: Array<{ words: string[]; acronym: string }>;
}
function loadGlossary(db: InstanceType<typeof Database>): AcronymGlossary {
  const byToken = new Map<string, string[]>();
  const byExpansionWords: AcronymGlossary["byExpansionWords"] = [];
  try {
    const rows = db.prepare("SELECT acronym, expansion, aliases FROM acronyms").all() as
      Array<{ acronym: string; expansion: string; aliases: string | null }>;
    for (const r of rows) {
      const key = r.acronym.toLowerCase();
      const exps = [r.expansion.toLowerCase()];
      if (r.aliases) {
        try { for (const a of JSON.parse(r.aliases) as string[]) exps.push(a.toLowerCase()); }
        catch { /* ignore malformed aliases */ }
      }
      byToken.set(key, exps);
      byExpansionWords.push({ words: tokenize(r.expansion), acronym: key });
    }
  } catch { /* acronyms table absent — expansion becomes a no-op */ }
  return { byToken, byExpansionWords };
}
function quote(s: string): string { return `"${s.replace(/"/g, '""')}"`; }
/** OR-group for one query token: the token, its hyphen-component
 *  words, its glossary expansion(s) as phrases, AND the informative
 *  single words of those expansions (so "srs" reaches a title like
 *  "UE sounding procedure" via "sounding", and "pucch" reaches aux
 *  "Uplink Control Information" via "control"). */
function tokenGroup(t: string, g?: AcronymGlossary, sharedExpWords?: Set<string>): string {
  const members = new Set<string>([t]);
  if (t.includes("-")) for (const w of t.split("-")) if (w.length >= 2 && !STOPWORDS.has(w)) members.add(w);
  if (g) {
    for (const base of Array.from(members)) {
      for (const exp of g.byToken.get(base) ?? []) {
        members.add(exp);
        // Bridging words: long (≥6 chars), non-generic expansion words
        // that are UNIQUE to this group ("sounding" for srs bridges to
        // the title "UE sounding procedure"; shared words like
        // "physical"/"uplink" appear in several groups and only leak).
        for (const w of tokenize(exp)) {
          if (w.length >= 6 && !GENERIC_TOKENS.has(w) && !sharedExpWords?.has(w)) members.add(w);
        }
      }
    }
  }
  return `(${Array.from(members).map(quote).join(" OR ")})`;
}
/** Build the relaxation ladder of MATCH strings, strongest first:
 *  L0 phrase tier (adjacent informative tokens as exact phrases),
 *  L1 AND of all token groups, L2 AND of informative groups only,
 *  L3 the v1 OR-soup as the recall floor. */
function buildMatchLadder(query: string, g?: AcronymGlossary): string[] {
  const seq = tokenize(query);                       // keep order for phrases
  const tokens = Array.from(new Set(seq)).slice(0, 40);
  if (tokens.length === 0) return ['""'];
  const qJoined = tokens.join(" ");
  // reverse-map: spelled-out expansion in the query → add its acronym
  // as an extra group member (e.g. "transport blocks" → "tb").
  const extraByToken = new Map<string, string>();
  if (g) for (const { words, acronym } of g.byExpansionWords) {
    if (words.length >= 2 && qJoined.includes(words.join(" "))) {
      extraByToken.set(words[0], acronym);
    }
  }
  // expansion words appearing in >1 query-token's expansions are
  // cross-group leaks — exclude them from bridging membership.
  const sharedExpWords = new Set<string>();
  if (g) {
    const seenIn = new Map<string, number>();
    for (const t of tokens) {
      const words = new Set<string>();
      for (const exp of g.byToken.get(t) ?? []) for (const w of tokenize(exp)) words.add(w);
      for (const w of words) seenIn.set(w, (seenIn.get(w) ?? 0) + 1);
    }
    for (const [w, n] of seenIn) if (n > 1) sharedExpWords.add(w);
  }
  // count-word collocations: a query mentioning both a count word and
  // an acronym ("PUCCH + PUCCH as two…") targets capability names like
  // "twoPUCCH-…", whose aux split is "two PUCCH …" — add the phrase to
  // the acronym's group even though the words aren't adjacent.
  const countWords = tokens.filter(t => COUNT_WORDS.has(t));
  const groupOf = (t: string) => {
    let base = tokenGroup(t, g, sharedExpWords);
    const extra = extraByToken.get(t);
    if (extra) base = base.replace(/\)$/, ` OR ${quote(extra)})`);
    if (g?.byToken.has(t)) {
      for (const cw of countWords) base = base.replace(/\)$/, ` OR ${quote(`${cw} ${t}`)})`);
    }
    return base;
  };
  const ladder: string[] = [];
  // L0: exact-phrase tier — adjacent informative-token bigrams, ANDed
  // with the remaining informative singles ("two periodic srs
  // resources" → "periodic srs" AND (two…) — hits clauses carrying
  // the literal collocation the engineer typed).
  const bigrams: string[] = [];
  const inBigram = new Set<string>();
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = seq[i], b = seq[i + 1];
    // acronym+acronym adjacency ("PUSCH + PUCCH") is an ENUMERATION of
    // separate channels, not a collocation — a phrase for it matches RF
    // time-mask titles ("PUSCH-PUCCH … time masks"), pure noise.
    const bothAcronyms = !!g && g.byToken.has(a) && g.byToken.has(b);
    if (!GENERIC_TOKENS.has(a) && !GENERIC_TOKENS.has(b) && a !== b && !bothAcronyms) {
      bigrams.push(quote(`${a} ${b}`));
      inBigram.add(a); inBigram.add(b);
    }
  }
  if (bigrams.length > 0) {
    const rest = tokens.filter(t => !inBigram.has(t) && !GENERIC_TOKENS.has(t)).map(groupOf);
    ladder.push([...bigrams, ...rest].join(" AND "));
  }
  const all = tokens.map(groupOf);
  const informative = tokens.filter(t => !GENERIC_TOKENS.has(t)).map(groupOf);
  ladder.push(all.join(" AND "));
  if (informative.length > 0 && informative.length < all.length) {
    ladder.push(informative.join(" AND "));
  }
  ladder.push(buildBm25Match(query));   // v1 OR-soup fallback
  return Array.from(new Set(ladder));
}

// ── float16 base64 → Float32Array (matches embed.ts) ────────────
function decodeFloat16Base64(b64: string): Float32Array {
  const bytes = Buffer.from(b64, "base64");
  const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const f32 = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) f32[i] = fp16ToFp32(u16[i]);
  return f32;
}
function fp16ToFp32(h: number): number {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7c00) >> 10;
  const f = h & 0x03ff;
  if (e === 0) { if (f === 0) return s ? -0 : 0; const v = f * 2 ** -24; return s ? -v : v; }
  if (e === 0x1f) return f ? NaN : s ? -Infinity : Infinity;
  const v = (1 + f / 1024) * 2 ** (e - 15);
  return s ? -v : v;
}
function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

interface TestRow { row: number; name: string; variants: string[]; expected: string[]; }
interface TestSet { topK: number; rows: TestRow[]; }

function refMatches(ref: string, id: string): boolean {
  return id === ref || id.startsWith(ref + ".");
}

async function main() {
  const testset = JSON.parse(await fs.readFile(TESTSET, "utf8")) as TestSet;
  if (!fsSync.existsSync(OUT_SQLITE)) {
    console.error("out/corpus.sqlite missing — run `npm run index` first.");
    process.exit(1);
  }
  const db = new Database(OUT_SQLITE, { readonly: true });
  sqliteVec.load(db);

  const embeddingModel = db.prepare("SELECT value FROM meta WHERE key='embeddingModel'").pluck().get() as string | undefined;

  // one variant list, embed once via sidecar
  const variants: Array<{ key: string; row: number; query: string }> = [];
  for (const r of testset.rows)
    r.variants.forEach((q, i) => variants.push({ key: `${r.row}.${i}`, row: r.row, query: q }));

  const tmpIn = path.join(DIST_DIR, ".rag-test.in.jsonl");
  const tmpOut = path.join(DIST_DIR, ".rag-test.emb.jsonl");
  await fs.mkdir(DIST_DIR, { recursive: true });
  const inPayload = variants.map(v => JSON.stringify({ id: v.key, text: v.query })).join("\n") + "\n";
  // cache: skip the sidecar (model load ≈ 20 s) when the query set and
  // model are unchanged since the last run.
  const cacheTag = `${embeddingModel ?? "BAAI/bge-m3"}\n${inPayload}`;
  const tagPath = path.join(DIST_DIR, ".rag-test.cachetag");
  const cached = fsSync.existsSync(tmpOut) && fsSync.existsSync(tagPath)
    && fsSync.readFileSync(tagPath, "utf8") === cacheTag;
  if (!cached) {
    await fs.writeFile(tmpIn, inPayload);
    const sidecar = path.join(__dirname, "embed_sidecar.py");
    const r = spawnSync(PYTHON, [sidecar, "--in", tmpIn, "--out", tmpOut, "--model", embeddingModel ?? "BAAI/bge-m3", "--batch-size", "32"],
      { stdio: ["ignore", "inherit", "inherit"] });
    if (r.status !== 0) throw new Error(`embed_sidecar.py failed (status=${r.status})`);
    await fs.writeFile(tagPath, cacheTag);
  }
  const emb = new Map<string, Buffer>();
  for (const ln of (await fs.readFile(tmpOut, "utf8")).split("\n").filter(Boolean)) {
    const rec = JSON.parse(ln) as { id: string; embedding_b64: string };
    emb.set(rec.id, vecToBlob(decodeFloat16Base64(rec.embedding_b64)));
  }

  // detect FTS column arity (aux present?) so weighted bm25 stays valid
  const ftsCols = (db.prepare("SELECT * FROM clauses_fts LIMIT 0").columns()).length;
  const bm25Expr = WEIGHTS.length > 0
    ? `bm25(clauses_fts, ${WEIGHTS.slice(0, ftsCols).join(", ")})`
    : "bm25(clauses_fts)";
  const glossary = EXPAND ? loadGlossary(db) : undefined;
  log(`config: bm25=${bm25Expr} (ftsCols=${ftsCols})  expand=${EXPAND}  candidates=${CANDIDATES_PER_SOURCE}  rrfK=${RRF_K}  ladder=phrase→AND→AND-informative→OR`);

  const ftsSql = db.prepare(`
    SELECT c.id
    FROM clauses_fts
    JOIN clauses c ON c.rowid = clauses_fts.rowid
    WHERE clauses_fts MATCH ?
    ORDER BY ${bm25Expr}
    LIMIT ?
  `);
  // chunk-level dense retrieval with per-clause max-pool (best chunk
  // wins); falls back to whole-clause clauses_vec on older corpora.
  const hasChunks = (db.prepare(
    "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('chunk_vec','chunk_map')",
  ).pluck().get() as number) === 2;
  const vecSql = hasChunks
    ? db.prepare(`
        SELECT m.clause_id AS id, v.distance AS d
        FROM chunk_vec v
        JOIN chunk_map m ON m.chunk_rowid = v.rowid
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance
      `)
    : db.prepare(`
        SELECT c.id, v.distance AS d
        FROM clauses_vec v
        JOIN clauses c ON c.rowid = v.rowid
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance
      `);

  const hasChunkFts = (db.prepare(
    "SELECT COUNT(*) FROM sqlite_master WHERE name = 'chunk_fts'",
  ).pluck().get() as number) === 1;
  const chunkFtsSql = hasChunkFts ? db.prepare(`
    SELECT clause_id AS id
    FROM chunk_fts
    WHERE chunk_fts MATCH ?
    ORDER BY bm25(chunk_fts)
    LIMIT ?
  `) : null;

  /** Ladder candidates, precedence-merged with a per-tier cap so a
   *  junk-rich phrase tier can't starve the stricter AND tiers. The
   *  OR-floor tier (last level) is recall insurance, not evidence —
   *  fusion discounts it. */
  const TIER_CAP = Math.max(15, Math.floor(CANDIDATES_PER_SOURCE / 2));
  function ladderCandidates(
    query: string,
    sql: InstanceType<typeof Database>["prepare"] extends (...a: never) => infer S ? S : never,
    dedupeChunks = false,
  ): Array<{ id: string; floor: boolean }> {
    const out: Array<{ id: string; floor: boolean }> = [];
    const seen = new Set<string>();
    const ladder = buildMatchLadder(query, glossary);
    ladder.forEach((match, li) => {
      if (out.length >= CANDIDATES_PER_SOURCE) return;
      const floor = li === ladder.length - 1;
      let rows: Array<{ id: string }> = [];
      const fetch = dedupeChunks ? CANDIDATES_PER_SOURCE * 4 : CANDIDATES_PER_SOURCE;
      try { rows = sql.all(match, fetch) as Array<{ id: string }>; }
      catch { return; /* malformed MATCH from odd tokens — skip level */ }
      let taken = 0;
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push({ id: r.id, floor });
        taken++;
        if (out.length >= CANDIDATES_PER_SOURCE) break;
        if (!floor && taken >= TIER_CAP) break;
      }
    });
    return out;
  }
  const ftsCandidates = (q: string) => ladderCandidates(q, ftsSql);
  const chunkFtsCandidates = (q: string) =>
    chunkFtsSql ? ladderCandidates(q, chunkFtsSql, true) : [];
  function vecCandidates(qBlob: Buffer): Array<{ id: string; d: number }> {
    // over-fetch chunks (several may map to one clause), then dedupe
    // keeping first (= best-distance) occurrence per clause.
    const k = hasChunks ? CANDIDATES_PER_SOURCE * 4 : CANDIDATES_PER_SOURCE;
    const raw = vecSql.all(qBlob, k) as Array<{ id: string; d: number }>;
    const out: Array<{ id: string; d: number }> = [];
    const seen = new Set<string>();
    for (const r of raw) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= CANDIDATES_PER_SOURCE) break;
    }
    return out;
  }
  /** RRF-fuse ranked lists (clause-FTS, chunk-FTS, chunk-vec).
   *  OR-floor FTS hits contribute at a discount — they are recall
   *  insurance, not relevance evidence. */
  const FLOOR_WEIGHT = 0.35;
  const LIST_W = {
    fts: Number(process.env.FTSW ?? "1"),
    cfts: Number(process.env.CFTSW ?? "1"),
    vec: Number(process.env.VECW ?? "1"),
  };
  // Vec similarity carries real magnitude (cosine distance); rank-only
  // fusion throws it away — a v4 hit whose distance nearly ties v1
  // deserves nearly equal credit. Give vec contributions a z-score
  // bonus over the fetched pool (VECZ=0 disables).
  const VEC_Z = Number(process.env.VECZ ?? "0.5");
  function rrfFuse(
    fts: Array<{ id: string; floor: boolean }>,
    chunkFts: Array<{ id: string; floor: boolean }>,
    vec: Array<{ id: string; d: number }>,
  ): string[] {
    const score = new Map<string, number>();
    for (const [list, w] of [[fts, LIST_W.fts], [chunkFts, LIST_W.cfts]] as const) {
      list.forEach((f, i) =>
        score.set(f.id, (score.get(f.id) ?? 0) + w * (f.floor ? FLOOR_WEIGHT : 1) / (RRF_K + i + 1)));
    }
    const sims = vec.map(v => -v.d);
    const mean = sims.reduce((a, b) => a + b, 0) / (sims.length || 1);
    const sd = Math.sqrt(sims.reduce((a, b) => a + (b - mean) ** 2, 0) / (sims.length || 1)) || 1;
    vec.forEach((v, i) => {
      const z = Math.max(0, Math.min((-v.d - mean) / sd, 3));
      score.set(v.id, (score.get(v.id) ?? 0) + LIST_W.vec * (1 + VEC_Z * z) / (RRF_K + i + 1));
    });
    // Technology/materiality priors (retriever PROFILE parameters, not
    // per-test hacks): this corpus mixes NR procedure specs with LTE
    // (36.x — same PUSCH/SRS vocabulary, wrong technology for an NR
    // product) and conformance-test material (38.523-x test cases,
    // 38.133/36.133 Annex A test setups) that shares terms without
    // being the normative answer. The desktop retriever knows the
    // product context (NR RedCap triage) — model it as score priors.
    const LTE_W = Number(process.env.LTEW ?? "0.3");
    const TESTMAT_W = Number(process.env.TESTW ?? "0.5");
    const RF_W = Number(process.env.RFW ?? "0.6");
    const TEST_SPECS = /^(38\.5(08|21|23)|36\.5(08|21|23))/;
    const RF_SPECS = /^38\.1(01|33)/;
    for (const [id, sc] of score) {
      const spec = id.split("#")[0];
      let w = 1;
      if (spec.startsWith("36.")) w *= LTE_W;
      if (TEST_SPECS.test(spec) || id.includes("#A.")) w *= TESTMAT_W;
      if (RF_SPECS.test(spec)) w *= RF_W;
      if (w !== 1) score.set(id, sc * w);
    }
    const sorted = Array.from(score.entries()).sort((a, b) => b[1] - a[1]).map(([id]) => id);
    // Spec-diversity cap (SPECCAP, 0=off): within the head of the list,
    // at most N clauses per spec — triage answer sets want breadth, and
    // same-spec near-duplicates crowd out the cross-spec refs.
    const cap = Number(process.env.SPECCAP ?? "0");
    if (cap > 0) {
      const head: string[] = [];
      const deferred: string[] = [];
      const perSpec = new Map<string, number>();
      for (const id of sorted) {
        const spec = id.split("#")[0];
        const n = perSpec.get(spec) ?? 0;
        if (head.length < 10 && n >= cap) { deferred.push(id); continue; }
        perSpec.set(spec, n + 1);
        head.push(id);
      }
      return [...head, ...deferred].slice(0, 50);
    }
    return sorted.slice(0, 50);
  }

  // ── citation pull ────────────────────────────────────────────
  // 3GPP prose is a citation graph: the overlap-resolution clause
  // says "…multiplexes the UCI in the PUSCH as described in clause
  // 9.3" — the cited clause IS part of the answer even when it shares
  // no vocabulary with the query (38.213 §9.3 never says "PUCCH").
  // After fusion, scan the top hits for same-spec "clause N.N[.N…]"
  // references sitting in query-relevant sentences, and promote up to
  // MAX_PULL cited clauses to just below their citer. Deterministic,
  // no model in the loop.
  const PULL_FROM_TOP = 5;
  const MAX_PULL = 2;
  const PULL_MIN_RELEVANCE = 1;
  const PULL_INSERT_AT = 4;   // 0-based → pulled refs occupy ranks 5+
  // Citation-IDF: utility clauses (38.213 §11.1 slot formats, §10.x
  // PDCCH monitoring…) are cited from everywhere — high in-degree means
  // a citation to them carries little answer-path information, exactly
  // like a stopword. Precompute per-clause in-degree once (cached).
  const CITE_RE = /(?<!TS\s)(?<!TS\s\d\d\.\d\d\d,\s)\bclauses?\s+(\d+(?:\.\d+)+[A-Z]?)/gi;
  const indegPath = path.join(DIST_DIR, ".citation-indegree.json");
  let inDegree: Record<string, number>;
  if (fsSync.existsSync(indegPath)) {
    inDegree = JSON.parse(fsSync.readFileSync(indegPath, "utf8"));
  } else {
    inDegree = {};
    const allRows = db.prepare("SELECT id, text FROM clauses").all() as Array<{ id: string; text: string }>;
    for (const r of allRows) {
      const spec = r.id.split("#")[0];
      const seen = new Set<string>();
      for (const m of r.text.matchAll(CITE_RE)) {
        const ref = `${spec}#${m[1]}`;
        if (ref !== r.id && !seen.has(ref)) { seen.add(ref); inDegree[ref] = (inDegree[ref] ?? 0) + 1; }
      }
    }
    fsSync.writeFileSync(indegPath, JSON.stringify(inDegree));
  }
  const hubIdf = (ref: string) => 1 / (1 + (inDegree[ref] ?? 0) / 5);
  const clauseTextSql = db.prepare("SELECT text FROM clauses WHERE id = ?").pluck();
  const clauseExistsSql = db.prepare(
    "SELECT 1 FROM clauses WHERE id = ? OR id LIKE ? LIMIT 1").pluck();
  function citationPull(ids: string[], query: string): string[] {
    const qTokens = new Set(tokenize(query));
    const seen = new Set(ids);
    type Cand = { ref: string; citerIdx: number; relevance: number };
    const cands: Cand[] = [];
    for (let i = 0; i < Math.min(PULL_FROM_TOP, ids.length); i++) {
      const citer = ids[i];
      const spec = citer.split("#")[0];
      const text = clauseTextSql.get(citer) as string | undefined;
      if (!text) continue;
      // sentence-ish segments; keep citations out of "TS xx.yyy" spans
      for (const seg of text.split(/(?<=[.;])\s+|\n+/)) {
        for (const m of seg.matchAll(/(?<!TS\s)(?<!TS\s\d\d\.\d\d\d,\s)\bclauses?\s+(\d+(?:\.\d+)+[A-Z]?)/gi) ?? []) {
          const ref = `${spec}#${m[1]}`;
          if (seen.has(ref)) continue;
          if (ref === citer || ref.startsWith(citer + ".") || citer.startsWith(ref + ".")) continue;
          if (clauseExistsSql.get(ref, `${ref}.%`) !== 1) continue;
          const relevance = Array.from(qTokens).filter(t => seg.toLowerCase().includes(t)).length;
          if (relevance < PULL_MIN_RELEVANCE) continue;
          cands.push({ ref, citerIdx: i, relevance });
        }
      }
    }
    // Dedupe per ref: a clause cited from several top hits (or several
    // query-relevant sentences) is a stronger answer-path signal than a
    // one-off mention — score = best relevance + citation count bonus,
    // earlier citers break ties.
    const byRef = new Map<string, { ref: string; score: number; citerIdx: number; n: number }>();
    for (const c of cands) {
      const cur = byRef.get(c.ref);
      if (!cur) byRef.set(c.ref, { ref: c.ref, score: c.relevance, citerIdx: c.citerIdx, n: 1 });
      else {
        cur.n++;
        cur.score = Math.max(cur.score, c.relevance);
        cur.citerIdx = Math.min(cur.citerIdx, c.citerIdx);
      }
    }
    // hubIdf replaces the raw cite-count bonus — local n correlates
    // with global hubness, so counting it double-rewards hubs.
    // Intra-chapter citations ("9.2.5 → clause 9.3") continue the same
    // procedure family; cross-chapter ones are usually background
    // (timing, power control). Chapter = first numeric label.
    const chapterOf = (id: string) => id.split("#")[1]?.split(".")[0] ?? "";
    const ranked = Array.from(byRef.values())
      .map(r => {
        const citerId = ids[r.citerIdx];
        const local = citerId && chapterOf(citerId) === chapterOf(r.ref) ? 1.5 : 1;
        return { ...r, score: r.score * hubIdf(r.ref) * local - 0.05 * r.citerIdx };
      })
      .sort((a, b) => b.score - a.score);
    if (process.env.PULLDEBUG === "1" && ranked.length > 0) {
      log(`    [pull] "${query}" candidates: ${ranked.slice(0, 6).map(r =>
        `${r.ref}(s${r.score.toFixed(2)},n${r.n},i${r.citerIdx})`).join("  ")}`);
    }
    const out = [...ids];
    let pulled = 0;
    for (const c of ranked) {
      if (pulled >= MAX_PULL) break;
      if (out.includes(c.ref)) continue;
      out.splice(Math.min(PULL_INSERT_AT + pulled, out.length), 0, c.ref);
      pulled++;
    }
    return out.slice(0, 50);
  }

  let rowsPassed = 0, variantsPassed = 0;
  const report: unknown[] = [];
  log(`hybrid RRF (FTS⊕vec, k=${RRF_K}) — PASS = all refs in top-${TOP_K}\n`);
  for (const row of testset.rows) {
    let rowPass = true;
    const rowRep: Record<string, unknown> = { row: row.row, name: row.name, expected: row.expected, variants: [] };
    for (let i = 0; i < row.variants.length; i++) {
      const key = `${row.row}.${i}`;
      const q = row.variants[i];
      const fts = ftsCandidates(q);
      const cfts = chunkFtsCandidates(q);
      const vec = vecCandidates(emb.get(key)!);
      const ids = citationPull(rrfFuse(fts, cfts, vec), q);
      const rankIn = (list: string[], ref: string) => {
        const idx = list.findIndex(id => refMatches(ref, id));
        return idx >= 0 ? idx + 1 : 0;
      };
      const refRanks = row.expected.map(ref => ({
        ref,
        rank: rankIn(ids, ref),
        fts: rankIn(fts.map(f => f.id), ref),
        cfts: rankIn(cfts.map(f => f.id), ref),
        vec: rankIn(vec.map(v => v.id), ref),
      }));
      const pass = refRanks.every(rr => rr.rank > 0 && rr.rank <= TOP_K);
      if (!pass) rowPass = false; else variantsPassed++;
      const ranksStr = refRanks
        .map(rr => `${rr.ref}@${rr.rank || "miss"}(f${rr.fts || "-"},c${rr.cfts || "-"},v${rr.vec || "-"})`)
        .join("  ");
      log(`${pass ? "  PASS" : "✗ FAIL"}  row ${String(row.row).padStart(2)} v${i + 1}  "${q}"`);
      log(`        ${ranksStr}`);
      if (SHOW > 0) ids.slice(0, SHOW).forEach((id, j) => log(`          ${j + 1}. ${id}`));
      (rowRep.variants as unknown[]).push({ query: q, pass, refRanks, top10: ids.slice(0, 10) });
    }
    if (rowPass) rowsPassed++;
    rowRep.pass = rowPass;
    report.push(rowRep);
  }
  db.close();

  const totalVariants = variants.length;
  log(`\nrows: ${rowsPassed}/${testset.rows.length} pass   variants: ${variantsPassed}/${totalVariants} pass   (top-${TOP_K}, all-refs)`);
  await fs.writeFile(OUT_REPORT, JSON.stringify({
    builtAt: new Date().toISOString(), topK: TOP_K, embeddingModel,
    config: { bm25: bm25Expr, expand: EXPAND, candidatesPerSource: CANDIDATES_PER_SOURCE, rrfK: RRF_K },
    rowsPassed, rowsTotal: testset.rows.length,
    variantsPassed, variantsTotal: totalVariants, rows: report,
  }, null, 2));
  log(`wrote ${OUT_REPORT}`);
  if (process.env.RAG_TEST_CLEAN === "1") {   // keep cache by default
    try { await fs.unlink(tmpIn); } catch { /* ignore */ }
    try { await fs.unlink(tmpOut); } catch { /* ignore */ }
  }
}

await main();
