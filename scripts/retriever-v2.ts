// ─────────────────────────────────────────────────────────────────
// retriever-v2.ts — canonical hybrid retriever over out/corpus.sqlite.
//
// This is the reference implementation of the "retriever v2" design
// validated by scripts/rag-test-harness.ts, packaged for reuse by
// benchmark runners and for porting into bugzilla-triage-desktop's
// lib/corpus/retriever.ts. No LLM anywhere in the loop.
//
// Pipeline per query:
//   1. concept-group MATCH ladder (phrase → AND → AND-informative →
//      OR-floor) with acronym expansion from the corpus `acronyms`
//      table, run over BOTH clauses_fts (title/aux/citation signals)
//      and chunk_fts (length-fair text BM25)
//   2. chunk-level dense retrieval (chunk_vec, bge-m3) with
//      per-clause max-pool; falls back to clauses_vec
//   3. weighted RRF (k=5) with OR-floor discount + technology/
//      materiality priors (LTE / test-material / RF)
//   4. citation-pull: same-spec "clause N.N" refs in query-relevant
//      sentences of the top hits, hub-IDF damped, chapter-local
//      bonus, inserted from rank 5
// ─────────────────────────────────────────────────────────────────

import * as path from "node:path";
import * as fsSync from "node:fs";
import type Database from "better-sqlite3";

export interface RetrieverOpts {
  rrfK?: number;            // default 5
  candidates?: number;      // per source, default 50
  weights?: number[];       // bm25 col weights (citation,title,parent_title,path,text[,aux])
  expand?: boolean;         // acronym expansion, default true
  lteW?: number;            // LTE (36.x) prior, default 0.3
  testW?: number;           // test-material prior, default 0.5
  rfW?: number;             // RF spec prior, default 0.6
  floorW?: number;          // OR-floor discount, default 0.35
  vecZ?: number;            // vec z-score bonus, default 0.5
  listW?: { fts: number; cfts: number; vec: number };
  maxPull?: number;         // citation pulls, default 2
  indegreeCachePath?: string;
}

const STOPWORDS = new Set([
  "the","a","an","and","or","of","to","in","on","for","is","are","was","were",
  "be","been","by","with","as","at","that","this","it","its","from","into",
  "than","then","such","not","no","do","does","did","has","have","had",
]);
const GENERIC_TOKENS = new Set([
  "one","separate","same","parallel","case",
  "transmission","transmissions","resource","resources","procedure",
  "overlapping","overlap","simultaneous","cross","channel","channels",
  "uplink","downlink","slot","symbol","configured","support","supported",
]);
const COUNT_WORDS = new Set(["two", "three", "dual", "multiple"]);

