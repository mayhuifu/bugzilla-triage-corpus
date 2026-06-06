# Phase C prerequisite — Hard relational eval set (design)

**Date:** 2026-06-06
**Branch:** `phase-c-relational-eval` (corpus), off `fix-eval-queries-stale-parent-ids`
**Status:** Design approved; ready for implementation plan.

## Context

Phase C of the next-gen 3GPP RAG is the knowledge-graph-augmented retrieval phase,
targeting **relational / multi-hop** questions. Our own spike
(`bugzilla-triage-desktop/PHASE-C-KG-FINDINGS.md`) gated the KG OUT:

- A deterministic (no-LLM) **co-occurrence** KG *regressed* relational retrieval
  on the eval set: hybrid 5/6 acceptable clauses in top-10 → hybrid+KG 4/6.
- More fundamentally, **hybrid already has no headroom** on the only 3 relational
  eval queries we have (qid 86–88): it pulls both acceptable clauses into the
  candidate pool (ranks 1–11), so there is no recall miss for any graph traversal
  to recover. You cannot show a KG win against queries the baseline already wins.

The documented, load-bearing prerequisite for *any* Phase C work is therefore a
**harder relational eval set**: multi-hop queries where hybrid **demonstrably
misses** the answer clause (a true recall miss, answer outside the candidate
pool), not merely ranks it low.

This spec covers **only** building that instrument and using it to answer one
question. It does **not** build the KG.

### Current state (verified 2026-06-06)

- Corpus `out/corpus.sqlite`: schema 3, **12,930 clauses**, embedder
  `BAAI/bge-small-en-v1.5` (384-dim). Healthy v5.
- `mentions_json` column exists but is **empty for all clauses** — the cross-ref
  signal is a stub, never populated. (Relevant to the *next* increment, not this one.)
- Cross-references are nonetheless abundant in raw `text`: **7,012** clauses
  reference another `clause`/`subclause`, **4,535** reference another `TS` —
  deterministically regex-extractable, no LLM. (Discovery aid for authoring; see below.)
- Eval set `scripts/eval-queries.json`: 63 queries, schemaVersion 2. Strata:
  `top1` 9, `recall-miss` 26, `ranked-low` 13, `normal` 12, **`relational` 3**.
- Reusable harness `bugzilla-triage-desktop/scripts/dev-kg-spike.mjs` already
  loads the corpus + sqlite-vec + the production RRF CTE and runs hybrid offline
  (query embedding via the bundled bge-small ONNX). This is the plumbing the gate reuses.

## Goal

Produce a verified **hard relational** eval stratum and answer, with numbers:

> **Does a real relational failure mode exist for v5 + hybrid?**

- If hybrid handles most hard candidates (answer lands in top-10), Phase C's KG is
  **unjustified** — record that and stop, exactly as the reranker was correctly
  gated out.
- If hybrid misses a meaningful fraction, those misses become the **gate** the
  cross-ref recall-recovery KG (the *next* increment) must beat.

## Non-goals (explicit)

- No knowledge graph, no `mentions_json` population, no cross-ref edge extraction.
- No schema bump, no corpus rebuild, no `rel17-v6`.
- No desktop shipping change, no retriever change.
- No LLM, no network (none available in-sandbox; none needed).

Pure measurement + curation against the existing v5 artifact.

## Approach — ① Domain-authored, cross-ref-grounded, hybrid-gated

(Chosen over a templated cross-ref-graph miner, which produces unnatural queries
that defeat the purpose of an eval meant to mirror real engineer questions.)

1. **Author** ~25–30 natural, bug-summary-style multi-hop queries in the same
   voice as qid 86–88. Each is deliberately built so the **surface terminology
   points at one procedure/clause while the normative answer lives in a different
   clause**, reached via a cross-reference or a procedural dependency. The author
   is the domain-expert stand-in (no real engineer data in-sandbox).
