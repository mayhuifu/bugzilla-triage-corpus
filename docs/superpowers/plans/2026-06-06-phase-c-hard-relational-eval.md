# Phase C — Hard Relational Eval Set Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a verified *hard relational* eval stratum — multi-hop queries where the live v5 hybrid retriever **misses** the normative answer clause (answer outside top-10) — and produce a numbers-backed go/no-go verdict on whether Phase C's knowledge graph is justified.

**Architecture:** A read-only offline gate harness (stripped-down `dev-kg-spike.mjs`: corpus + bge-small query embedder + production RRF CTE, no KG) classifies hand-authored, cross-ref-grounded candidate queries as HIT/HARD against live hybrid. Confirmed-hard queries merge into the shipped eval set; the verdict lands in a findings doc. No KG, no schema bump, no corpus rebuild, no network/LLM.

**Tech Stack:** Node ESM, `better-sqlite3` + `sqlite-vec` (read-only corpus), `@huggingface/transformers` (`Xenova/bge-small-en-v1.5`, q8, local cache), JSON eval data.

---

## Standing constraints (read before executing)

- **Commits:** the maintainer's standing rule is "commit/push only when asked." Approving this plan sanctions the per-task commits below. End every commit message with the trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Run location:** the harness imports `@huggingface/transformers`, which only resolves inside `bugzilla-triage-desktop`. ALWAYS run it from that repo root (`cd /Users/huifu/bugzilla-triage-desktop`). Running from `/tmp` or the corpus repo fails with `ERR_MODULE_NOT_FOUND`.
- **Branch:** corpus work is on `phase-c-relational-eval` (already checked out; clean mammoth base + verified 63-query eval set + intact v5 corpus). Desktop work is on `main`.
- **No test runner exists** in either repo (per CLAUDE.md). "Tests" here are gate runs with exact expected output; the harness's self-check against the existing 3 relational queries (must reproduce the spike's 5/6) is the correctness anchor.

## File structure

| File | Repo | Action | Responsibility |
|---|---|---|---|
| `scripts/dev-relational-eval-gate.mjs` | desktop | **Create** | The gate harness: embed → RRF → classify HIT/HARD, write results JSON. Read-only. |
| `scripts/eval-queries-relational-candidates.json` | corpus | **Create** | Hand-authored multi-hop candidates (audit source; keeps `rationale`/`refPair`). |
| `dist/relational-gate-results.json` | corpus | **Generated** (gitignored) | Gate output consumed by the merge + report. Reproducible; not committed. |
| `scripts/eval-queries.json` | corpus | **Modify** | Append confirmed-hard queries; relational stratum 3 → N. schemaVersion stays `2`. |
| `HARD-RELATIONAL-EVAL.md` | corpus | **Create** | The verdict: failure-mode rate + worked example misses + KG go/no-go. |
| `PLAN-nextgen-rag.md`, `bugzilla-triage-desktop/PHASE-C-KG-FINDINGS.md` | both | **Modify** | Update the Phase C status banner / cross-phase arc with the verdict. |

---

## Task 1: Build the gate harness

**Files:**
- Create: `/Users/huifu/bugzilla-triage-desktop/scripts/dev-relational-eval-gate.mjs`

- [ ] **Step 1: Write the harness**

Create `/Users/huifu/bugzilla-triage-desktop/scripts/dev-relational-eval-gate.mjs`:

