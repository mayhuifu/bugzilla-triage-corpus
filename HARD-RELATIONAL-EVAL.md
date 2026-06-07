# Phase C prerequisite — Hard relational eval: results + KG go/no-go

> **Status:** Instrument built; verdict below. Durable hand-off (survives /compact).
> Harness: bugzilla-triage-desktop/scripts/dev-relational-eval-gate.mjs
> Candidates (audit): scripts/eval-queries-relational-candidates.json (qid 98-123)
> Spec: docs/superpowers/specs/2026-06-06-phase-c-hard-relational-eval-design.md
> Plan: docs/superpowers/plans/2026-06-06-phase-c-hard-relational-eval.md

## What we measured
26 hand-authored, cross-ref-grounded multi-hop candidates run through the live
v5 hybrid retriever (bge-small + production RRF CTE; PER_SOURCE=80, POOL_N=50,
RRF_K=60). "Hard" = answer clause outside hybrid top-10. "True-miss" = outside
the production pool of 50 — the only bucket a recall-recovery KG could help
(ranks 11-50 are cross-encoder reranker territory, not KG).

## Results
- HARD (target outside top-10): 10/26
- of which TRUE-MISS (outside pool of 50 → KG territory): 3
- of which rerankable (in pool, rank 11-50 → Phase A reranker territory): 7
- HANDLED (target in top-10): 16/26
- acceptable-clauses-in-top10: 29/47 ; phantoms: 0

### The 3 true-misses (the KG-relevant subset)
| eval qid | query surface → answer clause | hybrid rank | could a cross-ref KG recover it? |
|---|---|---|---|
| 102 | A3 report sent → 38.331#5.3.5.1 (RRC reconfiguration General) | not retrieved | Unlikely — the path is A3-event → network sends HO command → UE applies 5.3.5.1, a network-mediated multi-step chain; 5.5.4.4 does reference 5.3.5.1, so a strict cross-ref KG could traverse it, but 5.3.5.1 is a general stub, not the normative HO-execution answer, and the semantic gap is too large for a deterministic recall-recovery win. |
| 103 | RRCResume failure → 38.331#5.3.13.5 (Handling of failure to resume RRC Connection) | not retrieved | Yes — 38.331 clause 5.3.13.3 (RRC Resume procedure) contains an explicit "see clause 5.3.13.5" cross-reference on configuration-failure; this is a clean within-spec hop a deterministic xref KG could follow. |
| 108 | ra-ContentionResolutionTimer expires → 38.321#5.1.2 (Random Access Resource selection) | #112 (deep) | Marginal — 38.321 clause 5.1.5 (contention resolution) explicitly cross-references 5.1.2 ("go back to Random Access resource selection") on failure; the explicit link exists, but 5.1.2 is a broad resource-selection entry clause and the hybrid already retrieves 5.1.5 at rank 15, so the incremental KG win is narrow. |

## Verdict — DEFER / NO-GO on the cross-ref recall-recovery KG (for now)
The KG-addressable failure mode is rare: only 3 of 26 (~12%) candidates are true
recall-misses (outside the pool of 50 where a KG could help). The dominant hard
mode is 7/10 rerankable (answer in pool at ranks 11-50), which is Phase A
reranker territory entirely. The prior KG spike (PHASE-C-KG-FINDINGS.md) already
showed that a deterministic hierarchy/co-occurrence KG regresses relational
retrieval. Of the 3 true-misses, only qid 103 is a clean cross-ref hop; qid 102
is network-mediated and unlikely to yield a usable KG win; qid 108 is marginal
(hybrid already retrieves the intermediate clause). One clean cross-ref case in
26 does not justify the build-time LLM extraction cost over ~13k clauses, the
schema-v5 change, or the runtime traversal complexity. The hard eval set is the
valuable deliverable — it is now the permanent gate for any future KG work.

## Notable secondary finding
7 of the 10 hard cases are ranked-low-but-in-pool — exactly the cross-encoder
RERANKER's target (Phase A, currently shipped DORMANT because it regressed the
older/easier eval). Re-evaluating the reranker against THIS harder set is likely
higher-ROI than a KG. Flagged for a future increment, not built here.

## What merged
10 confirmed-hard queries merged into scripts/eval-queries.json (relational
stratum 3 → 13; eval qids 100,101,102,103,107,108,110,113,114,116; schemaVersion
unchanged, 2). The 3 true-misses (qid 102,103,108) are the KG-specific gate any
future recall-recovery KG must beat without regressing the 16 handled.

## Follow-up flagged
When the corpus is next rebuilt, re-check the 05-eval.ts build gate
(EVAL_MIN_LIFT=0.15): adding hard relational queries hybrid misses can shift the
measured BM25-vs-hybrid lift; may need a stratum-aware gate or recalibration.
