# Telecom Debug Triage RAG System — Development Specification

## 1. Objective

Build an internal AI-assisted debug triage platform for modem/chipset development.

Primary target use cases:

- U300/U200 modem bring-up
- RF/PHY/MAC/RRC/NAS issue triage
- Certification debug support
- Operator interoperability issue analysis
- Regression analysis
- Field issue correlation
- Knowledge retention across teams
- Faster onboarding of new engineers

The system is NOT intended to be a generic chatbot.

The core goal is:

> Accelerate debug triage and engineering decision-making by combining internal debug history, logs, code changes, and 3GPP specification retrieval into a structured AI-assisted workflow.

---

# 2. Core Design Principles

## 2.1 Ticket-Centric Architecture

The system must be centered around:

- debug tickets
- issue lifecycle
- failure procedures
- engineering evidence

NOT around generic document Q&A.

Priority order:

1. Ticket evidence
2. Similar historical issues
3. Known fixes/workarounds
4. Related code changes
5. 3GPP references
6. AI-generated reasoning

---

## 2.2 Retrieval First, LLM Second

Retrieval quality is more important than LLM sophistication.

The system should prioritize:

- exact keyword retrieval
- protocol-aware retrieval
- graph relationships
- structured metadata filtering
- log pattern similarity

LLM reasoning should operate on retrieved evidence.

---

## 2.3 Spec-Aware Retrieval

3GPP retrieval must preserve:

- TS/TR number
- release
- version
- section hierarchy
- normative vs informative distinction
- tables and figures

All AI answers referencing 3GPP must cite:

- spec number
- release
- version
- section

Example:

```text
3GPP TS 38.331 Rel17 v17.8.0
Section 5.3.5
```

---

## 2.4 Structured Debug Reasoning

The system should reason in procedural steps.

Example:

```text
Attach started
→ RRC connected
→ Data session established
→ UL BLER increase
→ HARQ retransmission escalation
→ Ping timeout
```

NOT generic natural language summaries.

---

# 3. High-Level System Architecture

```text
Debug Ticket / Logs / Reports
            ↓
1. Ticket Normalizer
            ↓
2. Evidence Extraction Engine
            ↓
3. Retrieval Engine
            ↓
4. Reasoning & Triage Agent
            ↓
5. Ticket Update / Recommendation Output
```

---

# 4. Functional Modules

# 4.1 Ticket Normalizer

## Objective

Convert unstructured debug tickets into structured metadata.

## Input Sources

- Jira
- GitLab Issues
- WeChat/IM exported notes
- Email reports
- Field test summaries
- Certification reports

## Extracted Fields

| Field | Example |
|---|---|
| RAT | LTE / NR |
| Release | Rel15 / Rel16 / Rel17 |
| Band | n28 / n41 |
| Layer | RF / PHY / MAC / RRC / NAS |
| Symptom | Attach fail |
| Test Type | Live network / UXM / Amarisoft |
| Customer | CMCC / Verizon |
| Severity | Critical / Major / Minor |
| HW Version | EVT / DVT |
| SW Build | build_xxx |
| Environment | Lab / Field |

---

# 4.2 Evidence Extraction Engine

## Objective

Extract structured debug evidence from logs and reports.

## Supported Inputs

- QXDM logs
- Amarisoft logs
- UXM logs
- Modem traces
- RF logs
- Kernel logs
- Crash dumps
- Packet captures
- Calibration reports

## Key Extraction Targets

| Category | Examples |
|---|---|
| RRC Messages | RRCSetup, Reconfiguration |
| NAS Messages | AttachReject |
| MAC Events | HARQ timeout |
| RF Metrics | RSSI, SINR, PHR |
| Timing | Timestamp correlation |
| Power | TX power collapse |
| Mobility | HO failure |
| Stability | T310 expiry |

## Future Extensions

- protocol sequence reconstruction
- anomaly detection
- automated timeline generation
- KPI trend analysis

---

# 4.3 Retrieval Engine

## Objective

Retrieve relevant technical evidence from multiple sources.

## Retrieval Sources

### Internal Sources

- Jira tickets
- GitLab issues
- Git commits
- Bring-up reports
- Calibration reports
- Lab notes
- Test reports
- Customer issue reports
- Known workaround database
- Team wiki

### External Sources

- 3GPP specifications
- Vendor documentation
- Operator requirement documents
- Certification references

---

## Retrieval Priority

The system should rank retrievals by:

1. Same symptom + same band + same RAT
2. Same failure procedure
3. Same log signature
4. Same test setup
5. Same subsystem owner
6. Same 3GPP procedure
7. General semantic similarity