```javascript
// scripts/dev-relational-eval-gate.mjs — Phase C (v0.5.7) prerequisite gate.
//
// Answers: does a REAL relational failure mode exist for v5 + hybrid? i.e. are
// there multi-hop queries whose normative answer clause hybrid MISSES (answer
// outside top-10)? Those misses are the only thing a knowledge graph could
// recover — without them Phase C's KG is unjustified (as the reranker was).
//
// This is dev-kg-spike.mjs's plumbing (corpus + bge-small + production RRF CTE)
// with the KG removed: pure measurement, read-only. No LLM beyond the local
// bge-small ONNX query embedder. Run FROM the desktop repo:
//   node scripts/dev-relational-eval-gate.mjs [--candidates PATH] [--corpus PATH]
//        [--out PATH] [--filter-relational]
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = "/Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049";
const CORPUS = arg("--corpus", process.env.CORPUS || `${BASE}/out/corpus.sqlite`);
const CANDIDATES = arg("--candidates", process.env.CANDIDATES || `${BASE}/scripts/eval-queries-relational-candidates.json`);
const OUT = arg("--out", process.env.OUT || `${BASE}/dist/relational-gate-results.json`);
const FILTER_REL = argv.includes("--filter-relational");

// Production-faithful RRF params (verbatim from dev-kg-spike.mjs / retriever.ts).
const RRF_K = 60, PER_SOURCE = 80, POOL_N = 50; // POOL_N = what production keeps
const TOP = 10;     // answer in top-10 = HIT (handled)
const DEEP_N = 200; // how deep we report rank (fused candidate set caps ~2*PER_SOURCE)

const db = new Database(CORPUS, { readonly: true });
db.pragma("cache_size=-20000"); sqliteVec.load(db);
const embModel = db.prepare("SELECT value FROM meta WHERE key='embeddingModel'").pluck().get();
if (embModel !== "BAAI/bge-small-en-v1.5") {
  console.error(`FATAL: corpus embeddingModel=${embModel}, expected BAAI/bge-small-en-v1.5 — measurement invalid.`);
  process.exit(1);
}
const allIds = new Set(db.prepare("SELECT id FROM clauses").pluck().all());
console.log(`[gate] ${CORPUS} — ${allIds.size} clauses, embedder ${embModel}`);

const STOP = new Set(["the","and","for","that","this","with","from","when","have","been","are","was","were","will","into","but","not","you","your","our","their","its"]);
const toks = (t) => Array.from(new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(x => x.length >= 3 && x.length <= 32 && !STOP.has(x))));
const match = (t) => { const u = toks(t).slice(0, 60); return u.length ? u.map(x => `"${x.replace(/"/g, '""')}"`).join(" OR ") : '""'; };
const vecToBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const rrf = db.prepare(`
  WITH fts_top AS (SELECT c.rowid rowid, ROW_NUMBER() OVER (ORDER BY bm25(clauses_fts)) rk FROM clauses_fts JOIN clauses c ON c.rowid=clauses_fts.rowid WHERE clauses_fts MATCH ? LIMIT ?),
  vec_top AS (SELECT rowid, ROW_NUMBER() OVER (ORDER BY distance) rk FROM clauses_vec WHERE embedding MATCH ? AND k=?),
  fused AS (SELECT rowid, SUM(1.0/(?+rk)) s FROM (SELECT rowid,rk FROM fts_top UNION ALL SELECT rowid,rk FROM vec_top) GROUP BY rowid)
  SELECT c.id FROM fused JOIN clauses c ON c.rowid=fused.rowid ORDER BY fused.s DESC LIMIT ?`);

const tf = await import("@huggingface/transformers");
const extractor = await tf.pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", { dtype: "q8" });
const embed = async (t) => { const o = await extractor(t, { pooling: "cls", normalize: true }); return o.data instanceof Float32Array ? o.data : new Float32Array(o.data); };

const rankIn = (ids, target) => { const i = ids.indexOf(target); return i < 0 ? Infinity : i + 1; };
const bucket = (r) => r <= TOP ? "HIT" : r <= POOL_N ? "RANKED-LOW" : r <= DEEP_N ? "DEEP" : "MISS";

const doc = JSON.parse(fs.readFileSync(CANDIDATES, "utf8"));
let cands = doc.queries || doc;
if (FILTER_REL) cands = cands.filter(q => q.mode === "relational" || q.feature === "relational");
console.log(`[gate] ${cands.length} candidate queries from ${CANDIDATES}\n`);

