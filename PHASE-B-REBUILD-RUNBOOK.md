# Phase B (rel17-v6 + desktop v0.5.6) — rebuild & ship runbook

> The Phase B **implementation is complete + validated** (parser swap on a
> subset; caption script + schema v4 + build wiring exercised). The actual
> production rebuild + VLM captioning + publish must run on a machine with an
> Anthropic API key and ~1hr+ of compute — the agent sandbox can't (api.anthropic.com
> is blocked there, the 35-spec Docling parse is slow, the embed env isn't set up).
> This is the one-time runbook to finish the ship.

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

## Build
```bash
cd bugzilla-triage-corpus
export DOCLING_PYTHON=$PWD/.venv-docling/bin/python
export EMBED_MODEL=BAAI/bge-small-en-v1.5
export CAPTION_MODEL=claude-3-5-sonnet-latest

# raw/ already fetched? skip fetch. Otherwise: npm run fetch
npm run parse          # ~1hr+ — big RF specs (36.300 10MB, 36.133, 38.101-1) are slow
CAPTION_BUDGET=20 npm run caption   # TRIAL first: caption 20 figures, eyeball quality + cost
npm run caption        # full run: 1148 figures (cached by image hash; re-runs cheap)
npm run embed          # bge-small over all clauses (captions now in text → embedded)
npm run index          # schema 4 corpus.sqlite (+ figure_images blobs)
npm run eval           # gate: figure/table-answer stratum recall should rise
```
Tip: validate a subset first — `SPEC_FILTER=38.215,38.304 npm run parse` (merges
into existing output; `02-parse.ts` supports it).

## Verify before publish
- `meta.schemaVersion = "4"`, `meta.parser = "docling"`, `meta.vlmCaptionModel` set.
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
