# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

An **offline build pipeline only**, not a runtime application. It produces a single SQLite file (`corpus.sqlite`) containing leaf clauses from ~35 curated 3GPP Rel-17 NR + LTE specifications, indexed with FTS5/BM25. The artifact ships as a GitHub Release asset and is downloaded at runtime by the separate [bugzilla-triage-desktop](https://github.com/mayhuifu/bugzilla-triage-desktop) app.

Source files live in `scripts/`. There is no `src/` and no compile step — TypeScript runs directly via `tsx` (`tsconfig.json` has `noEmit: true`).

## Commands

```bash
npm install
npm run fetch           # scripts/01-fetch.ts   → raw/<stem>-<htag>.docx + raw/fetch-manifest.json
npm run parse           # scripts/02-parse.ts   → dist/clauses.json + dist/parse-report.json
npm run index           # scripts/03-index.ts   → out/corpus.sqlite (also validates golden snippets)
npm run publish-corpus -- --tag rel17-vN [--draft]   # scripts/04-publish.ts → gzip, sha256, gh release

npm run build           # fetch → parse → index, end to end (~10 min on broadband)
npm run dry-run         # DRY_RUN=1 fetch (URL discovery only) + DRY_RUN=1 parse + index
```

`DRY_RUN=1` on fetch skips downloads but still writes the manifest with discovered URLs. `DRY_RUN=1` is also honored by parse for symmetry. There is no test runner — validation is the golden-snippet check inside `03-index.ts`.

Pipeline outputs live in `raw/`, `dist/`, `out/` — all gitignored. Always regenerate; there is no incremental build.

## Pipeline architecture

The four stages are **strictly sequential and each writes a manifest** that the next stage reads. Don't refactor them into a single pass — the manifests are how you debug a bad corpus (you can stop after 01 to inspect what got fetched, or after 02 to inspect parsed clauses without re-fetching).

| Stage | Input | Output | Notes |
|---|---|---|---|
| `01-fetch.ts` | `scripts/curated-specs.json` | `raw/*.docx` + `raw/fetch-manifest.json` | HTTP `GET` of 3GPP Apache directory listings, pick latest Rel-17 (`h*`) ZIP per spec, unzip the DOCX |
| `02-parse.ts` | `raw/fetch-manifest.json` + DOCX files | `dist/clauses.json` + `dist/parse-report.json` | mammoth → HTML → leaf-clause split |
| `03-index.ts` | `dist/clauses.json` + `scripts/golden-clauses.json` | `out/corpus.sqlite` | SQLite + FTS5; validates parse quality |
| `04-publish.ts` | `out/corpus.sqlite` | gzipped artifact + `.sha256` + `.manifest.json` uploaded to a GH Release | Requires `gh auth status` OK |

## Non-obvious things to know before editing

**The SQLite schema is a cross-repo contract.** Tables `clauses`, `clauses_fts`, `meta` and their columns are consumed by `lib/corpus/retriever.ts` in `bugzilla-triage-desktop`. Changing column names, the FTS5 tokenizer (`porter unicode61 remove_diacritics 2`), or `schemaVersion` requires a coordinated change there. The `meta.schemaVersion` value is what the desktop app reads to decide compatibility.

**3GPP filename convention drives the fetcher.** A spec like `38.211` lives at `https://www.3gpp.org/ftp/Specs/archive/38_series/38.211/` and ships as `38211-<version>.zip`. The version is 3 base-36 chars: `<major><technical><editorial>`, where `h` = release 17. So `38211-h70.zip` is TS 38.211 v17.7.0. `01-fetch.ts` lexically sorts base-36 tags to pick the latest — this works because `0-9 < a-z` in ASCII. Apache 403s the default Node fetch UA, so the script spoofs a Firefox UA.

**Multi-part DOCXes.** Large specs (e.g. 36.211, 38.101-1) ship as several DOCX files inside one ZIP: a `_cover.docx` plus section parts like `_s00-s05.docx`, `_s06-s08.docx`, `_sAnnexes.docx`. `01-fetch.ts` skips the cover, sorts the rest lexically, and writes each part separately under `raw/`. `02-parse.ts` concatenates the mammoth HTML output of all parts in that order before running the heading splitter. The `parts: string[]` field in `fetch-manifest.json` is the source of truth for which files belong to a spec.

**The parser is heading-aware but clause-numbering-driven.** `02-parse.ts` uses mammoth's `<h1>..<h6>` markers only to find candidate headings. Whether a clause is a leaf (and what its parent is) is determined by the **numeric prefix depth** (`6.1.4` vs `6.1.4.1`), not by the HTML heading level — because 3GPP DOCXes are inconsistent about heading levels but rigorous about numbering. Front-matter is dropped by locating clause "1 Scope" and slicing.

**Two known parse gaps (documented v1 limitations):**
- `38.201` ships as a legacy `.doc` (Word 97 Composite Document) under a `.docx` extension; mammoth can't read it. The fetcher does retrieve it, but parse produces zero clauses. A v2 candidate is shelling out to `libreoffice --headless --convert-to docx`.
- Test specs (`38.508-1`, `38.521-*`, `36.508`, `36.521-*`, `36.523-1`) yield only ~5 front-matter clauses each because their test-case headings use 3GPP paragraph styles (`ZA`, `TT`, `TAR`, `ZT`) that mammoth doesn't map to `<hN>`. Fix is a mammoth `styleMap` for these styles.

**Golden-snippet validation is a soft fail.** `03-index.ts` checks each entry in `scripts/golden-clauses.json` exists as a clause with the expected substring (case-insensitive) in its text. Failures set `process.exitCode = 2` but the SQLite file is still written. Treat regressions here as a parse bug, not a flaky test — golden IDs were curated against real leaf clauses after the v1 run. When changing the parser, expect to update goldens only if you've verified the new clause text against the source DOCX.

**Publish-tag pattern is enforced.** `04-publish.ts` rejects any `--tag` not matching `/^rel\d+-v\d+$/i` (e.g. `rel17-v1`, `rel18-v3`). The release is idempotent: if the tag already exists it uses `gh release upload --clobber`; otherwise it creates a new release with auto-generated notes. The downstream desktop app finds the artifact at a predictable URL: `https://github.com/<owner>/<repo>/releases/download/<tag>/<basename>.sqlite.gz`.

## When to bump what

- Adding/removing a spec → edit `scripts/curated-specs.json` only.
- Changing parse output shape → bump `meta.schemaVersion` in `03-index.ts` and coordinate with `bugzilla-triage-desktop/lib/corpus/retriever.ts`.
- Re-publishing a corpus that's already shipped → bump the patch number in the tag (`rel17-v1` → `rel17-v2`); don't reuse a tag for content that changed unless it's the same calendar build.

## v2 architecture (current)

The build pipeline gained three stages between parse and index — see [SPEC.md §14](../../../SPEC.md) for the authoritative ADRs (ADR-001 through ADR-008). One-paragraph summary follows; details live in those ADRs.

**Hybrid retrieval inside SQLite.** v2 keeps SQLite as the single shipped artifact (no OpenSearch / Neo4j at runtime — those are deferred to the §6 platform). The artifact carries both `clauses_fts` (FTS5 BM25, kept from v1) and `clauses_vec` / `parent_vec` (sqlite-vec dense vectors, new). Retrieval fuses BM25 + cosine via Reciprocal Rank Fusion in a single SQL CTE. Cross-encoder reranking is explicitly deferred to v3.

**`sqlite-vec` rowid binding gotcha.** better-sqlite3 binds JS `Number` as SQLite `REAL` by default, which sqlite-vec rejects with `Only integers are allows for primary key values`. Always pass rowids as `BigInt`:

```typescript
const rid = getRowid.get(c.id);             // .pluck()'d
const rowid = typeof rid === "bigint" ? rid : BigInt(rid as number);
insertVec.run(rowid, vecToBlob(v));
```

`scripts/dev-precision-check.ts` is the canonical reference for the binding pattern + the RRF CTE shape.

**Python sidecar.** Embeddings are computed by `scripts/embed_sidecar.py` (sentence-transformers + bge-m3 by default). `scripts/embed.ts` orchestrates the subprocess and writes float16-base64 records to `dist/clauses-with-vec.jsonl` + `dist/parents-with-vec.jsonl`. Override the model with `EMBED_MODEL=` env. Don't try to embed in pure Node unless you've found a working bge-m3 ONNX — the sidecar pattern is intentionally swap-friendly.

**Build gate (`05-eval.ts`).** When `eval_queries` is populated, the build measures baseline FTS5 BM25 vs hybrid RRF on the same query set and exits non-zero if the MRR@10 lift falls below `EVAL_MIN_LIFT` (default 0.15). Until the user populates `scripts/eval-queries.json` the gate is a no-op (exit 0) — see Phase B.5 of the plan.

**Schema contract with the desktop app.** `meta.schemaVersion = "3"` (or `"3-no-vec"` if embeddings are absent). Bumped from `"2"` for Phase 1 — additive only, so older desktops that hard-coded a v2 read still work (the new column and new table are silently ignored). Consumers MUST read this to decide which retrieval + figure-rendering path to use. `meta.embeddingModel` / `embeddingDim` / `embeddingDtype` describe the vector format so the desktop's bundled query-time embedder can hard-fail on mismatch instead of returning silently-wrong results.

**Schema additions to remember.** `clauses` gained `path TEXT`, `tables_json TEXT`, `figures_json TEXT`, `mentions_json TEXT`. FTS5 widened to index `parent_title` and `path` alongside `citation` / `title` / `text`. New tables: `clauses_vec`, `parents`, `parent_vec`, `acronyms`, `eval_queries`. **v3 (Phase 1) adds**: new table `figure_images(clause_id, figure_id, mime_type, bytes, data BLOB)` carrying SVG/PNG/JPEG bytes of captioned figures; `figures_json` entries gain a `mediaFilename` field linking each caption to its image blob. See `SPEC.md` ADR-009 for the full contract.

**Figure pipeline (Phase 1).** `02-parse.ts` passes mammoth a `convertImage` callback that writes every embedded image to `dist/media/<spec>/<spec>-image-N.<ext>` and emits a `<img data-media-filename="…">` placeholder in the HTML (no base64 → no HTML bloat). The figure-extraction pass pairs each `Figure N:` caption with the nearest unclaimed `<img>` (± 3 paragraph window, 3GPP convention is "image immediately before caption"). After pairing, files NOT referenced by any figure are deleted from disk (this drops the ~1 000 inline-equation WMFs/spec that Word emits as images). Remaining WMF/EMF are batch-converted to SVG via `soffice --headless --convert-to svg` (~1 invocation per spec, ~5 s per figure). `03-index.ts` reads each surviving media file as a BLOB and inserts it into `figure_images`.

**Parse-gap fixes.** `01-fetch.ts` detects Word 97 Composite Document magic (`D0 CF 11 E0 A1 B1 1A E1`) and shells out to `libreoffice --headless --convert-to docx` to upgrade legacy parts in-place. `02-parse.ts` passes mammoth a `styleMap` mapping `ZA`/`ZB`/`TT`/`TAR`/`TF`/`ZT` to `<hN>` so test-spec headings stop disappearing as bare `<p>`. Don't remove the styleMap to "clean up" — it's load-bearing for half a dozen specs.

**Dev loop.** `npm run dev:precision-check` runs the synthetic-fixture micro-eval (~10 s after first run; first run takes ~25 min downloading bge-m3). Use it as a smoke test whenever you touch `embed.ts`, the RRF CTE, or anything in sqlite-vec wiring. The fixture is intentionally small but deterministic.
