# bugzilla-triage-corpus

Offline pipeline that builds a **3GPP Release-17 NR + LTE specification corpus** — a single SQLite file with full-text (FTS5/BM25) and dense-vector (sqlite-vec / bge-m3) indexes over ~14,500 leaf clauses from 38 curated specs.

Built for [bugzilla-triage-desktop](https://github.com/mayhuifu/bugzilla-triage-desktop), but the artifact is **self-contained and app-agnostic**: any application that can open SQLite can use it as a local, offline 3GPP RAG backend. See [Use the corpus in your own app](#use-the-corpus-in-your-own-app) below.

This repo holds **only the build pipeline** — the corpus ships as a downloadable asset on this repo's GitHub Releases page.

## Use the corpus in your own app

### 1. Download & verify

Each release tag `rel17-vN` carries three assets at predictable URLs:

```
https://github.com/mayhuifu/bugzilla-triage-corpus/releases/download/<tag>/<basename>.sqlite.gz
https://github.com/mayhuifu/bugzilla-triage-corpus/releases/download/<tag>/<basename>.sha256
https://github.com/mayhuifu/bugzilla-triage-corpus/releases/download/<tag>/<basename>.manifest.json
```

```bash
TAG=rel17-v7
BASE=3gpp-corpus-rel17-v7-2026-07
curl -LO https://github.com/mayhuifu/bugzilla-triage-corpus/releases/download/$TAG/$BASE.sqlite.gz
curl -LO https://github.com/mayhuifu/bugzilla-triage-corpus/releases/download/$TAG/$BASE.sha256
shasum -a 256 -c $BASE.sha256          # verify before unpacking
gunzip $BASE.sqlite.gz                 # → ~516 MB corpus.sqlite (194 MB gz)
```

Always read the `meta` table first and honor its compatibility fields (see below) — releases can change the embedding model, and using the wrong query embedder returns silently-wrong neighbors.

### 2. Schema reference (schemaVersion 3)

| Table | What it holds |
|---|---|
| `clauses` | one row per leaf clause (incl. parent-intro clauses): `id` (`"38.213#9.2.5"`), `spec` (`"TS 38.213"`), `clause_no`, `title`, `parent_id`, `parent_title`, `path` (ancestor-title chain), `text`, `tables_json`, `figures_json`, `citation` (`"3GPP TS 38.213 §9.2.5"`), `aux` (retrieval-only enrichment: camelCase identifier splits + acronym expansions — **do not display**) |
| `clauses_fts` | FTS5 (`porter unicode61 remove_diacritics 2`) over `citation, title, parent_title, path, text, aux`; external content on `clauses`, `rowid`-joined |
| `chunk_fts` | FTS5 over ~1,600-char chunk windows (`text, clause_id`) — length-fair BM25 for long clauses; definitional 3.x clauses excluded |
| `chunk_vec` / `chunk_map` | sqlite-vec `vec0(embedding FLOAT[1024])` per chunk window + `chunk_rowid → clause_id` map |
| `clauses_vec` | one whole-clause vector per clause (L2-normalized mean of its chunks); `rowid` = `clauses.rowid` |
| `parents` / `parent_vec` | parent-clause rollup vectors (hierarchical retrieval) |
| `figure_images` | figure blobs (`clause_id, figure_id, mime_type, bytes, data`) — SVG/PNG/JPEG of captioned figures |
| `acronyms` | ~150-entry 3GPP glossary (`acronym, expansion, aliases`) for query expansion |
| `eval_queries` | the shipped retrieval eval set (used by the build gate; free to reuse) |
| `meta` | key/value contract — check before use |

Key `meta` fields:

| Key | rel17-v7 value | Contract |
|---|---|---|
| `schemaVersion` | `3` (`3-no-vec` = FTS-only build) | table shape |
| `embeddingModel` | `BAAI/bge-m3` | your query embedder **must match**, else skip vec tables |
| `embeddingDim` / `embeddingDtype` | `1024` / `float16` (stored vectors; bind queries as float32) | |
| `ftsAux` | `1` | `clauses_fts` has the 6th `aux` column (affects weighted `bm25()` arity) |

### 3. Pick an integration tier

**Tier 1 — FTS-only (zero extra dependencies).** Plain SQLite, no extensions, no embedder. Good baseline; weaker on paraphrased queries.

```python
import sqlite3
db = sqlite3.connect("corpus.sqlite")
rows = db.execute("""
  SELECT c.citation, c.title, snippet(clauses_fts, 4, '[', ']', '…', 20)
  FROM clauses_fts JOIN clauses c ON c.rowid = clauses_fts.rowid
  WHERE clauses_fts MATCH ?
  ORDER BY bm25(clauses_fts) LIMIT 10
""", ('"pucch" AND "srs"',)).fetchall()
```

**Tier 2 — hybrid (FTS + dense chunks, recommended).** Needs the [sqlite-vec](https://github.com/asg017/sqlite-vec) extension and a **bge-m3** query embedder. Embedder contract: dense output, **CLS pooling, L2-normalized**, bound as float32 blob (vectors are stored float16-derived but `vec0` compares float32); no instruction prefix.

```python
import sqlite3, sqlite_vec
from sentence_transformers import SentenceTransformer

db = sqlite3.connect("corpus.sqlite")
db.enable_load_extension(True); sqlite_vec.load(db)

assert db.execute("SELECT value FROM meta WHERE key='embeddingModel'").fetchone()[0] == "BAAI/bge-m3"
model = SentenceTransformer("BAAI/bge-m3")
q = "overlapping PUSCH and PUCCH in the same slot"
emb = model.encode(q, normalize_embeddings=True).astype("float32")

# dense: chunk-level KNN, max-pooled to clauses (keep first hit per clause)
vec_hits, seen = [], set()
for (cid,) in db.execute("""
  SELECT m.clause_id FROM chunk_vec v
  JOIN chunk_map m ON m.chunk_rowid = v.rowid
  WHERE v.embedding MATCH ? AND k = 200 ORDER BY v.distance""", (emb.tobytes(),)):
    if cid not in seen: seen.add(cid); vec_hits.append(cid)

# sparse: chunk-level BM25, same dedupe
fts_hits, seen = [], set()
for (cid,) in db.execute("""
  SELECT clause_id FROM chunk_fts WHERE chunk_fts MATCH ?
  ORDER BY bm25(chunk_fts) LIMIT 200""", (" OR ".join(f'"{t}"' for t in q.split()),)):
    if cid not in seen: seen.add(cid); fts_hits.append(cid)

# Reciprocal Rank Fusion (k=5 works well with 2 lists)
score = {}
for lst in (vec_hits[:50], fts_hits[:50]):
    for i, cid in enumerate(lst):
        score[cid] = score.get(cid, 0) + 1 / (5 + i + 1)
top = sorted(score, key=score.get, reverse=True)[:10]
texts = {cid: db.execute("SELECT citation, text FROM clauses WHERE id=?", (cid,)).fetchone() for cid in top}
```

Node.js: same shape with `better-sqlite3` + the `sqlite-vec` npm package (`sqliteVec.load(db)`); pass the query vector as a `Buffer` of float32.

**Tier 3 — full retriever v2 (what our desktop app runs).** [`scripts/retriever-v2.ts`](scripts/retriever-v2.ts) is a self-contained TypeScript module (better-sqlite3 + sqlite-vec only) implementing everything Tier 2 does **plus**: concept-group AND query ladder with acronym expansion from the `acronyms` table, weighted BM25 over the 6 FTS columns, 3-list fusion with OR-floor discounting, domain priors, and citation-graph pull (3GPP prose cites clauses that share no vocabulary with your query — "…as described in clause 9.3"). Copy the file, `createRetrieverV2(db).retrieve(query, qEmbBlob)` → ranked clause ids. Port notes for other languages: the module is ~400 lines of dependency-light logic; [docs/desktop-port-retriever-v2.md](docs/desktop-port-retriever-v2.md) documents every stage.

**Add an LLM answer/rerank stage (optional).** Hand the top 15–20 clauses (`citation` + `text`) to your generator; measured on public benchmarks, the evidence for ~91% of in-scope questions is inside the top-10 (see below), so a capable model with a wide context needs no separate reranker. If you rerank, rerank the *union* of the candidate lists, not the fused top-K, and keep citation-pull after the rerank.

### 4. What to expect (measured)

- **Tele-Eval** (open-ended telecom QA, 1,499 in-scope questions): answer-containment **82.0% @ top-5**, **91.3% @ top-10** — retrieval-only, no reranker (`npx tsx scripts/benchmark-telecom.ts --dataset teleeval`).
- Shipped eval gate: hybrid MRR@10 **0.341** vs 0.239 FTS-only baseline on the in-corpus `eval_queries` set.
- Terse acronym-pair queries ("1 PUSCH + 1 SRS") benefit most from Tier 3 + an LLM stage; see `scripts/rag-uplink-testset.json` for a hard domain test set with expected clause ids.

### 5. Rules of thumb

- Treat `aux` as index-only; render `citation`/`title`/`text` (+ `tables_json`, `figure_images`) to users.
- `clauses` contains **leaf and parent-intro** rows; an id like `38.214#6.2.1` may have children `6.2.1.1…` — match by prefix when comparing against spec citations.
- The corpus is Rel-17 frozen text. It is a **derived index** of 3GPP material — see [License](#license).

## What the pipeline does

```
scripts/curated-specs.json        ← list of 38 NR + LTE specs to index
        │
        ▼
01-fetch.ts                       ← directory-listing 3gpp.org/ftp/Specs/archive,
        │                          picking the LATEST h* (Rel-17) version per spec,
        │                          unzipping each part; legacy Word 97 .doc parts
        │                          (e.g. 38.201) auto-upgraded via libreoffice.
        ▼
raw/<spec>-<htag>[_part].docx
        │
        ▼
02-parse.ts                       ← mammoth → HTML (styleMap maps 3GPP-internal
        │                          ZA/TT/TAR/ZT styles → h2/h3 so test specs
        │                          actually surface). Leaf-clause records gain
        │                          structured tables[] + figures[] + ancestor
        │                          path[]; non-leaf clauses with substantial
        │                          intro text are emitted as clauses too.
        ▼
dist/clauses.jsonl                ← canonical JSONL (one record per clause)
        │
        ▼
embed.ts ──▶ embed_sidecar.py     ← bge-m3 (default) embeds ~1,600-char chunk
        │   (Python sentence-       windows (scripts/chunking.ts); whole-clause
        │    transformers)          vectors = normalized chunk means + parent rollups
        ▼
dist/chunks-with-vec.jsonl, clauses-with-vec.jsonl, parents-with-vec.jsonl
        │
        ▼
03-index.ts                       ← emit corpus.sqlite: FTS5 (6 cols incl. aux
        │                          enrichment), chunk_fts, chunk_vec/chunk_map,
        │                          clauses_vec, parent_vec, figure_images,
        │                          acronyms, eval_queries, meta.
        ▼
out/corpus.sqlite                 ← single-file hybrid-retrieval corpus
        │
        ▼
05-eval.ts                        ← baseline FTS5 vs retriever-v2 hybrid on the
        │                          shipped eval_queries. Build fails if lift
        │                          below target (EVAL_MIN_LIFT, default 0.08).
        ▼
04-publish.ts                     ← gzip, sha256, manifest.json, gh release
        ▼
GitHub Releases tag `rel17-vN`    ← {sqlite.gz, sha256, manifest.json}
```

## Architecture

Authoritative: [SPEC.md §14](../../../SPEC.md) (ADR-001 onward). One-paragraph summary:

The published artifact is a single `corpus.sqlite` shipping FTS5 BM25 + `sqlite-vec` dense vectors at **two granularities** (chunk + whole-clause). Consumers run hybrid retrieval in-process — no server, no daemon. Retrieval fuses three candidate lists (clause-FTS, chunk-FTS, chunk-vec) via weighted RRF, then applies a deterministic citation-graph pull. Cross-encoder/LLM reranking is a consumer-side option (the desktop app exposes it as a toggle); KG-lite entity extraction and OpenSearch/Neo4j emit remain deferred.

## Why Release-17 only?

The downstream app is used for 5G RedCap + 4G LTE silicon triage. RedCap was introduced in Rel-17; Rel-17 is the production reference for nearly all of that work. The text is frozen, the clause numbering is stable, and pinning to a single release simplifies retrieval (no version drift between point releases).

Rel-18 / Rel-19 corpora will ship as separate downloadable bundles when the engineering reality demands them.

## Prerequisites (building — not needed to consume)

| Tool | Why | Install |
|---|---|---|
| Node 22+ | TS pipeline | `nvm install 22` |
| Python 3.10+ | embedding sidecar | system or conda |
| `sentence-transformers`, `numpy` | bge-m3 inference | `pip install sentence-transformers numpy` |
| LibreOffice (`libreoffice` or `soffice`) | upgrade legacy `.doc` parts (38.201) | `brew install --cask libreoffice` |
| `gh` CLI authenticated | release upload | `brew install gh && gh auth login` |
| Disk ~3 GB | bge-m3 weights cached in `~/.cache/huggingface` | — |

## Build it yourself

```bash
npm install
npm run build         # fetch → parse → embed → index → eval
                      # First run downloads ~2 GB of bge-m3 weights;
                      # subsequent runs reuse them (HuggingFace cache).
npm run publish-corpus -- --tag rel17-v8
```

`raw/`, `dist/`, and `out/` are git-ignored — only the pipeline source lives here.

## Selective re-runs

Each stage is its own script and writes a manifest the next stage reads. To re-run a single stage:

```bash
npm run fetch                                 # just refresh raw/
npm run parse                                 # just re-parse from raw/
EMBED_MODEL=BAAI/bge-m3 npm run embed         # just re-embed dist/clauses.jsonl
npm run index                                 # just rebuild out/corpus.sqlite
npm run eval                                  # just measure precision

npm run dev:precision-check                   # tiny synthetic-fixture sanity check
npx tsx scripts/rag-test-harness.ts           # 13-row UL-coexistence retrieval test
npx tsx scripts/benchmark-telecom.ts --dataset teleeval   # public-benchmark run
```

Useful env knobs:

- `EMBED_MODEL=BAAI/bge-m3` — pick a different HF model. Output dim is auto-detected; `meta.embeddingModel` follows.
- `CHUNK_CHARS=1600` / `CHUNK_OVERLAP=200` — chunk window geometry.
- `EMBED_DEVICE=cpu|cuda|mps`, `EMBED_PY=/path/to/python`.
- `EVAL_MIN_LIFT=0.08` — precision-gate target (recalibrated when the aux column raised the BM25 baseline floor).

## Curated specs

See [scripts/curated-specs.json](scripts/curated-specs.json). Roughly:
- NR PHY/MAC/RRC: 38.101-1/2/3, 38.133, 38.201, 38.211, 38.212, 38.213, 38.214, 38.215, 38.300, 38.304, 38.306, 38.321, 38.322, 38.323, 38.331
- NR test: 38.508-1, 38.521-1/2/3, 38.523-1
- LTE PHY/MAC/RRC: 36.101, 36.133, 36.211, 36.212, 36.213, 36.214, 36.300, 36.304, 36.321, 36.331
- LTE test: 36.508, 36.521-1/2/3, 36.523-1
- NAS: 24.501

## Version history (consumer-visible)

| | v1 | v2 | **v3.x (rel17-v7)** |
|---|---|---|---|
| Retrieval | FTS5 only | + `sqlite-vec` whole-clause + RRF | + chunk-level FTS & vectors, aux enrichment, parent-intro clauses |
| Embedding | — | bge-m3 (some builds bge-small) | `bge-m3` 1024-dim over chunk windows |
| Missing content | — | non-leaf intro text dropped (e.g. 38.214 §6.2.1) | fixed (+560 clauses) |
| Figures | dropped | captions | + image blobs (`figure_images`) |
| Schema version | `1` | `2` | `3` + `meta.ftsAux=1` (additive) |
| Artifact | ~40 MB | ~250 MB | ~516 MB (194 MB gz) |

## Coordinated change in the desktop app

[docs/desktop-port-retriever-v2.md](docs/desktop-port-retriever-v2.md) is the authoritative handoff: bge-m3 query-embedder contract, retriever-v2 port checklist, AI-rerank integration rules, and publish sequencing. Compat rule stands: consumers must probe `meta.schemaVersion` / `meta.embeddingModel` / `meta.ftsAux` and degrade gracefully (FTS-only) on mismatch.

## License

The pipeline code is MIT-licensed. The 3GPP specifications themselves remain copyright 3GPP / ETSI / member organizations; this repo does not redistribute them. The published corpus is a derived index (clause text excerpts for in-app reference) — see the LICENSE-CORPUS notice attached to each release asset for terms.