---

## Retrieval Strategy

### Hybrid Retrieval

Use:

- BM25 keyword search
- vector search
- graph traversal
- metadata filtering

### Metadata Filters

Examples:

```text
RAT = NR
Band = n41
Layer = MAC
Release = Rel17
```

### Required Capabilities

- exact keyword matching
- semantic retrieval
- protocol-aware retrieval
- issue clustering
- similarity scoring

---

# 4.4 3GPP Knowledge System

## Objective

Provide spec-aware retrieval with traceable references.

## Supported Specs

### NR

- TS 38.211
- TS 38.212
- TS 38.213
- TS 38.214
- TS 38.321
- TS 38.322
- TS 38.323
- TS 38.331
- TS 38.101
- TS 38.521

### LTE

- TS 36.xxx series

### NAS/Core

- TS 24.501
- TS 24.301

---

## Spec Parsing Requirements

### Chunking Strategy

Chunk by:

- section
- subsection
- table
- figure
- requirement block

DO NOT chunk by:

- fixed token windows
- arbitrary paragraph windows

---

## Metadata Requirements

Each chunk must contain:

```json
{
  "spec": "38.331",
  "release": "Rel17",
  "version": "17.8.0",
  "section": "5.3.5",
  "title": "RRC Reconfiguration",
  "type": "normative"
}
```

---

## Normative vs Informative

Chunks must be tagged:

```text
normative
informative
```

Normative content has higher retrieval priority.

---

# 4.5 Knowledge Graph Engine

## Objective

Represent engineering relationships.

## Recommended Technology

Neo4j

---

## Graph Relationships

```text
Ticket
 → symptom
 → procedure
 → module
 → engineer
 → owner
 → workaround
 → git commit
 → test case
 → 3GPP section
```

---

## Example

```text
Ticket U300-0911
 → symptom: UL drop
 → band: n41
 → owner: PHY
 → linked commit: abc123
 → related spec: TS 38.214
```

---

# 4.6 Reasoning & Triage Agent

## Objective

Generate structured triage guidance.

## Inputs

- retrieved tickets
- logs
- graph relationships
- spec references
- test metadata

## Outputs

The system should output structured triage objects.

Example:

```json
{
  "failure_stage": "Connected mode data transfer",
  "suspected_layer": ["MAC", "RF"],
  "confidence": "medium",
  "evidence": [
    "UL BLER increase before drop",
    "Similar issue U300-0911"
  ],
  "next_actions": [
    "Check UL PHR trend",
    "Run fixed MCS test"
  ],
  "3gpp_refs": [
    "TS 38.214",
    "TS 38.321"
  ],
  "owner": "PHY/RF"
}
```

---

## Required Capabilities

- failure stage classification
- suspected subsystem identification
- confidence scoring
- root-cause hypothesis generation
- next-step recommendation
- workaround retrieval
- owner recommendation

---

# 5. Recommended Open Source Stack

| Layer | Recommendation |
|---|---|
| Search Engine | OpenSearch |
| Vector Retrieval | OpenSearch Vector / Qdrant |
| Knowledge Graph | Neo4j |
| RAG Framework | LangChain / LlamaIndex |
| Embedding Model | bge-m3 / e5-large |
| Reranker | bge-reranker |
| LLM | DeepSeek / Qwen / Llama |
| UI | OpenWebUI |
| Workflow | Jira/GitLab integration |

---

# 6. Recommended Data Storage Architecture

## PostgreSQL

Store:

- ticket metadata
- spec metadata
- test metadata
- build metadata
- ownership mapping

---

## OpenSearch

Store:

- ticket text
- logs
- reports
- embeddings
- keyword indices

---

## Neo4j

Store:

- issue relationships
- subsystem relationships
- spec references
- ownership graph

---

# 7. Development Phases

# Phase 1 — MVP (4–6 Weeks)

## Scope

Build:

- ticket ingestion
- basic RAG
- OpenSearch indexing
- vector retrieval
- 3GPP ingestion
- simple UI

## Data Sources

- Jira
- GitLab
- bring-up notes
- calibration reports
- selected logs
- 3GPP specs

## Deliverables

- ticket similarity search
- spec-aware search
- AI-generated triage summary
- next-step recommendation

---

# Phase 2 — Protocol-Aware Intelligence

## Scope

Add:

- protocol-aware parsing
- message sequence extraction
- failure stage detection
- issue clustering

## Supported Procedures

Examples:

- RRC setup
- attach
- registration
- handover
- DRX transition
- BWP switching
- CA activation
- VoNR setup

---

# Phase 3 — Advanced Debug Intelligence