const results = [];
let hard = 0, trueMiss = 0, phantoms = 0, hitAcc = 0, totalAcc = 0;
for (const q of cands) {
  const acc = (q.acceptableClauseIds && q.acceptableClauseIds.length) ? q.acceptableClauseIds : [q.expectedClauseId];
  const target = q.expectedClauseId || acc[0];
  const phantomIds = acc.filter(id => !allIds.has(id));
  if (phantomIds.length) { phantoms += phantomIds.length; console.log(`qid ${q.qid}: ⚠ PHANTOM: ${phantomIds.join(", ")}`); }
  const vec = await embed(q.query);
  const pool = rrf.all(match(q.query), PER_SOURCE, vecToBlob(vec), PER_SOURCE, RRF_K, DEEP_N).map(r => r.id);
  const ranks = {};
  for (const a of acc) { ranks[a] = rankIn(pool, a); totalAcc++; if (ranks[a] <= TOP) hitAcc++; }
  const tr = ranks[target] ?? Infinity;
  const isHard = tr > TOP, isTrueMiss = tr > POOL_N;
  if (isHard) hard++;
  if (isTrueMiss) trueMiss++;
  results.push({ qid: q.qid, query: q.query, target, ranks, bucket: bucket(tr), isHard, isTrueMiss, phantomIds });
  console.log(`qid ${q.qid} [${bucket(tr)}${isHard ? " ★HARD" : ""}] "${q.query.slice(0, 64)}…"`);
  for (const a of acc) console.log(`   ${a}: #${ranks[a] === Infinity ? "—" : ranks[a]}${a === target ? "  (target)" : ""}`);
  console.log("");
}

const summary = { total: cands.length, hard, handled: cands.length - hard, trueMiss, rerankable: hard - trueMiss, phantoms, acceptableInTop10: `${hitAcc}/${totalAcc}` };
console.log(`[gate] SUMMARY ${summary.total} candidates → ${hard} HARD (target outside top-${TOP}); of those ${trueMiss} TRUE-MISS (outside production pool of ${POOL_N} → KG territory), ${summary.rerankable} rerankable. acceptable-in-top10=${summary.acceptableInTop10}. phantoms=${phantoms}`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generatedFrom: CANDIDATES, corpus: CORPUS, params: { RRF_K, PER_SOURCE, POOL_N, TOP, DEEP_N }, summary, results }, null, 2));
console.log(`[gate] wrote ${OUT}`);
db.close();
```

- [ ] **Step 2: Self-check — run against the existing 3 relational queries, expect to reproduce the spike**

Run:
```bash
cd /Users/huifu/bugzilla-triage-desktop
node scripts/dev-relational-eval-gate.mjs \
  --candidates /Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049/scripts/eval-queries.json \
  --filter-relational \
  --out /tmp/gate-selfcheck.json
```
Expected: 3 queries evaluated; `acceptable-in-top10=5/6` (matches `PHASE-C-KG-FINDINGS.md`). Specifically qid 86 `38.321#5.4.5` ≈ #11 (★HARD), `38.321#5.4.4` ≈ #3; qid 87 both ≤10; qid 88 both ≤10. If `acceptable-in-top10` ≠ 5/6, the harness does NOT mirror production — STOP and reconcile RRF params against `dev-kg-spike.mjs` before trusting any new result.

- [ ] **Step 3: Commit**

