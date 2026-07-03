# Desktop port: retriever v2 + bge-m3 query embedder + AI rerank

Handoff contract for `bugzilla-triage-desktop` to consume the next corpus
release (`rel17-v7`, bge-m3 chunked). Decided 2026-07: corpus **stays
bge-m3**; the desktop updates its query embedder to match (option
"bge-small rebuild" rejected).

## 1. Corpus deltas vs rel17-v6 (all additive, schemaVersion stays "3")

| What | Detail |
|---|---|
| +560 clauses | parent-intro clauses (e.g. `38.214#6.2.1` now exists with the full SRS collision rules — was missing entirely) |
| `clauses.aux` column | retrieval-only enrichment (camelCase identifier splits + doc-side acronym expansions). NOT for display. |
| `clauses_fts` | now 6 columns: `citation, title, parent_title, path, text, aux` (aux LAST → old unweighted `bm25(clauses_fts)` and column-less MATCH keep working). `meta.ftsAux = "1"` advertises this. |
| `chunk_fts` | FTS5 over ~1600-char chunk windows (`text, clause_id UNINDEXED`) — length-fair BM25 for long clauses. Definitional clauses (3.x Abbreviations…) excluded. |
| `chunk_vec` + `chunk_map` | vec0 chunk vectors (bge-m3) + `chunk_rowid → clause_id` map. `clauses_vec` (whole-clause rollup = normalized mean of chunks) kept for old readers. |
| `meta.embeddingModel` | **`BAAI/bge-m3`**, `embeddingDim=1024`, `embeddingDtype=float16` — the desktop's compatibility check WILL trip on this until the embedder is updated (falls back to BM25-only). Do not ship v7 to users before the embedder lands. |

## 2. Query embedder contract (bge-m3)

- Model: `BAAI/bge-m3`, dense output only (no sparse/colbert heads needed).
- Pooling: **CLS token**, then **L2-normalize**. (Corpus vectors are
  normalized; `vec0` distance is L2, which rank-orders identically to
  cosine only for normalized vectors.)
- Query goes in as plain text, no instruction prefix (bge-m3 is
  instruction-free). Truncation at 512 tokens is fine for queries.
- Bind as float32 blob (`Float32Array` → Buffer) for `embedding MATCH ?`.
- Runtime options for Electron, by preference:
  1. onnxruntime-node + int8-quantized ONNX export (~600 MB, lazy-download
     on first use; cache under app data)
  2. GGUF via llama.cpp embedding (Q8 ~640 MB) if the app already ships
     llama.cpp
- Hard-fail rule stays: if bundled embedder ≠ `meta.embeddingModel`,
  disable dense + chunk_vec paths, log loudly, use FTS-only.

## 3. Retriever v2 port

Reference implementation: `scripts/retriever-v2.ts` in this repo
(better-sqlite3 + sqlite-vec only — lifts nearly verbatim).
Validated config (defaults in the module):

- concept-group MATCH ladder (phrase → AND → AND-informative → OR-floor)
  built with the corpus `acronyms` table (query expansion + reverse
  acronym mapping + count-word collocations)
- 3 candidate lists: `clauses_fts` ladder (weighted
  `bm25(clauses_fts, 4,8,2,2,1,5)`), `chunk_fts` ladder (per-clause
  best-chunk dedupe), `chunk_vec` k=200 → per-clause max-pool top-50
- weighted RRF k=5, OR-floor discount 0.35, vec z-score bonus 0.5
- scope priors (profile parameters, tune per product): LTE 36.x ×0.3,
  test-material (x.5xx specs, `#A.` annexes) ×0.5, RF (38.101/133) ×0.6
- citation-pull AFTER fusion (and AFTER rerank if enabled): same-spec
  "clause N.N" refs in query-relevant sentences of top-5 hits, hub-IDF
  damped (in-degree cache), ×1.5 same-chapter bonus, ≤2 pulls inserted
  from rank 5

## 4. AI-rerank toggle integration (already exists in desktop)

- Feed it the **union of the three candidate lists** (~100–150 clauses),
  NOT the fused top-K — fusion loses list-specific hits the LLM can save.
- Per candidate: id + its best-matching chunk (~300 tokens) — for long
  clauses the head is boilerplate; `chunk_fts`/`chunk_map` identify the
  matching window.
- One listwise call: temperature 0, ids-only structured output, fused
  order as fallback on failure/offline.
- Run citation-pull after rerank (cited clauses share no vocabulary with
  the query; rerankers bury them).
- Even without rerank: widen the context handoff to the triage model to
  top-15/20 (Tele-Eval answer-containment measured 82%@5 → 91.3%@10).

## 5. Publish sequencing

1. Desktop: bge-m3 embedder + retriever-v2 port behind a corpus-version
   check (`meta.ftsAux`/`chunk_fts` presence probes are in retriever-v2).
2. This repo: `npm run publish-corpus -- --tag rel17-v7`.
3. Desktop release that requires ≥ v7 ships after both.

## 6. Validation

- This repo: `npx tsx scripts/rag-test-harness.ts` (13-row uplink test,
  4/13 rows at top-5 without rerank; pool-recall analysis in
  `dist/rag-test-report.json`), `npx tsx scripts/benchmark-telecom.ts
  --dataset teleeval|teleqna` (Tele-Eval 82.0%@5 / 91.3%@10 containment,
  n=1499).
- Desktop after port: re-run the same 13 queries through the app with
  rerank ON; expect ~11–12/13 (row 20 `4.2.21.1` remains pool-limited —
  needs "RedCap" in query context).
