# Phase B (rel17-v6 + desktop v0.5.6) — rebuild & ship runbook

> The Phase B **implementation is complete + the full pipeline is validated
> end-to-end** — parse → embed → index was run in the sandbox on a 2-spec subset
> (38.215 + 38.304) and produced a queryable **schema-4** corpus: 105 clauses,
> 105 bge-small vectors, parent rollups, a figure-image blob, working vec-KNN +
> FTS. Only two things can't run in the sandbox: **VLM captioning** (api.anthropic.com
> blocked + no key) and the **full 35-spec parse** (big RF specs exceed the
> sandbox's background-job time limit). Both work on a normal machine. This is
> the one-time runbook to finish the ship.
>
> **Footgun fixed (caught by the e2e):** `embed` now writes `dist/embed-meta.json`
> and `index` reads it for `meta.embeddingModel`, so the stamped model always
> matches the vectors even if you forget `EMBED_MODEL` on the `index` step. Still
> `export EMBED_MODEL=BAAI/bge-small-en-v1.5` (below) — belt and suspenders;
> a wrong value silently drops the desktop to BM25.

## What changed (committed)
- `scripts/parse_sidecar.py` — Docling DOCX → element-stream sidecar.
- `scripts/02-parse.ts` — extractor swapped mammoth → Docling (leaf-clause logic
  unchanged; clean table cells; PNG figures; WMF→SVG path removed).
- `scripts/caption-figures.ts` — VLM figure captioning (new build step).
- `scripts/03-index.ts` — schemaVersion "4"; records `parser`=docling +
  `vlmCaptionModel`/`vlmCaptionCount` in `meta`. Captions ride in `text`
  (→ FTS5 + embeddings) and `figures_json[].vlmCaption` (→ display) — additive.
- `package.json` — `build` = fetch → parse → **caption** → embed → index → eval.
- Desktop: `SUPPORTED_SCHEMA_VERSIONS` += 4; `ClauseFigure.vlmCaption` +
  SpecDrawer renders it.

## Prerequisites (build machine)
1. **Docling venv**: `uv venv --python 3.12 .venv-docling && uv pip install --python .venv-docling docling`
2. **Embed env** (same as rel17-v5): a Python with `sentence-transformers`; the
   embed sidecar uses `EMBED_MODEL=BAAI/bge-small-en-v1.5` (384-dim — MUST match
   the desktop's bundled embedder; do NOT revert to bge-m3).
3. `ANTHROPIC_API_KEY` set (for captioning). Optional `CAPTION_MODEL` (default
   `claude-3-5-sonnet-latest`).
4. `gh auth status` OK (publish). LibreOffice still needed by 01-fetch for the
   legacy 38.201 `.doc` upgrade (not for figures anymore).

## VLM captioning is OPTIONAL (read this first)

The 3GPP `Figure N:` caption AND the prose around the figure are already in the
clause `text` (→ FTS5 + embeddings), so **figures are already searchable by their
spec caption + context with NO VLM** (verified: `38.304#5.2.2` text contains
"Figure 5.2.2-1 shows the states and state transitions…"). VLM captions only add
recall for *purely visual* content the label/prose omits — an unproven,
incremental benefit. **Default: build rel17-v6 spec-caption-only (no API key, no
cost).** Enable VLM later only if the figure-table eval stratum shows a gap
(set `ANTHROPIC_API_KEY`, or pre-supply captions via `dist/caption-overrides.json`
keyed by figure id — the "Claude Code as VLM" path).

## Build
```bash
cd bugzilla-triage-corpus
export DOCLING_PYTHON=$PWD/.venv-docling/bin/python
export EMBED_MODEL=BAAI/bge-small-en-v1.5   # MUST match the desktop's bundled embedder

# raw/ already fetched? skip fetch. Otherwise: npm run fetch
npm run parse          # ~1hr+ — big RF specs (36.300 10MB, 36.133, 38.101-1) are slow
npm run caption        # no-op without ANTHROPIC_API_KEY/overrides → spec-caption-only (default)
npm run embed          # bge-small over all clauses (spec captions already in text → embedded)
npm run index          # schema 4 corpus.sqlite (+ figure_images blobs)
npm run eval           # gate: compare figure/table-answer stratum vs rel17-v5
```
Or just `npm run build` (chains all of the above). To A/B VLM captions later:
`CAPTION_BUDGET=20 ANTHROPIC_API_KEY=… npm run caption` (trial 20, eyeball
quality), then re-`embed`/`index`/`eval` and keep them only if the stratum rises.
Tip: validate a subset first — `SPEC_FILTER=38.215,38.304 npm run parse`.

## Verify before publish
- `meta.schemaVersion = "4"`, `meta.parser = "docling"`, `meta.embeddingModel =
  "BAAI/bge-small-en-v1.5"` (NOT bge-m3 — else desktop drops to BM25).
  `meta.vlmCaptionModel` only present if you opted into VLM (optional).
- Goldens pass in `npm run index` (update `golden-clauses.json` only if a snippet
  legitimately moved — Docling text differs slightly from mammoth).
- Clause counts per spec sane vs rel17-v5 parse-report (esp. test specs — Docling
  may recover the `ZA/TT/TAR`-styled headings mammoth missed; that's a bonus, but
  those stay DEMOTED at query time per Phase A).
- `05-eval.ts`: the `feature:"figure-table"` eval queries (already in
  `eval-queries.json`) should improve.

## Publish + desktop v0.5.6
```bash
npm run publish-corpus -- --tag rel17-v6
```
Then in bugzilla-triage-desktop:
- `lib/settings.ts`: `DEFAULT_CORPUS_MANIFEST_URL` → rel17-v6; add rel17-v5 to
  `LEGACY_DEFAULT_CORPUS_MANIFEST_URLS`.
- (already done) `SUPPORTED_SCHEMA_VERSIONS` includes 4; SpecDrawer renders
  `vlmCaption`. Verify the lookup route passes `vlmCaption` through figures_json.
- Bump `package.json` → 0.5.6; RELEASES.md entry; commit; tag `v0.5.6`; CI;
  publish; **Windows smoke test** (download rel17-v6, confirm hybridActive, figures
  render with VLM captions, test specs stay demoted).

## Open item flagged by the spike
`38.213#10.1` (PDCCH-monitoring preamble: aggregation-level / search-space-candidate
definitions) is ABSENT from the corpus — only `10.1.1` survived. Check whether
Docling recovers it in the rel17-v6 parse; if so, eval-query qid 16's expected
clause can be tightened.