export function tokenize(s: string): string[] {
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
function quote(s: string): string { return `"${s.replace(/"/g, '""')}"`; }

interface AcronymGlossary {
  byToken: Map<string, string[]>;
  byExpansionWords: Array<{ words: string[]; acronym: string }>;
}
function loadGlossary(db: Database.Database): AcronymGlossary {
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
function tokenGroup(t: string, g?: AcronymGlossary, sharedExpWords?: Set<string>): string {
  const members = new Set<string>([t]);
  if (t.includes("-")) for (const w of t.split("-")) if (w.length >= 2 && !STOPWORDS.has(w)) members.add(w);
  if (g) {
    for (const base of Array.from(members)) {
      for (const exp of g.byToken.get(base) ?? []) {
        members.add(exp);
        for (const w of tokenize(exp)) {
          if (w.length >= 6 && !GENERIC_TOKENS.has(w) && !sharedExpWords?.has(w)) members.add(w);
        }
      }
    }
  }
  return `(${Array.from(members).map(quote).join(" OR ")})`;
}
export function buildMatchLadder(query: string, g?: AcronymGlossary): string[] {
  const seq = tokenize(query);
  const tokens = Array.from(new Set(seq)).slice(0, 40);
  if (tokens.length === 0) return ['""'];
  const qJoined = tokens.join(" ");
  const extraByToken = new Map<string, string>();
  if (g) for (const { words, acronym } of g.byExpansionWords) {
    if (words.length >= 2 && qJoined.includes(words.join(" "))) {
      extraByToken.set(words[0], acronym);
    }
  }
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
  const bigrams: string[] = [];
  const inBigram = new Set<string>();
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = seq[i], b = seq[i + 1];
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
  ladder.push(buildBm25Match(query));
  return Array.from(new Set(ladder));
}

// float16 helpers (shared shape with embed.ts)
export function decodeFloat16Base64(b64: string): Float32Array {
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
export function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function createRetrieverV2(db: Database.Database, opts: RetrieverOpts = {}) {
  const RRF_K = opts.rrfK ?? 5;
  const CAND = opts.candidates ?? 50;
  const FLOOR_WEIGHT = opts.floorW ?? 0.35;
  const VEC_Z = opts.vecZ ?? 0.5;
  const LIST_W = opts.listW ?? { fts: 1, cfts: 1, vec: 1 };
  const LTE_W = opts.lteW ?? 0.3;
  const TESTMAT_W = opts.testW ?? 0.5;
  const RF_W = opts.rfW ?? 0.6;
  const MAX_PULL = opts.maxPull ?? 2;
  const WEIGHTS = opts.weights ?? [4, 8, 2, 2, 1, 5];
  const glossary = (opts.expand ?? true) ? loadGlossary(db) : undefined;

  const ftsCols = (db.prepare("SELECT * FROM clauses_fts LIMIT 0").columns()).length;
  const bm25Expr = WEIGHTS.length >= 5
    ? `bm25(clauses_fts, ${WEIGHTS.slice(0, ftsCols).join(", ")})`
    : "bm25(clauses_fts)";
  const ftsSql = db.prepare(`
    SELECT c.id FROM clauses_fts
    JOIN clauses c ON c.rowid = clauses_fts.rowid
    WHERE clauses_fts MATCH ? ORDER BY ${bm25Expr} LIMIT ?
  `);
  const hasChunks = (db.prepare(
    "SELECT COUNT(*) FROM sqlite_master WHERE name IN ('chunk_vec','chunk_map')",
  ).pluck().get() as number) === 2;
  const vecSql = hasChunks
    ? db.prepare(`
        SELECT m.clause_id AS id, v.distance AS d FROM chunk_vec v
        JOIN chunk_map m ON m.chunk_rowid = v.rowid
        WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance`)
    : db.prepare(`
        SELECT c.id, v.distance AS d FROM clauses_vec v
        JOIN clauses c ON c.rowid = v.rowid
        WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance`);
  const hasChunkFts = (db.prepare(
    "SELECT COUNT(*) FROM sqlite_master WHERE name = 'chunk_fts'",
  ).pluck().get() as number) === 1;
  const chunkFtsSql = hasChunkFts ? db.prepare(`
    SELECT clause_id AS id FROM chunk_fts
    WHERE chunk_fts MATCH ? ORDER BY bm25(chunk_fts) LIMIT ?
  `) : null;

  const TIER_CAP = Math.max(15, Math.floor(CAND / 2));
  function ladderCandidates(query: string, sql: Database.Statement, dedupeChunks = false) {
    const out: Array<{ id: string; floor: boolean }> = [];
    const seen = new Set<string>();
    const ladder = buildMatchLadder(query, glossary);
    ladder.forEach((match, li) => {
      if (out.length >= CAND) return;
      const floor = li === ladder.length - 1;
      let rows: Array<{ id: string }> = [];
      const fetch = dedupeChunks ? CAND * 4 : CAND;
      try { rows = sql.all(match, fetch) as Array<{ id: string }>; }
      catch { return; }
      let taken = 0;
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push({ id: r.id, floor });
        taken++;
        if (out.length >= CAND) break;
        if (!floor && taken >= TIER_CAP) break;
      }
    });
    return out;
  }
  function vecCandidates(qBlob: Buffer) {
    const k = hasChunks ? CAND * 4 : CAND;
    const raw = vecSql.all(qBlob, k) as Array<{ id: string; d: number }>;
    const out: Array<{ id: string; d: number }> = [];
    const seen = new Set<string>();
    for (const r of raw) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= CAND) break;
    }
    return out;
  }

  const TEST_SPECS = /^(38\.5(08|21|23)|36\.5(08|21|23))/;
  const RF_SPECS = /^38\.1(01|33)/;
  function fuse(
    fts: Array<{ id: string; floor: boolean }>,
    cfts: Array<{ id: string; floor: boolean }>,
    vec: Array<{ id: string; d: number }>,
  ): string[] {
    const score = new Map<string, number>();
    for (const [list, w] of [[fts, LIST_W.fts], [cfts, LIST_W.cfts]] as const) {
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
    for (const [id, sc] of score) {
      const spec = id.split("#")[0];
      let w = 1;
      if (spec.startsWith("36.")) w *= LTE_W;
      if (TEST_SPECS.test(spec) || id.includes("#A.")) w *= TESTMAT_W;
      if (RF_SPECS.test(spec)) w *= RF_W;
      if (w !== 1) score.set(id, sc * w);
    }
    return Array.from(score.entries()).sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, 50);
  }

  // citation pull with hub-IDF + chapter locality
  const CITE_RE = /(?<!TS\s)(?<!TS\s\d\d\.\d\d\d,\s)\bclauses?\s+(\d+(?:\.\d+)+[A-Z]?)/gi;
  const indegPath = opts.indegreeCachePath
    ?? path.join(path.dirname(String(db.name)), "..", "dist", ".citation-indegree.json");
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
    try { fsSync.writeFileSync(indegPath, JSON.stringify(inDegree)); } catch { /* best-effort cache */ }
  }
  const hubIdf = (ref: string) => 1 / (1 + (inDegree[ref] ?? 0) / 5);
  const clauseTextSql = db.prepare("SELECT text FROM clauses WHERE id = ?").pluck();
  const clauseExistsSql = db.prepare("SELECT 1 FROM clauses WHERE id = ? OR id LIKE ? LIMIT 1").pluck();
  function citationPull(ids: string[], query: string): string[] {
    if (MAX_PULL <= 0) return ids;
    const qTokens = new Set(tokenize(query));
    const seen = new Set(ids);
    const cands: Array<{ ref: string; citerIdx: number; relevance: number }> = [];
    for (let i = 0; i < Math.min(5, ids.length); i++) {
      const citer = ids[i];
      const spec = citer.split("#")[0];
      const text = clauseTextSql.get(citer) as string | undefined;
      if (!text) continue;
      for (const seg of text.split(/(?<=[.;])\s+|\n+/)) {
        for (const m of seg.matchAll(CITE_RE)) {
          const ref = `${spec}#${m[1]}`;
          if (seen.has(ref)) continue;
          if (ref === citer || ref.startsWith(citer + ".") || citer.startsWith(ref + ".")) continue;
          if (clauseExistsSql.get(ref, `${ref}.%`) !== 1) continue;
          const relevance = Array.from(qTokens).filter(t => seg.toLowerCase().includes(t)).length;
          if (relevance < 1) continue;
          cands.push({ ref, citerIdx: i, relevance });
        }
      }
    }
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
    const chapterOf = (id: string) => id.split("#")[1]?.split(".")[0] ?? "";
    const ranked = Array.from(byRef.values())
      .map(r => {
        const citerId = ids[r.citerIdx];
        const local = citerId && chapterOf(citerId) === chapterOf(r.ref) ? 1.5 : 1;
        return { ...r, score: r.score * hubIdf(r.ref) * local - 0.05 * r.citerIdx };
      })
      .sort((a, b) => b.score - a.score);
    const out = [...ids];
    let pulled = 0;
    for (const c of ranked) {
      if (pulled >= MAX_PULL) break;
      if (out.includes(c.ref)) continue;
      out.splice(Math.min(4 + pulled, out.length), 0, c.ref);
      pulled++;
    }
    return out.slice(0, 50);
  }

  return {
    hasChunks,
    hasChunkFts,
    bm25Expr,
    retrieve(query: string, qEmb: Buffer): string[] {
      const fts = ladderCandidates(query, ftsSql);
      const cfts = chunkFtsSql ? ladderCandidates(query, chunkFtsSql, true) : [];
      const vec = vecCandidates(qEmb);
      return citationPull(fuse(fts, cfts, vec), query);
    },
  };
}