```bash
cd /Users/huifu/bugzilla-triage-desktop
git add scripts/dev-relational-eval-gate.mjs
git commit -m "$(cat <<'EOF'
feat(eval): add read-only hard-relational gate harness

dev-kg-spike.mjs plumbing minus the KG: embeds each candidate query with
bge-small, runs the production RRF CTE, classifies the target clause
HIT/RANKED-LOW/DEEP/MISS. Self-check reproduces the spike's 5/6
acceptable-in-top10 on the existing 3 relational queries.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Author + validate the candidate queries

**Files:**
- Create: `scripts/eval-queries-relational-candidates.json` (corpus, branch `phase-c-relational-eval`)

- [ ] **Step 1: Write the candidate file with the 8 verified seeds**

Create `/Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049/scripts/eval-queries-relational-candidates.json`. Each candidate: surface terminology points at procedure A, the normative answer is the dependency in clause B (`expectedClauseId`). All clause IDs below are corpus-verified leaves (Task 2 Step 3 re-checks).

```json
{
  "description": "Phase C hard-relational candidates. Authored cross-ref-grounded multi-hop queries; surface terms point at one procedure, the normative answer lives in a different (dependency) clause. Gated by dev-relational-eval-gate.mjs; only hybrid-misses (target outside top-10) merge into eval-queries.json.",
  "schemaVersion": 2,
  "queries": [
    {"qid": 89, "query": "After timeAlignmentTimer expires the UE keeps transmitting on PUSCH using its existing uplink grant instead of treating the uplink as out of synchronisation.", "expectedClauseId": "38.321#5.2", "acceptableClauseIds": ["38.321#5.2"], "stratum": "NR-MAC", "difficulty": "hard", "mode": "relational", "feature": "relational", "source": "curated-v0.5.7-candidate", "rationale": "Surface terms PUSCH/uplink-grant point at UL grant reception (38.321#5.4.1); the normative 'flush HARQ, clear grants, consider UL out-of-sync' rule lives in TA maintenance.", "refPair": {"surface": "38.321#5.4.1", "answer": "38.321#5.2"}},
    {"qid": 90, "query": "Beam failure is detected on the SpCell but the UE never starts the random access procedure for beam failure recovery.", "expectedClauseId": "38.321#5.17", "acceptableClauseIds": ["38.321#5.17", "38.213#6"], "stratum": "NR-MAC", "difficulty": "hard", "mode": "relational", "feature": "relational", "source": "curated-v0.5.7-candidate", "rationale": "Beam-failure detection counters/thresholds are PHY (38.213#6 link recovery); the RA-for-BFR trigger is MAC (38.321#5.17).", "refPair": {"surface": "38.213#6", "answer": "38.321#5.17"}},
    {"qid": 91, "query": "When the sCellDeactivationTimer expires the UE continues to send CSI reports and SRS on the deactivated secondary cell.", "expectedClauseId": "38.321#5.9", "acceptableClauseIds": ["38.321#5.9"], "stratum": "NR-MAC", "difficulty": "hard", "mode": "relational", "feature": "relational", "source": "curated-v0.5.7-candidate", "rationale": "Surface CSI/SRS point at PHY reporting; the deactivation-stops-CSI/SRS/PDCCH rule is in MAC SCell activation/deactivation.", "refPair": {"surface": "38.213#9", "answer": "38.321#5.9"}},
    {"qid": 92, "query": "On RRC reconfiguration with sync the PDCP entity is re-established but the corresponding RLC entity keeps its old state variables and buffered PDUs.", "expectedClauseId": "38.322#5.1.2", "acceptableClauseIds": ["38.322#5.1.2", "38.323#5.1.2"], "stratum": "NR-L2", "difficulty": "hard", "mode": "relational", "feature": "relational", "source": "curated-v0.5.7-candidate", "rationale": "Surface PDCP re-establishment (38.323#5.1.2); the answer about RLC discarding state on re-establishment is in 38.322#5.1.2.", "refPair": {"surface": "38.323#5.1.2", "answer": "38.322#5.1.2"}},
    {"qid": 93, "query": "Measurement event A3 entry condition is met and the report is sent, but the UE never applies the handover command to the target cell.", "expectedClauseId": "38.331#5.3.5.1", "acceptableClauseIds": ["38.331#5.3.5.1"], "stratum": "NR-RRC", "difficulty": "hard", "mode": "relational", "feature": "relational", "source": "curated-v0.5.7-candidate", "rationale": "Surface event-A3/measurement-report (38.331#5.5.4); the handover-execution behaviour is reconfiguration-with-sync (38.331#5.3.5.1).", "refPair": {"surface": "38.331#5.5.4.1", "answer": "38.331#5.3.5.1"}},
    {"qid": 94, "query": "RRCResume fails because the UE cannot comply with the received configuration, yet the UE does not fall back to establishing a new RRC connection.", "expectedClauseId": "38.331#5.3.13.5", "acceptableClauseIds": ["38.331#5.3.13.5"], "stratum": "NR-RRC", "difficulty": "hard", "mode": "relational", "feature": "relational", "source": "curated-v0.5.7-candidate", "rationale": "Surface RRCResume reception (38.331#5.3.13.4); the failure-handling/fallback rule is 38.331#5.3.13.5.", "refPair": {"surface": "38.331#5.3.13.4", "answer": "38.331#5.3.13.5"}},
    {"qid": 95, "query": "The drx-onDurationTimer is running so the UE is in DRX Active Time, yet it does not monitor PDCCH on the configured search spaces.", "expectedClauseId": "38.321#5.7", "acceptableClauseIds": ["38.321#5.7", "38.213#10.4"], "stratum": "NR-MAC", "difficulty": "hard", "mode": "relational", "feature": "relational", "source": "curated-v0.5.7-candidate", "rationale": "Surface PDCCH/search-space (38.213#10); the Active-Time-implies-monitor-PDCCH definition is DRX (38.321#5.7).", "refPair": {"surface": "38.213#10.4", "answer": "38.321#5.7"}},
    {"qid": 96, "query": "A DCI indicates PDCCH monitoring skipping for a duration that overlaps the DRX onDuration, and the UE stops monitoring PDCCH for the whole onDuration.", "expectedClauseId": "38.213#10.4", "acceptableClauseIds": ["38.213#10.4", "38.321#5.7"], "stratum": "NR-PHY", "difficulty": "hard", "mode": "relational", "feature": "relational", "source": "curated-v0.5.7-candidate", "rationale": "Surface DRX/onDuration (38.321#5.7); the skipping-vs-monitoring interaction is in PDCCH skipping (38.213#10.4).", "refPair": {"surface": "38.321#5.7", "answer": "38.213#10.4"}}
  ]
}
```

- [ ] **Step 2: Expand to ~25–30 candidates using discovery SQL + the rubric**

Find more grounded multi-hop pairs. Run discovery SQL to surface clauses whose text cites another clause/spec (the A→B link must be real):
```bash
cd /Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049
# clauses (in normative L2/L3 specs) that explicitly reference another spec — candidate A→B sources
sqlite3 out/corpus.sqlite "SELECT id, title FROM clauses WHERE spec IN ('38.321','38.322','38.323','38.331','38.300','38.304') AND (text LIKE '%TS 38.%' OR text LIKE '%as specified in%' OR text LIKE '%defined in%') ORDER BY id LIMIT 60;"
# inspect a specific clause's cross-refs to confirm the dependency before authoring
sqlite3 out/corpus.sqlite "SELECT substr(text,1,600) FROM clauses WHERE id='38.321#5.2';"
```
**Authoring rubric (per query):**
1. Pick a real A→B dependency (A's text references B, or a well-known cross-spec procedural link).
2. Write a bug-summary-style sentence (qid 86–88 voice) whose *surface vocabulary* matches A while the *normative answer* is B. Set `expectedClauseId = B`.
3. `acceptableClauseIds`: `[B]` (strict) or `[B, A]` when A is also a legitimate answer.
4. Fill `stratum` (NR-MAC / NR-L2 / NR-RRC / NR-PHY / mobility), `difficulty:"hard"`, `mode:"relational"`, `feature:"relational"`, `source:"curated-v0.5.7-candidate"`, plus `rationale` and `refPair`.
5. Continue `qid` numbering (89, 90, …). Target ≥ 20 total spanning ≥ 3 strata (the 8 seeds already cover NR-MAC/NR-L2/NR-RRC/NR-PHY).

- [ ] **Step 3: Validate every clause ID exists (zero phantoms)**

Run the gate on the candidate file; the harness flags any non-existent ID as `⚠ PHANTOM`:
```bash
cd /Users/huifu/bugzilla-triage-desktop
node scripts/dev-relational-eval-gate.mjs --out /tmp/gate-validate.json 2>&1 | grep -E "PHANTOM|phantoms="
```
Expected: `phantoms=0`. If any `⚠ PHANTOM` line appears, fix that clause ID in the candidate file (use the discovery SQL to find the correct leaf) and re-run until `phantoms=0`.

- [ ] **Step 4: Commit**

```bash
cd /Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049
git add scripts/eval-queries-relational-candidates.json
git commit -m "$(cat <<'EOF'
feat(eval): add hand-authored hard-relational candidate queries

