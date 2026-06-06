# Phase B (v0.5.6) — parser decision + spike results

> **Status: SHELVED (2026-06).** The full rel17-v6 Docling build proved Docling
> is too slow/unreliable at scale: **4 normative specs timed out at 60 min and
> produced 0 clauses** — `36.331` (LTE RRC), `36.300` (LTE arch), `38.212` (NR
> coding/DCI), `38.214` (NR PHY procedures) — while `38.523-1` (NR conformance
> TEST, which we demote anyway) ballooned 930→3804. Net clause count (13,166 vs
> v5's 12,930) masked the loss. Verdict: **stay on rel17-v5 (mammoth); do NOT
> publish v6.** The figure-search win was already free in v5 (spec captions in
> indexed text), so the parser swap had little upside and real downside.
> If ever revived: needs a **Docling→mammoth per-spec fallback** (on timeout/0
> clauses, re-run that spec through mammoth) — see the "VERDICT" note at the
> bottom. The parser-swap code lives on branch `phase-b-docling-parse` (unmerged).
>
> _(original spike notes below — Docling's table/figure quality was good; the
> killer was per-spec runtime on 36.331/36.300/38.212/38.214.)_

## Decision: **Docling** (not MinerU)

The plan's step-1 decision gate ("spike MinerU vs Docling, pick the one that
keeps leaf-clause numbering AND improves tables/figures"). Resolved to **Docling**.

**Why Docling, and why not a full MinerU spike:**
- Our source is clean **DOCX**. Docling parses DOCX natively → preserves the
  3GPP clause-number headings the leaf-clause logic depends on. MinerU is
  **PDF-oriented + heavy** (needs DOCX→PDF via libreoffice, then ML layout
  models, GPU strongly preferred) — and PDF layout parsing would *fight* to
  recover the clause numbering DOCX gives us for free. Wrong tool for a
  DOCX corpus + an offline/CI build.
- Docling install is light enough (python3.12 venv via `uv`, **no GPU**) and
  fast (~3–10 s/spec part).

## Spike evidence (run in /tmp/docling-venv, py3.12)

| Spec | convert | headings (numbered) | tables | figures | caption pairing |
|---|---|---|---|---|---|
| 38.215 (115 KB) | 2.7 s | 55 (52) | 44 | 3 | n/a (no formal `Figure N:` in this spec) |
| 38.304 (279 KB) | ~4 s | 80 (76) | 4 (incl. **137×8**) | 3 | ✅ `Figure 5.2.2-1: …` paired |

**Quality vs mammoth (the bar to beat):**
- Tables: Docling returns **clean cell arrays** (`['Definition','SS-RSRP is the linear average…']`, a 137×8 state table) — no pipe-flatten, no NOTE-concatenated-into-one-cell (the v0.5.1 pain).
- Figures: extracted **directly as PNG** with recoverable bytes → we can **drop the soffice WMF→SVG conversion step** entirely.
- Captions: Docling does NOT auto-associate `Figure N:` captions, but pairing by **reading order (±3 elements)** works (validated). 3GPP convention = caption adjacent to image.

## Architecture (mirror embed_sidecar.py)

`scripts/parse_sidecar.py` (WIP, committed) — Python subprocess that converts a
DOCX and emits a flat **reading-order element stream** as JSON:
`heading{level,text,clauseNo,title} | text{label,text} | table{rows[][]} | figure{mediaFilename,caption}`.
`02-parse.ts` shells out to it (like `embed.ts` → `embed_sidecar.py`), then runs
the **existing leaf-clause splitting** (by clause-number depth) over the stream
— keeping the proven TS logic, swapping only the extractor.

## Remaining Phase B work (the big chunk)

1. **Productionize `parse_sidecar.py`**: multi-part DOCX (convert each part,
   concat element streams in clause order — the `parts[]` from fetch-manifest),
   media → `dist/media/<spec>/<spec>-image-N.png`, emit JSON to stdout.
2. **Rewire `02-parse.ts`**: replace mammoth HTML walk with the element-stream
   consumer; adapt `buildLeafClauses` to elements; associate tables/figures to
   their containing clause by reading-order position; drop uncaptioned images
   (same as today). Keep `clauses.json/jsonl` shape (+ `vlmCaption` on figures).
3. **VLM figure captioning** (`scripts/caption-figures.ts` or in-sidecar): caption
   each figure once via a VLM (ANTHROPIC_API_KEY is available in this env),
   cache by image hash; append caption to indexed text + embedded text. Schema v4.
4. **Schema v4** (`03-index.ts`): `meta.schemaVersion="4"`, record parser + VLM
   identity, figure-caption fields, widen FTS to index captions.
5. **Eval + publish** `rel17-v6`: figure/table-answer stratum (already seeded in
   the verified eval set — `feature:"figure-table"`); measure recall up.
6. **Desktop v0.5.6**: `SUPPORTED_SCHEMA_VERSIONS` += 4; settings default → rel17-v6
   (+ rel17-v5 legacy); surface VLM captions in SpecDrawer.

## Open questions surfaced by the spike

- **Test-spec parse gap × Phase A demotion.** The v1 gap (test specs 38.508-1 /
  38.521-* / 36.521-* / 36.523-1 yield only ~5 clauses because mammoth doesn't
  map their `ZA/TT/TAR/ZT` styles to headings) — does Docling recover those
  headings? If yes, Phase B *also* recovers thousands of test-case clauses. But
  Phase A now **demotes** test specs, so the interaction needs thought: recover
  them (better intra-test-spec search) but keep them demoted for normative
  queries. Check during the rewire.
- **Equations:** Docling emits `FormulaItem` — confirm 3GPP math survives
  usefully (currently captured as text).
- **Rebuild cost:** a full `rel17-v6` build (~35 specs × Docling + VLM over
  ~1.1k figures + embed sidecar + index) + GH publish (~50 MB) is heavy for the
  agent sandbox — may need the maintainer's machine for the final publish.

## Repro

```bash
uv venv --python 3.12 /tmp/docling-venv && uv pip install --python /tmp/docling-venv docling
SIDECAR_SUMMARY=1 /tmp/docling-venv/bin/python -u scripts/parse_sidecar.py raw/38304-hb0.docx /tmp/media >/tmp/els.json
```
