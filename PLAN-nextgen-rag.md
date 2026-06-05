# Next-gen 3GPP RAG — plan

> **Status:** Proposal for discussion. Written after studying HKUDS/RAG-Anything
> (arXiv 2510.12323) against our current retrieval and the three failure modes
> the maintainer flagged. Authored to be self-contained.

## The question we asked

> "Study RAG-Anything, see if we should switch our 3GPP RAG to it. Current
> hit-rank doesn't work well for some use cases."

## Verdict on RAG-Anything (short version)

**Do not switch the runtime to RAG-Anything.** Borrow its best *build-time*
ideas; keep our offline single-SQLite, LLM-optional, in-process desktop model.

RAG-Anything is a **Python framework on top of LightRAG** that rebuilds retrieval
around a **multimodal knowledge graph**. Pipeline: MinerU parsing → VLM image
captioning + LLM table/equation interpretation → **LLM-built knowledge graph**
(entities + cross-modal relations, `belongs_to` hierarchy, weighted edges) →
**vector ⊕ graph-traversal** retrieval (LightRAG dual-level: entity + theme).

Why a wholesale switch is the wrong move *for the desktop product*:

| Dimension | Our 3GPP RAG | RAG-Anything |
|---|---|---|
| Runtime | one **SQLite** file opened in-process (Electron/Next) | Python service + graph/vector stores (`working_dir`, optional Neo4j) |
| LLM | **optional** — search works offline, no API key | **required** at ingest *and* query (`llm_model_func`, `vision_model_func`) |
| Ingest | LLM-free (mammoth → leaf clauses → bge-small) | **one LLM call per chunk** to build the KG (~13k clauses) + VLM per figure |
| Artifact | 45 MB gz, shipped via GH Release | a running stack |
| Deps | none at runtime | MinerU (+models), LibreOffice, LLM endpoint, VLM endpoint |

Adopting it at runtime breaks the very properties that make the desktop app
shippable (offline, no key, single download). **That is precisely our deferred
"§6 platform"** (a server-side, multi-user product) — and *there*,
RAG-Anything / LightRAG is a strong candidate. Different tier, later.

## What actually causes our poor hit-rank (evidence)

The `rel17-v5` build eval already names the problem:

- baseline BM25 **MRR@10 0.181**, R@1 **0.13**, R@10 **0.31**
- hybrid (bge-small ⊕ RRF) **MRR@10 0.205**, R@1 **0.08**, R@10 **0.46**