2. **Ground** each candidate in a *verified* relationship: the answer clause
   exists in the corpus, and the A→B link is real (either an explicit cross-ref in
   A's text, or a well-known procedural dependency across L2/L3 specs). The
   abundant cross-ref structure (7,012 clause refs) is used as a **discovery aid**
   to find good A→B pairs to author around — the queries themselves stay
   hand-written for naturalness.
3. **Validate** every `acceptableClauseId` against the corpus (id exists). A
   candidate referencing a non-existent clause is fixed or dropped before gating.
4. **Gate**: run all candidates through the live v5 hybrid retriever and partition:
   - **confirmed-hard** = the multi-hop answer clause is **absent from hybrid
     top-10** (a true recall miss a KG could recover).
   - **handled** = hybrid already returns the answer in top-10 (no headroom;
     excluded from the hard stratum, kept as evidence in the report).

### Gate definition (from the findings)

A query is **hard** iff at least one of its acceptable answer clauses is **outside
hybrid's top-10**. "Ranked low but present" does **not** count — the whole point is
a recall miss the graph can recover; re-ranking is Phase A's job, not the KG's.

## Deliverables

1. **`bugzilla-triage-desktop/scripts/dev-relational-eval-gate.mjs`** — reuses
   `dev-kg-spike.mjs`'s DB + offline bge-small embed + RRF-CTE plumbing. Input: a
   candidate-queries JSON. Output per query: the rank of each acceptable clause in
   hybrid top-K (K configurable, default 50), a hit/miss classification (miss =
   answer not in top-10), and a run summary (count + fraction of candidates hybrid
   misses, per stratum/subsystem). Read-only against the corpus.
2. **`scripts/eval-queries-relational-candidates.json`** (corpus) — ~25–30
   hand-authored candidates: `{qid, query, acceptableClauseIds[], stratum,
   difficulty, mode:"relational", rationale, refPair}`. Every clause ID
   corpus-validated. This is the raw author input, kept for audit.
3. **Gate run** → the partition (confirmed-hard vs handled), captured in the report.
4. **Merged eval set** — confirmed-hard queries appended to
   `scripts/eval-queries.json` (corpus), growing the `relational` stratum from 3 to
   however many survive. New qids continue the existing numbering; schema unchanged
   (schemaVersion stays 2 — additive). `description`/`guidelines` note updated to
   mention the hard relational addition.
5. **`HARD-RELATIONAL-EVAL.md`** (corpus) — the verdict: candidate count,
   failure-mode rate (fraction hybrid misses), representative example misses
   (query → where the answer ranked), and the explicit **go/no-go** call on
   building the cross-ref recall-recovery KG next. Updates the cross-phase arc.

## Architecture / data flow

```
author (domain) ──► eval-queries-relational-candidates.json
                          │  (corpus-validate every clause id)
                          ▼
   dev-relational-eval-gate.mjs ──reads──► out/corpus.sqlite (v5, read-only)
        │  embeds each query (bge-small ONNX, offline) → RRF CTE → top-K
        ▼
   per-query ranks ──partition──► confirmed-hard ─┐
                                  handled ────────┤──► HARD-RELATIONAL-EVAL.md (verdict)
                                                   └──► merge confirmed-hard into eval-queries.json
```

The gate is a pure function of (candidates, corpus). Re-runnable; deterministic
given the same corpus + embedder.

## Components (each independently understandable)

- **Candidate file** — data only. Purpose: the author's raw multi-hop hypotheses.
  Interface: the eval-query object shape (superset of the existing one, adds
  `rationale`/`refPair`). Depends on: nothing.
- **Gate harness** — one script. Purpose: classify each candidate hit/miss against
  live hybrid. Interface: `node dev-relational-eval-gate.mjs [--candidates path]
  [--corpus path] [--k 50]` → JSON + human summary on stdout. Depends on:
  better-sqlite3, sqlite-vec, the bundled bge-small ONNX (all already present for
  the spike), the corpus file.
- **Report** — markdown. Purpose: the verdict + audit trail. Depends on: the gate
  run output.

## Acceptance criteria

1. `dev-relational-eval-gate.mjs` runs offline against v5 and prints, for each
   candidate, the rank of every acceptable clause + a hit/miss verdict, plus a
   summary line (`N candidates, M hard (answer outside top-10)`).
2. Every clause ID in the candidate file resolves to a real clause in the corpus
   (zero "phantom" answer keys).
3. The candidate set is ≥ 20 queries spanning ≥ 3 subsystems (e.g. NR-MAC, NR-L2,
   NR-RRC, NR-PHY, mobility), authored in the qid 86–88 natural voice.
4. `eval-queries.json` after merge: relational stratum grows by the confirmed-hard
   count; file remains valid JSON, schemaVersion 2, all prior queries intact.
5. `HARD-RELATIONAL-EVAL.md` states the failure-mode rate and an unambiguous
   go/no-go on the KG, with ≥ 3 worked example misses.

## Risks

- **Author bias / unnatural difficulty.** Hand-authored queries risk being
  artificially hard or easy. Mitigation: ground every query in a real A→B
  relationship; gate strictly on hybrid-miss (the corpus, not the author, decides
  "hard"); keep `rationale`/`refPair` for audit.
- **"Hard" by accident, not by relation.** A query could miss because it's just
  badly phrased, not because it's genuinely multi-hop. Mitigation: each confirmed
  miss is inspected — the answer clause must be a *legitimate* normative answer,
  and the miss must trace to the multi-hop structure (surface terms ≠ answer
  clause's terms), recorded in the report.
- **No failure mode found.** Hybrid may handle most candidates (likely, given the
  spike). That is a **valid, valuable** outcome — it justifies *not* building the
  KG. The deliverable is the verdict either way, not a guaranteed set of misses.
- **Embedder/CTE drift vs production.** The gate must use the same bge-small +
  RRF CTE the desktop ships, or "miss" is meaningless. Mitigation: reuse
  `dev-kg-spike.mjs`'s exact DB/embed/CTE setup; assert `meta.embeddingModel ==
  BAAI/bge-small-en-v1.5` at startup.

## What the next increment looks like (out of scope here)

Only if this set shows real misses: build the **deterministic cross-reference
recall-recovery KG** — typed reference edges parsed from clause `text` (no LLM),
run **append-only** (adds clauses hybrid missed; never re-ranks/demotes pool
clauses, so it structurally cannot regress like the co-occurrence KG did),
eval-gated against this hard set. That is a separate spec.