## Scope

Add:

- automated root-cause ranking
- timeline reconstruction
- anomaly detection
- KPI trend correlation
- regression detection
- AI-assisted debug planning

---

# 8. Security Requirements

## Requirements

- internal-only deployment
- no external cloud dependency for sensitive data
- local LLM support
- role-based access control
- audit logging
- ticket-level access control

---

# 9. Performance Requirements

| Metric | Target |
|---|---|
| Ticket retrieval latency | < 5 seconds |
| Similar ticket retrieval | top 20 |
| Spec retrieval accuracy | > 90% relevant |
| Log parsing throughput | scalable |
| Vector retrieval | hybrid BM25 + semantic |

---

# 10. Future Extensions

## Potential Features

- automated bug deduplication
- AI-generated debug checklists
- AI-generated test plans
- automatic owner assignment
- regression risk prediction
- code impact analysis
- calibration optimization suggestions
- operator-specific issue analysis
- certification gap analysis

---

# 11. Example User Workflow

## Input

```text
NR n41 live network ping drops after 8 minutes.
Logs attached.
```

---

## System Output

```text
Likely failure area:
MAC/PHY/RF interaction.

Evidence:
- RRC connected before drop
- UL BLER increased before timeout
- Similar issue U300-0911

Suggested next actions:
1. Check UL PHR trend
2. Run fixed MCS test
3. Compare Amarisoft controlled cell
4. Disable low-power transition

Relevant specs:
- TS 38.214
- TS 38.321
- TS 38.331
```

---

# 12. Key Success Metrics

## Engineering Efficiency

- reduced triage time
- reduced duplicate debugging
- faster root-cause convergence
- reduced onboarding time
- improved cross-team collaboration

---

## Technical Metrics

- ticket retrieval accuracy
- triage recommendation quality
- spec citation accuracy
- similar issue detection rate
- workaround reuse rate

---

# 13. Strategic Vision

Long term, the platform should evolve into:

```text
Institutional Debug Intelligence System
```

that captures:

- engineering knowledge
- historical fixes
- protocol expertise
- RF experience
- certification experience
- operator interoperability knowledge

and transforms them into reusable engineering intelligence.

This becomes a long-term competitive advantage for modem/chipset execution efficiency.

---

# 14. Architecture Decision Records — 3GPP Corpus v2

This section captures architecture decisions for the `bugzilla-triage-corpus` build pipeline. The pipeline produces the 3GPP knowledge artifacts consumed by §4.3 (Retrieval Engine) and §4.4 (3GPP Knowledge System). The long-term destination is the §6 storage stack (OpenSearch + Neo4j + PostgreSQL); the current consumer is the offline `bugzilla-triage-desktop` Electron app. Decisions below are scoped to "v2" — the next release of the corpus.

## ADR-001: Pipeline scope

- This repo produces **two outputs**: a canonical JSONL of leaf clauses (`dist/clauses.jsonl`), and a backward-compatible SQLite bundle (`out/corpus.sqlite.gz`) for the desktop consumer.
- OpenSearch bulk NDJSON and Neo4j CSV emit functions are **deferred** until the §6 storage layer is live. The canonical JSONL is sufficient to derive any backend artifact later by a single transformation step.
- Rationale: avoid speculative format work; keep the pipeline scope clean while the server platform is still being scoped.

## ADR-002: Hybrid retrieval baseline (BM25 + dense + RRF)

- The SQLite artifact carries both `clauses_fts` (FTS5 BM25, kept from v1) and `clauses_vec` / `parent_vec` (sqlite-vec dense vectors, new in v2).
- Retrieval in the desktop consumer fuses BM25 + cosine similarity via Reciprocal Rank Fusion (RRF) in a single SQL CTE — no external server, no daemon.
- Cross-encoder reranking (bge-reranker, per §5) is **deferred to v3**.
- Rationale: satisfies the §2.2 / §4.3 "Hybrid Retrieval" requirement on the offline desktop without infra. Telecom-RAG benchmarks (Telco-DPR, TelcoAI, Chat3GPP) report ~25-point absolute Top-10 lift over BM25-only with this configuration.

## ADR-003: Embedding model

- **Build time:** `bge-m3` (1024-dim) — matches §5 recommendation. Vectors computed once at build, stored as float16 BLOBs.
- **Query time (desktop):** ships a small ONNX embedding model in the **same vector space** as the build-time model. If the bge-m3 ONNX export is too large for the desktop install, fall back to a distilled small variant and re-embed the corpus to match. The actual model identity is recorded in `meta.embeddingModel` / `meta.embeddingDim` / `meta.embeddingDtype` so consumers can hard-fail on mismatch.
- Future (server platform): model is a knob, not a contract — the canonical JSONL is model-agnostic and can be re-embedded with any model at any time.