~25-30 cross-ref-grounded multi-hop candidates; surface terms point at
procedure A, normative answer lives in dependency clause B. All clause
ids corpus-verified (phantoms=0). Audit fields rationale/refPair retained.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Run the gate and partition confirmed-hard vs handled

**Files:**
- Generated: `dist/relational-gate-results.json` (corpus, gitignored — not committed)

- [ ] **Step 1: Run the full gate**

```bash
cd /Users/huifu/bugzilla-triage-desktop
node scripts/dev-relational-eval-gate.mjs --out /Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049/dist/relational-gate-results.json
```
Expected: a per-query table + a `SUMMARY` line of the form `N candidates → H HARD (target outside top-10); of those T TRUE-MISS (outside production pool of 50 → KG territory), R rerankable. acceptable-in-top10=…`. Results JSON written.

- [ ] **Step 2: Extract the partition for the merge + report**

```bash
cd /Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049
node -e '
const r = require("./dist/relational-gate-results.json");
const hard = r.results.filter(x => x.isHard);
const trueMiss = r.results.filter(x => x.isTrueMiss);
console.log("SUMMARY:", JSON.stringify(r.summary));
console.log("\nCONFIRMED-HARD (target outside top-10):");
for (const x of hard) console.log(`  qid ${x.qid} [${x.bucket}] target ${x.target} #${x.ranks[x.target]===null?"—":x.ranks[x.target]}`);
console.log("\nHANDLED (hybrid already finds target in top-10):");
for (const x of r.results.filter(y=>!y.isHard)) console.log(`  qid ${x.qid} target ${x.target} #${x.ranks[x.target]}`);
'
```
Expected: a clean split. This list drives Task 4 (merge confirmed-hard) and Task 5 (report). No commit — `dist/` is gitignored and the result is reproducible by re-running Step 1.

---

## Task 4: Merge confirmed-hard queries into the shipped eval set

**Files:**
- Modify: `scripts/eval-queries.json` (corpus)

- [ ] **Step 1: Append confirmed-hard candidates to the eval set**

Programmatic merge (keeps existing 63 intact, appends only `isHard` candidates, strips the internal `refPair`, keeps `rationale`, sets final `source`, renumbers nothing — candidate qids already continue from 88):
```bash
cd /Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049
node -e '
const fs = require("fs");
const evalDoc = JSON.parse(fs.readFileSync("scripts/eval-queries.json","utf8"));
const cand = JSON.parse(fs.readFileSync("scripts/eval-queries-relational-candidates.json","utf8")).queries;
const gate = require("./dist/relational-gate-results.json");
const hardQids = new Set(gate.results.filter(x=>x.isHard).map(x=>x.qid));
const existing = new Set(evalDoc.queries.map(q=>q.qid));
let added = 0;
for (const q of cand) {
  if (!hardQids.has(q.qid) || existing.has(q.qid)) continue;
  const { refPair, ...keep } = q;             // drop internal refPair
  keep.source = "curated-v0.5.7";             // promote from -candidate
  evalDoc.queries.push(keep);
  added++;
}
evalDoc.queries.sort((a,b)=>a.qid-b.qid);
fs.writeFileSync("scripts/eval-queries.json", JSON.stringify(evalDoc, null, 2) + "\n");
const rel = evalDoc.queries.filter(q=>q.mode==="relational"||q.feature==="relational").length;
console.log(`merged ${added} confirmed-hard; total queries ${evalDoc.queries.length}; relational stratum now ${rel}`);
'
```
Expected: `merged <H>` (H = confirmed-hard count); relational stratum grows from 3 to `3+H`.

- [ ] **Step 2: Validate the merged file**

```bash
cd /Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049
node -e 'const q=require("./scripts/eval-queries.json"); if(q.schemaVersion!==2) throw new Error("schemaVersion changed!"); const ids=q.queries.map(x=>x.qid); if(new Set(ids).size!==ids.length) throw new Error("duplicate qid"); console.log("OK: "+q.queries.length+" queries, schemaVersion "+q.schemaVersion+", unique qids");'
```
Expected: `OK: <N> queries, schemaVersion 2, unique qids`.

- [ ] **Step 3: Commit**

```bash
cd /Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049
git add scripts/eval-queries.json
git commit -m "$(cat <<'EOF'
feat(eval): merge confirmed-hard relational queries into eval set