Hybrid **raised recall** (right clause usually lands in the top-10) but **lowered
top-1** (it just isn't ranked first). That "good recall, weak top-rank" signature
is the textbook case for a **cross-encoder reranker** — and reranking is already
on our own v3 deferred list. It is the 80/20 fix, and it does **not** require
RAG-Anything.

## The three failure modes (maintainer-confirmed) → the fix for each

| Failure mode | Right fix | Borrowed from RAG-Anything? |
|---|---|---|
| **Right clause in results, ranked low** | Cross-encoder **reranker** | No — our own deferred item |
| **Relational / multi-hop questions** | **Knowledge graph** shipped in SQLite + local graph-augmented retrieval | Yes — the KG *idea*, not the runtime |
| **Answer is in a figure / table** | **MinerU parsing** + **VLM figure captioning** at build time | Yes — both build-time only |

Not selected: "jargon misses" → the embedder (bge-small) is adequate; no model
swap needed yet.

## Plan — three phases, ROI/risk-ordered, each independently shippable

Guardrail for all phases: **stay offline, single SQLite, LLM-optional at
runtime.** Any LLM/VLM is **build-time only** (one-time, offline) and its output
is baked into the shipped artifact.

### Phase A — Cross-encoder reranker (do first; ~3–4 days; desktop only)

Fixes **ranked-low** — the most common symptom, the highest ROI, the lowest risk.

1. Bundle a small cross-encoder ONNX in the desktop, exactly like bge-small:
   candidate `BAAI/bge-reranker-base` (or `cross-encoder/ms-marco-MiniLM-L6-v2`,
   ~80 MB / smaller quantized). Reuse the `fetch-embed-model.mjs` + electron-builder
   `extraResources` + napi-v6 onnxruntime pattern already proven in v0.5.
2. Retriever: after hybrid RRF returns top-K (K≈30), score each `(query, clause.text)`
   pair with the cross-encoder, return top-N by reranker score. Clause text is
   already in SQLite → **no corpus rebuild**.
3. Keep it LLM-optional (the reranker is a local ONNX, not a generative LLM).
4. Eval on the existing 48-query set; expect a large **R@1 / MRR@10** jump.
5. Ships as a **desktop** release (e.g. v0.6.0). No new corpus version.

Why first: directly targets the measured weakness, fits the model perfectly, no
build-pipeline or schema change, fast.

### Phase B — Multimodal parsing upgrade (build-time; ~1–2 weeks; corpus)

Fixes **answer-in-figure/table** *and* the misformed-table problem you hit earlier.

1. Replace mammoth + soffice with **MinerU** (or Docling) in `02-parse.ts`'s
   stage for high-fidelity tables/figures/equations. Keep the leaf-clause
   numbering logic; swap the extractor underneath.
2. **VLM figure captioning at build time:** for each figure, call a VLM once to
   produce a semantic caption ("SRS time mask showing 10 µs transient periods…");
   store it in SQLite, index it in FTS5, and embed it → figures become
   *searchable by content*, not just by their `Figure N:` label.
3. Schema bump (v4): figure caption fields; richer table structure. New corpus
   artifact (e.g. `rel17-v6`).
4. Runtime artifact stays SQLite — desktop only needs the schema-v4 read path.

Cost/deps: MinerU is heavy (GPU strongly preferred for the one-time build); VLM
captioning is a one-time $ cost over ~1.1k figures. Both offline, both baked in.

### Phase C — Knowledge-graph-augmented retrieval (build-time KG; ~2–3 weeks; corpus + desktop)

Fixes **relational / multi-hop** — the one place RAG-Anything's design genuinely
wins, adapted to our offline model.

1. **Build time:** an LLM extracts entities (PUSCH, BWP, HARQ, SRB/DRB, timers,
   procedures…) and relationships across clauses. Ship the graph **inside
   SQLite** as `kg_nodes` / `kg_edges` tables (schema v4/v5).
   - Pragmatic shortcut: run **RAG-Anything/LightRAG once, offline, as a build
     tool** to produce the KG, then export nodes/edges into our SQLite — gets the
     KG without reimplementing extraction.
2. **Runtime (no LLM, no graph server):** graph-augmented retrieval — take the
   hybrid candidates, expand 1–2 hops over the shipped edges, then rerank
   (Phase A). Traversal is plain SQL/Node over the shipped tables.
3. **Eval-gated:** ship only if the relational-query stratum improves *without*
   regressing the others. KG quality depends entirely on extraction prompts;
   noisy edges can *hurt* precision — this is the most experimental phase.

Cost: one-time build LLM spend over ~13k clauses (entity/relationship extraction).

## Prerequisite for all three: expand the eval set (do before Phase A)

We can't tune what we don't measure. The current 48-query set under-represents
the failing cases. Add **stratified failing examples** for each mode — relational/
multi-hop, figure/table-answer, ranked-low — with expected clause IDs, so every
phase is gated against *real* failures, not just the original happy-path set.
This is the load-bearing dependency; ~1–2 days of curation (ideally from real
engineer queries).

## Recommended sequencing

1. **Eval-set expansion** (1–2 d) — measurement first.
2. **Phase A reranker** (3–4 d, desktop v0.6.0) — biggest, cheapest hit-rank win.
3. **Phase B parsing/captioning** (1–2 wk, corpus rel17-v6) — fixes figures/tables.
4. **Phase C knowledge graph** (2–3 wk, corpus + desktop) — relational queries;
   ship only if eval-positive.

Stop after any phase that closes the gap. A + the eval set alone may resolve most
of the "hit-rank doesn't work" complaints; B and C are the ambitious next-gen.

## What we explicitly keep from today

- Single SQLite artifact, shipped via GH Release, opened in-process.
- LLM-optional search (offline, no API key).
- BM25 ⊕ dense ⊕ RRF as the candidate generator (the reranker sits *on top*).
- bge-small embedder (no swap; jargon recall is adequate per maintainer).

## What we explicitly do NOT do

- Adopt RAG-Anything / LightRAG as the desktop runtime (Python + required LLM +
  graph server — wrong tier).
- Require an LLM or network at query time.
- Re-architect retrieval before a reranker + expanded eval prove insufficient.