## ADR-004: Chunking strategy

- Continue **leaf-clause chunking** per §4.4 ("Chunk by section / subsection / table / figure / requirement block — DO NOT chunk by fixed token windows").
- Add **table extraction**: structured rows preserved with stable IDs (e.g. `38.211#6.3.3.1/Table-1`) and exposed as a `tables[]` array on the clause record. A flat text fallback is kept in `text` for FTS coverage.
- Add **figure references**: figure IDs + captions detected and listed under `figures[]`. Figure bitmap extraction is out of scope; reference-only.
- **Deferred to v3:** normative-vs-informative tagging, citation long-form format.

## ADR-005: Knowledge graph integration

- v2 does **not** emit Neo4j artifacts.
- The canonical JSONL carries the fields needed to materialize the §4.5 graph downstream: `spec`, `clauseNo`, `parentId`, `parentTitle`, `version`, `release`. A `mentions: []` slot is reserved on the schema but stays empty in v2 (entity extraction deferred).
- Rationale: graph load belongs to the platform team; this repo stays scope-pure.

## ADR-006: Canonical JSONL schema (source of truth)

One record per leaf clause, one line per record:

```json
{
  "id": "38.331#5.3.5.1",
  "spec": "TS 38.331",
  "release": "Rel-17",
  "version": "17.10.0",
  "clauseNo": "5.3.5.1",
  "title": "Conditional reconfiguration",
  "parentId": "38.331#5.3.5",
  "parentTitle": "RRC Reconfiguration",
  "text": "…",
  "citation": "3GPP TS 38.331 §5.3.5.1",
  "tables": [{"id": "Table-1", "caption": "…", "rows": [["hdr","hdr"], ["cell","cell"]]}],
  "figures": [{"id": "Figure-1", "caption": "…"}],
  "mentions": []
}
```

This schema is the **stable contract** going forward. The SQLite schema, and any future OpenSearch/Neo4j artifacts, are derived from it. Breaking changes bump `meta.schemaVersion`.

## ADR-007: Parse-gap fixes

- **38.201 (legacy Word 97 Composite Document):** detect via ZIP-content magic bytes; shell out to `libreoffice --headless --convert-to docx` before mammoth ingest. New build-time dependency.
- **Test specs (38.508-1, 38.521-1/2/3, 36.508, 36.521-1/2/3, 36.523-1):** pass mammoth a `styleMap` mapping 3GPP-internal paragraph styles (`ZA`/`ZB` → `h2`, `TT`/`TAR`/`TF`/`ZT` → `h3`; the exact code set is verified against a sample DOCX during exec). Recovers hundreds of test-case clauses currently lost as front-matter.
- Rationale: §4.4 enumerates 38.521 explicitly; v1 leaves it returning ~5 front-matter clauses, blocking conformance triage.

## ADR-008: Evaluation set as a build gate

- 60–100 hand-curated triage-style queries with expected leaf-clause IDs, stratified across PHY (38.211/214, 36.211/213), MAC (38.321, 36.321), RRC (38.331, 36.331), RF (38.101-*, 36.101), and conformance (38.508-1, 38.521-*).
- Stored as `scripts/eval-queries.json` and shipped **inside** the SQLite (`eval_queries` table) so the desktop / future platform can run the same smoke check.
- A new `scripts/05-eval.ts` measures Precision@5, MRR@10, Recall@10 for both baseline (FTS5 only) and hybrid (RRF), per stratum.
- **Build-gate rule:** non-zero exit if hybrid MRR@10 is below baseline; target absolute lift ≥ 0.15. Aligns with §9 (>90 % relevance).
- Rationale: today's golden snippets only validate the parser. Without a retrieval-quality gate, every future upgrade is unfalsifiable.

## Out of scope for v2 (explicit non-goals)

- Cross-encoder reranking stage (bge-reranker) — deferred to v3.
- KG-lite entity extraction / `mentions[]` population — deferred.
- Normative-vs-informative tagging — deferred.
- Citation long-form (`Rel17 v17.8.0 Section 5.3.5`) — deferred (parallel field, cheap to add later).
- OpenSearch bulk NDJSON / Neo4j CSV emit functions — produced by a future loader service.
- Rel-18 / Rel-19 corpora — separately published bundles.
- NAS specs TS 24.501 / TS 24.301 — listed in §4.4 but require a different 3GPP series fetch path; v2 covers RAN1/2/3 only.