Relational stratum grows from 3 to N with multi-hop queries where v5 hybrid
demonstrably misses the answer clause (target outside top-10), verified by
dev-relational-eval-gate.mjs. schemaVersion unchanged (2), additive only.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Write the verdict and update the Phase C banner

**Files:**
- Create: `HARD-RELATIONAL-EVAL.md` (corpus)
- Modify: `PLAN-nextgen-rag.md` (corpus), `/Users/huifu/bugzilla-triage-desktop/PHASE-C-KG-FINDINGS.md`

- [ ] **Step 1: Write `HARD-RELATIONAL-EVAL.md`**

Create `/Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049/HARD-RELATIONAL-EVAL.md`. Fill the bracketed numbers from the Task 3 SUMMARY + partition. Template:

```markdown
# Phase C prerequisite — Hard relational eval: results + KG go/no-go

> **Status:** Instrument built; verdict below. Durable hand-off (survives /compact).
> Harness: bugzilla-triage-desktop/scripts/dev-relational-eval-gate.mjs
> Candidates (audit): scripts/eval-queries-relational-candidates.json
> Spec: docs/superpowers/specs/2026-06-06-phase-c-hard-relational-eval-design.md

## What we measured
<N> hand-authored, cross-ref-grounded multi-hop candidates run through the live
v5 hybrid retriever (bge-small + production RRF CTE, PER_SOURCE=80, POOL_N=50,
RRF_K=60). "Hard" = the normative answer clause (target) is outside hybrid top-10.
"True-miss" = outside the production pool of 50 (the only bucket a recall-recovery
KG could help; ranks 11–50 are reranker territory, not KG).

## Results
- HARD (target outside top-10): <H>/<N>
- of which TRUE-MISS (outside pool of 50, KG territory): <T>
- of which rerankable (in pool, ranked 11–50): <R>
- phantoms: 0

| qid | query (truncated) | target | hybrid rank | bucket |
|---|---|---|---|---|
| <…3+ worked example misses with real ranks…> |

## Verdict — [GO / NO-GO] on the cross-ref recall-recovery KG
[If T is small / zero → NO-GO: hybrid retrieves the multi-hop answer into the
pool on these queries; the KG has nothing to recover. Same outcome as the
reranker — do not build. If T is meaningful → GO: there is a real recall-miss
failure mode; proceed to the deterministic cross-reference recall-recovery KG
(append-only, eval-gated against these <T> true-misses).]

## What merged
<H> confirmed-hard queries merged into scripts/eval-queries.json (relational
stratum 3 → <3+H>, schemaVersion 2). They are now the permanent gate for any
future Phase C KG work.

## Follow-up flagged
When the corpus is next rebuilt, re-check the 05-eval.ts build gate
(EVAL_MIN_LIFT=0.15): adding hard relational queries hybrid misses can shift the
measured BM25-vs-hybrid lift. May need a stratum-aware gate or recalibration.
```

