# bugzilla-triage-corpus

Offline pipeline that builds a **3GPP Release-17 NR + LTE specification corpus** consumed by [bugzilla-triage-desktop](https://github.com/mayhuifu/bugzilla-triage-desktop) for in-app spec retrieval, and (longer term) by the §6 server platform described in [SPEC.md](../../../SPEC.md).

This repo holds **only the build pipeline** — the corpus itself ships as a downloadable asset on this repo's GitHub Releases page. The desktop app downloads the latest `*.sqlite.gz` on first run after the user opts in via Settings → Spec Corpus.

## What the pipeline does (v2)

```
scripts/curated-specs.json        ← list of ~35 NR + LTE specs to index
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
        │                          actually surface). Per-leaf records gain
        │                          structured tables[] + figures[] + ancestor
        │                          path[].
        ▼
dist/clauses.jsonl                ← canonical JSONL (one record per leaf clause)
dist/clauses.json                 ← legacy mirror for back-compat
        │
        ▼
embed.ts ──▶ embed_sidecar.py     ← bge-m3 (default) computes 1024-dim float16
        │   (Python sentence-       vectors per clause + parent rollups
        │    transformers)
        ▼
dist/clauses-with-vec.jsonl
dist/parents-with-vec.jsonl
        │
        ▼
03-index.ts                       ← emit corpus.sqlite with FTS5 (BM25 over
        │                          citation/title/parent_title/path/text) +
        │                          sqlite-vec virtual tables for hybrid +
        │                          acronyms + eval_queries + meta.
        ▼
out/corpus.sqlite                 ← single-file hybrid-retrieval corpus
        │
        ▼
05-eval.ts                        ← measure baseline FTS5 vs hybrid RRF on
        │                          the eval_queries set shipped inside the
        │                          SQLite. Build fails if hybrid lift below
        │                          target (EVAL_MIN_LIFT, default 0.15 MRR@10).
        ▼
04-publish.ts                     ← gzip, sha256, write manifest.json,
        │                          gh release upload
        ▼
GitHub Releases tag `rel17-vN`    ← {sqlite.gz, sha256, manifest.json}
```

## Architecture

Authoritative: [SPEC.md §14](../../../SPEC.md) (ADR-001 through ADR-008). One-paragraph summary:

The published artifact is a single `corpus.sqlite` file shipping FTS5 BM25 + `sqlite-vec` dense vectors. The desktop app runs hybrid retrieval (BM25 ⊕ cosine, fused via Reciprocal Rank Fusion in a single SQL CTE) in-process — no external server, no daemon. Build time uses `bge-m3` (1024-dim) for embeddings. Cross-encoder reranking, KG-lite entity extraction, and OpenSearch / Neo4j emit are explicitly deferred (v3).

## Why Release-17 only?

The downstream app is used for 5G RedCap + 4G LTE silicon triage. RedCap was introduced in Rel-17; Rel-17 is the production reference for nearly all of that work. The text is frozen, the clause numbering is stable, and pinning to a single release simplifies retrieval (no version drift between point releases).

Rel-18 / Rel-19 corpora will ship as separate downloadable bundles when the engineering reality demands them.

## Prerequisites

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
npm run publish-corpus -- --tag rel17-v2
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
                                              # (does not require fetched specs)
```

Useful env knobs:

- `EMBED_MODEL=BAAI/bge-m3` — pick a different HF model. Output dim is auto-detected.
- `EMBED_DEVICE=cpu|cuda|mps` — force device.
- `EMBED_PY=/path/to/python` — pin a specific Python interpreter (default `python3`).
- `EVAL_MIN_LIFT=0.10` — soften the precision gate during eval-set bootstrapping.

## Curated specs

See [scripts/curated-specs.json](scripts/curated-specs.json). Roughly:
- NR PHY/MAC/RRC: 38.101-1/2/3, 38.201, 38.211, 38.212, 38.213, 38.214, 38.215, 38.300, 38.321, 38.322, 38.323, 38.331
- NR test: 38.508-1, 38.521-1/2/3, 38.523-1
- LTE PHY/MAC/RRC: 36.101, 36.211, 36.212, 36.213, 36.214, 36.300, 36.321, 36.331
- LTE test: 36.508, 36.521-1/2/3, 36.523-1

NAS specs (TS 24.501, TS 24.301) are referenced in [SPEC.md](../../../SPEC.md) §4.4 but out of scope for v2 (different 3GPP series fetch path).

## v2 vs v1

| | v1 (`rel17-v1`) | v2 (`rel17-v2`) |
|---|---|---|
| Retrieval | FTS5 BM25 only | FTS5 BM25 + `sqlite-vec` dense + RRF |
| Embedding | — | `bge-m3` 1024-dim, float16 |
| Test-spec coverage | ~5 front-matter clauses each | hundreds (mammoth styleMap) |
| `38.201` | excluded (legacy `.doc`) | included (libreoffice fallback) |
| Tables | flattened to text | structured `tables[]` + flattened text |
| Figures | dropped | captured as `figures[]` references |
| Hierarchy | parent_title only | parent_title + ancestor path indexed in FTS5 |
| Acronyms | — | ~150-entry table for query-time expansion |
| Eval | parse-time golden snippets only | retrieval eval set + build-gate |
| Artifact | ~40 MB / ~10 MB gz | target ≤ 100 MB / ≤ 40 MB gz |
| Schema version | `1` | `2` (or `2-no-vec` if embed skipped) |

## Coordinated change in the desktop app

The schema bump requires a paired PR in [bugzilla-triage-desktop](https://github.com/mayhuifu/bugzilla-triage-desktop):

- `lib/corpus/retriever.ts` — switch from OR-of-terms BM25 to the hybrid RRF SQL CTE. Bundle a small ONNX in the same embedding space as `meta.embeddingModel`. Add acronym expansion over the query using the corpus's `acronyms` table.
- Compat path — if `meta.schemaVersion` is missing or `1`, fall back to legacy BM25-only retrieval so older corpus downloads still work.

## License

The pipeline code is MIT-licensed. The 3GPP specifications themselves remain copyright 3GPP / ETSI / member organizations; this repo does not redistribute them. The published corpus is a derived index (clause text excerpts for in-app reference) — see the LICENSE-CORPUS notice attached to each release asset for terms.