- [ ] **Step 2: Update the Phase C status banner**

In `PLAN-nextgen-rag.md`, update the `Phase C` paragraph of the SESSION STATUS banner (lines ~19–27) to reflect: the hard relational eval set is now built (`relational` stratum 3 → N), the true-miss count, and the GO/NO-GO. In `bugzilla-triage-desktop/PHASE-C-KG-FINDINGS.md`, append a short "Update 2026-06-06" note under the Recommendation/Cross-phase arc section pointing to `HARD-RELATIONAL-EVAL.md` and stating the verdict. Keep edits to a few lines; reference the worked numbers.

- [ ] **Step 3: Commit (both repos)**

```bash
cd /Users/huifu/bugzilla-triage-corpus/.claude/worktrees/competent-taussig-e4e049
git add HARD-RELATIONAL-EVAL.md PLAN-nextgen-rag.md docs/superpowers/specs/2026-06-06-phase-c-hard-relational-eval-design.md docs/superpowers/plans/2026-06-06-phase-c-hard-relational-eval.md
git commit -m "$(cat <<'EOF'
docs(phase-c): hard relational eval verdict + spec/plan + banner update

Records the failure-mode rate and GO/NO-GO on the cross-ref recall-recovery KG.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
cd /Users/huifu/bugzilla-triage-desktop
git add PHASE-C-KG-FINDINGS.md
git commit -m "$(cat <<'EOF'
docs(phase-c): note hard relational eval verdict

Cross-reference to corpus HARD-RELATIONAL-EVAL.md; GO/NO-GO on the KG.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review (against the spec)

**Spec coverage:**
- Deliverable 1 (gate harness) → Task 1. ✓
- Deliverable 2 (~25–30 grounded candidates, ids validated) → Task 2 (8 verified seeds + discovery SQL + rubric + phantom check). ✓
- Deliverable 3 (gate run, partition) → Task 3. ✓
- Deliverable 4 (merge into eval-queries.json, stratum 3→N, schema 2) → Task 4. ✓
- Deliverable 5 (HARD-RELATIONAL-EVAL.md verdict + go/no-go) → Task 5. ✓
- Acceptance criteria: harness offline + per-candidate ranks (Task 1), phantoms=0 (Task 2 Step 3), ≥20 across ≥3 strata (Task 2 rubric), merged stratum grows + schema 2 (Task 4 Step 2), report with ≥3 worked misses + go/no-go (Task 5). ✓
- Non-goals honored: no KG, no schema bump, no rebuild, no network/LLM — none of the tasks touch those. ✓
- Risk "embedder/CTE drift" → Task 1 asserts `meta.embeddingModel` + self-checks against the spike's 5/6. ✓
- Risk "no failure mode found" → Task 5 verdict template covers NO-GO as a valid outcome. ✓

**Placeholder scan:** harness code is complete; the only intentionally-deferred content is the *additional* candidate queries beyond the 8 verified seeds — that is irreducible domain curation, fully specified by the discovery SQL + rubric + the worked seed pattern, and gated by the phantom check. The report template's bracketed numbers are filled from the Task 3 run (a data-dependency, not a placeholder in the plan logic).

**Type/name consistency:** `expectedClauseId` / `acceptableClauseIds` / `qid` / `mode:"relational"` / `feature:"relational"` match the existing eval-queries.json shape (verified qid 86–88). Harness fields (`isHard`, `isTrueMiss`, `ranks`, `target`, `bucket`) are consistent across Tasks 1, 3, 4. RRF params (RRF_K=60, PER_SOURCE=80, POOL_N=50) match `dev-kg-spike.mjs`.
```
