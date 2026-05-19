# TheEights — Persistent, Self-Evolving Agent Fabric

> A local-first daemon + MCP server that gives every AI agent, team, and project across the workspace a **shared persistent memory**, a **governance plane**, and a **gated self-evolution loop**. Domain-agnostic by design.

**Status:** Architecture v0.1 (May 2026)
**Author of record:** decisions locked via /goal — robob
**Companion docs:** `Architecting Enterprise Multi-Agent Systems in 2026 — Persistent Memory, Orchestration Layers, and Self-Evolving Capabilities.md` (reference research)

---

## 1. Why "TheEights"

TheEights is not another orchestrator, agent framework, or executive suite. It is the **substrate layer** that the four existing systems in this workspace converge on:

| System | Role | Today's memory state |
|---|---|---|
| **Hydra** | LangGraph supervisor / squad dispatcher | 3-tier fabric *declared*, not implemented; SqliteSaver checkpoints only |
| **ExecutiveSuite** | 20 C-suite agents + 4 multi-exec orchestrators | None — markdown artifacts only |
| **pair-programmer** | 39 sub-agents, 22 teams, taxonomy gates, judges | Rich per-project SQLite + `PROJECT_MASTER.md`; no cross-project layer |
| **RLM-CLI-Starter (+14 RLM* siblings)** | 9-phase pipeline, 4-CLI parity | Per-project `events.jsonl`; Copilot Memory only |

Every one of these has rich *per-run* state and prose-level governance intentions. None has cross-project, governed, auditable, self-evolving memory. **That is the gap, and TheEights fills it.**

The name evokes (a) the 8 reference-doc layers (LASM), (b) the 8 chambers of a typical enterprise C-suite, (c) the 8-ball — opaque but answers. Pick whichever metaphor sticks.

---

## 2. Design principles (non-negotiable)

1. **Local-first, single binary.** Daemon process on localhost, single user, no external services in v1. Cloud profile later, behind the same MCP surface.
2. **Substrate, not framework.** TheEights does not own orchestration. It owns memory, audit, and evolution gating. Consumers stay in their own paradigms (LangGraph, Claude Code agents, MCP).
3. **Domain-agnostic.** No baked-in industry verticals. A new domain (legal, healthcare, game-dev, finance) is a namespace + scope, not a code change.
4. **MCP-first surface.** Everything exposed to agents is an MCP tool/resource. CLI is a thin shim over MCP.
5. **Hybrid memory.** Vectors for first-pass recall, graph for relational/episodic reconstruction, episodic SQL for audit. Three access paths, one logical store.
6. **Governed evolution.** Every modifiable resource (prompts, teams, rubrics, memory schemas, workflows) is a *versioned resource* (Autogenesis RSPL). Changes require SSGM-style gates + HITL for non-low-risk classes.
7. **Replayable.** Any past run, decision, or evolution proposal must be reconstructible from the daemon state. No silent mutation.
8. **Defense in depth.** LASM-style controls at each layer. Zero-trust on memory access — every read/write carries a tenant + scope + policy check.

---

## 3. Layered architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Layer 7 — Adapters (per-consumer integration)                          │
│    pp-bridge │ hydra-bridge │ execsuite-bridge │ rlm-bridge │ (future)  │
├─────────────────────────────────────────────────────────────────────────┤
│  Layer 6 — MCP surface  (eights-mcp)                                    │
│    eights.memory.*   eights.governance.*   eights.evolution.*           │
│    eights.audit.*    eights.identity.*     eights.observability.*       │
├─────────────────────────────────────────────────────────────────────────┤
│  Layer 5 — Cognitive services                                           │
│    Memory Steward │ Governance Agent │ Evolution Coach │ Cost Analyst   │
├─────────────────────────────────────────────────────────────────────────┤
│  Layer 4 — Core engines                                                 │
│    Memory Engine │ Audit Engine (Agent-BOM) │ Evolution Engine (RSPL)   │
│    Policy Engine (SSGM+LASM) │ Identity & Scope Engine                  │
├─────────────────────────────────────────────────────────────────────────┤
│  Layer 3 — Storage drivers                                              │
│    sqlite-vec (vectors) │ Kuzu (graph) │ SQLite (episodic + audit + KV) │
│    Append-only event log (.jsonl)                                       │
├─────────────────────────────────────────────────────────────────────────┤
│  Layer 2 — Daemon runtime (eights-daemon, Node 20 LTS)                  │
│    Process supervisor │ Stdio + WS MCP transports │ Hooks │ Health      │
├─────────────────────────────────────────────────────────────────────────┤
│  Layer 1 — Filesystem                                                   │
│    ~/.eights/  (state.db, vectors.db, graph.kuzu/, logs/, evolution/)   │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why this stack on Windows / local

- **SQLite** — single file, WAL mode, transactional. Already proven in pair-programmer.
- **sqlite-vec** — embedded vector extension; no Postgres process required (the user's locked constraint). pgvector driver added later for the cloud profile behind the same `VectorStore` interface.
- **LadybugDB** (active fork of Kuzu, since Kuzu was archived after Apple's Oct 2025 acquisition) — embedded property graph DB; single directory, Cypher subset. Avoids running Neo4j or Memgraph as a service. Kuzu 0.11.x is kept as a fallback driver.
- **Node 20 LTS** — matches the pair-programmer daemon, lets us reuse its hook/MCP patterns. Python adapter is offered for consumers (Hydra is Python-native).

---

## 4. Logical data model

### 4.1 Identity & scope

Every memory operation carries an envelope:

```ts
type Envelope = {
  tenant_id: string;        // "local" in v1
  actor_id: string;         // agent or human identifier
  project_id: string;       // e.g. "pair-programmer", "ExecutiveSuite", "RLMcoding"
  domain: string;           // "code" | "exec" | "creative" | "research" | ...
  scope: string[];          // tags: ["public", "team:feature-team", "sensitive:no"]
  trace_id: string;         // OTEL-compatible
  parent_trace_id?: string;
};
```

Scopes are how a new industry/agent plugs in — no schema change required.

### 4.2 Memory types (CoALA-aligned)

| Type | Backing | Lifetime | Examples |
|---|---|---|---|
| **Working** | In-process LRU + SQLite spill | minutes | active turn buffer |
| **Episodic** | SQLite + jsonl event log | unbounded; tiered decay | run summaries, decision memos, dissent records |
| **Semantic** | sqlite-vec + Kuzu | unbounded; consolidated | facts, glossaries, schemas, personas |
| **Procedural** | Kuzu + signed resource store | versioned, never deleted | prompts, teams, rubrics, workflows, tool wrappers |
| **Meta** | SQLite KV | versioned | policies, profiles, learned weights, gate thresholds |

Each memory carries: `{id, type, embedding_id?, graph_node_id?, content, summary, provenance{run,actor,model,seed}, scopes[], created_at, expires_at?, confidence, supersedes?[], superseded_by?[]}`.

### 4.3 Resource registry (Autogenesis RSPL)

`procedural` and `meta` memories are *resources* with explicit versioned lifecycles:

```ts
type Resource = {
  rid: string;              // "resource:pp.team.feature-team"
  kind: "prompt" | "team" | "rubric" | "tool" | "workflow" | "schema" | "policy";
  risk_class: "low" | "medium" | "high" | "critical";
  current_version: string;
  versions: ResourceVersion[]; // signed, content-addressed
  evolution_policy: "auto" | "auto-low-risk" | "hitl-only" | "frozen";
  audit_url: string;        // graph path into Agent-BOM
};
```

**Risk classification (v1):**

- **low** → docs prompts, formatting templates, comment styles, changelog templates
- **medium** → engineering team compositions, non-critical rubrics, retrieval prompts
- **high** → security/contract/spec gates, judging rubrics, taxonomy mappings
- **critical** → policy rules, identity/scope rules, governance gates themselves

The locked v1 evolution stance — *auto-commit on low-risk, HITL on the rest* — maps directly to `evolution_policy` defaults by `risk_class`.

### 4.4 Audit graph (Agent-BOM)

Every run, every memory write, every evolution proposal is a node + edges in Kuzu:

```
(:Run)-[:PRODUCED]->(:Artifact)
(:Run)-[:WROTE]->(:Memory)
(:Memory)-[:LINKS_TO]->(:Memory)
(:Memory)-[:SUPERSEDES]->(:Memory)
(:Decision)-[:ASSUMES]->(:Assumption)-[:OUTCOME]->(:Outcome)
(:Resource)-[:HAD_VERSION]->(:ResourceVersion)
(:EvolutionProposal)-[:PROPOSES]->(:ResourceVersion)
(:EvolutionProposal)-[:APPROVED_BY|REJECTED_BY]->(:Actor)
(:Dissent)-[:RAISED_BY]->(:Actor)-[:CALIBRATED_BY]->(:Outcome)
```

This is the single auditable trace. Replay = walk the graph from a Run.

---

## 5. MCP tool surface (v1)

All tools take an `Envelope` (above) and return JSON.

### `eights.memory.*`
- `add(content, type, scopes, links?[], confidence?) → memory_id`
- `search(query, type?[], scopes?[], top_k=10, fusion="hybrid") → MemoryHit[]`
  - Hybrid = vector first-pass + graph reranking
- `get(memory_id) → Memory`
- `link(from, to, relation, weight?) → edge_id`
- `consolidate(memory_ids[], strategy="merge"|"hierarchical") → memory_id`
- `decay_tick()` — internal scheduler entry; not for agents

### `eights.governance.*`
- `policy.evaluate(action, envelope) → {allow, reason, requires_hitl}`
- `policy.list(scope?) → Policy[]`
- `redact(text, scopes) → text` — applied at MCP boundary
- `consistency_check(memory_id, new_content) → {ok, conflicts[]}` (SSGM)
- `access.check(actor, target_scopes) → boolean` (LASM)

### `eights.evolution.*`
- `propose(resource_rid, candidate_version, justification, evidence_memory_ids[]) → proposal_id`
- `evaluate(proposal_id) → EvaluationReport` — runs evals, smoke tests
- `commit(proposal_id) → version_id` — auto-commits if `risk_class=low`; otherwise queues for HITL
- `approve(proposal_id, actor) → version_id`
- `rollback(resource_rid, to_version) → version_id`
- `list_pending() → Proposal[]`

### `eights.audit.*`
- `trace(run_id|decision_id) → AuditGraph`
- `bom(project_id, since?) → CycloneDXMLBOM` — CycloneDX ML-BOM v1.7 export (de-facto Agent-BOM as of 2026; no dedicated standard exists yet)
- `replay(run_id) → ReplayBundle`

### `eights.identity.*`
- `register_project(name, domain, scopes_default[]) → project_id`
- `register_actor(name, kind, parent?) → actor_id`
- `whoami() → Envelope`

### `eights.observability.*`
- `events.tail(filter) → SSE stream`
- `metrics() → {tokens, latency_ms, gate_pass_rate, drift_indicators}`

---

## 6. Component responsibilities

### 6.1 Memory Engine
Owns hybrid write/read across sqlite-vec + Kuzu + SQLite. Implements the Hierarchical Memory Orchestrator pattern (HMO): primary cache (in-process), secondary (SQLite hot tier), archive (Kuzu graph). Handles JIT reconstruction from graph for episodic queries.

### 6.2 Memory Steward (cognitive service)
LLM-backed agent that decides what gets written, when to consolidate, when to decay. Runs as a periodic job AND inline on `memory.add` (extraction pass).

### 6.3 Policy Engine
Pure-function policy evaluator. Loads policies from a signed resource (`resource:eights.policy.default`). Returns deterministic decisions; never calls an LLM. Two layers: **SSGM** (memory write/consolidate gates), **LASM** (cross-layer access gates).

### 6.4 Evolution Engine (Autogenesis core)
- **RSPL** — manages versioned resources, signing, content addressing.
- **SEPL** — accepts proposals from any actor, runs `evolution.evaluate` (eval suite from the consumer system's rubrics), routes to `commit` or HITL queue based on `risk_class` and `evolution_policy`.
- **Drift detector** — periodic job comparing live behavior against committed versions; flags suspicious mutations.

### 6.5 Audit Engine
Append-only `.jsonl` event log + Kuzu projection. Every MCP call lands here. Tamper-evident via running hash chain in the daemon_meta table.

### 6.6 Cost / Performance Analyst
Reads `metrics()`, projects spend, recommends model routing changes as evolution proposals against `resource:*.routing.policy` resources.

---

## 7. Self-evolution flow

```
┌───────────────────────┐
│ Consumer system runs  │   (e.g. pair-programmer /pp:run completes)
└──────────┬────────────┘
           │  finalize hook → eights.memory.add(run summary, verdicts, scores)
           ▼
┌───────────────────────┐
│ Memory Steward        │   episode extraction, deduplication, linking
└──────────┬────────────┘
           │
           ▼
┌───────────────────────┐
│ Pattern miner         │   nightly job: scans for repeated wins/losses,
│ (Cost+Memory Steward) │   surfaces candidate resource improvements
└──────────┬────────────┘
           │  eights.evolution.propose(...)
           ▼
┌───────────────────────┐
│ Evolution Engine      │   risk_class lookup
└──────────┬────────────┘
           │
   ┌───────┴─────────┐
   │                 │
   ▼                 ▼
 low-risk        medium+/high/critical
   │                 │
   ▼                 ▼
 evaluate          evaluate
 → commit         → queue for HITL  ──► you review via `/eights:review`
   │                 │                      │
   ▼                 ▼                      ▼
 audit edge      audit edge             on approve → commit; on reject → audit
```

**SSGM gates that fire on every commit:**
1. Consistency vs. existing memories of same type+scope
2. Temporal decay sanity (don't revive expired contradictions)
3. Access-control invariant (the change doesn't broaden access)
4. Safety filter invariant (safety filters are themselves `frozen` — can't be modified by evolution at all)
5. Eval delta — measured improvement on the consumer's rubric set ≥ 0 (else reject)

---

## 8. Integration adapters

### 8.1 pp-bridge (pair-programmer)
- **Listens to:** `finalize_run`, `record_verdict`, `archive_artifact` events from the pp daemon.
- **Writes:** run summary, verdict scores, taxonomy mapping, missability outcomes → episodic + semantic memory tagged `project_id=<project>`, `domain=code`.
- **Reads:** on `start_run`, fetches prior runs in this project + cross-project patterns for the same `team_yaml`. Injected into the orchestrator prompt as a "prior wisdom" block.
- **Evolution targets:** team yamls, rubric weightings, gate escalation thresholds (currently hardcoded in `daemon/src/orchestrator/gates.ts`).

### 8.2 hydra-bridge
- TheEights *is* Hydra's declared-but-unimplemented memory service. Drop-in for `MemoryRef` resolution.
- Implements `~/.hydra/episodic.db` shape by projecting from the eights graph (Hydra reads through an MCP proxy).
- LangGraph nodes call `eights.memory.search` inline; `MemoryRef` handles point at eights memory ids.

### 8.3 execsuite-bridge
- Wraps the `output/<domain>/` archival convention.
- Every M&A dossier, board minute, crisis log → episodic memory + Agent-BOM nodes (`Decision`, `Assumption`, `Dissent`, `Outcome`).
- 6 / 12 month post-deal review = scheduled job that fetches outcomes from the user (or external systems later) and links them to the original Assumption nodes. Dissent calibration scoring lives here.
- Optional: route boardroom decisions over $threshold to pp's `/pp:review` forum via the engine — TheEights brokers the handoff.

### 8.4 rlm-bridge
- Tails each RLM project's `RLM/progress/events.jsonl`.
- Normalizes events into episodic memory under `domain=<the RLM specialty>` (coding/design/finance/auth/etc.).
- Cross-RLM pattern mining is automatic — the 14 RLM* siblings finally talk to each other.

### 8.5 Future adapters
Just register a new `project_id` and write an adapter that translates that system's events into eights memory ops. No core changes.

---

## 9. Filesystem layout (`~/.eights/`)

```
~/.eights/
  state.db                  # SQLite: episodic, audit, KV, identity, resources
  vectors.db                # sqlite-vec: embeddings (same connection ok)
  graph.kuzu/               # Kuzu directory
  events/
    2026-05-18.jsonl        # append-only audit/event log, one file per day
  resources/
    prompts/                # versioned content-addressed prompt store
    teams/
    rubrics/
    policies/
  evolution/
    pending/                # HITL queue
    archived/
  logs/
    eights-daemon-2026-05-18.log
  config.yaml               # daemon config (paths, ports, log levels)
```

`<project>/.eights/` (per-project, optional):
```
<project>/.eights/
  config.yaml               # project_id binding, default scopes, evolution_policy overrides
  events.jsonl              # local tail of project's audit slice
```

---

## 10. Repo layout (this directory)

```
TheEights/
  ARCHITECTURE.md           # this file
  ROADMAP.md                # phased plan (Phase 0..4 from the reference doc)
  AGENTS.md                 # behavioral contract for AI agents working in this repo
  CLAUDE.md                 # Claude Code import shim → @AGENTS.md
  README.md                 # quickstart
  adrs/
    0001-sqlite-vec-over-pgvector.md
    0002-kuzu-over-neo4j.md
    0003-node-daemon-mcp-first.md
    0004-autogenesis-resource-model.md
    0005-ssgm-gate-set.md
    0006-risk-class-evolution-policy.md
  daemon/                   # Node 20 LTS
    package.json
    src/
      index.ts              # entry: spawns MCP servers + supervisor
      mcp/
        memory.ts           # eights.memory.*
        governance.ts
        evolution.ts
        audit.ts
        identity.ts
        observability.ts
      engines/
        memory.ts
        policy.ts
        evolution.ts
        audit.ts
      stores/
        sqlite.ts
        vec.ts              # sqlite-vec wrapper
        graph.ts            # LadybugDB (Kuzu-compatible) wrapper
      cognitive/
        memory-steward.ts
        cost-analyst.ts
      adapters/
        pp-bridge.ts
        hydra-bridge.ts
        execsuite-bridge.ts
        rlm-bridge.ts
      hooks/
        dispatcher.ts
      schemas/
        envelope.ts
        memory.ts
        resource.ts
        proposal.ts
        agent-bom.ts
    test/
  cli/                      # `eights` CLI (thin shim over MCP)
    src/
      commands/
        init.ts
        status.ts
        memory.ts           # search/add from terminal
        evolution.ts        # list/approve/reject proposals
        review.ts           # interactive HITL queue
        replay.ts
  schemas/                  # JSON Schema exports (consumed by adapters)
  examples/
  scripts/
```

---

## 11. Phased delivery (matches reference doc §10.2)

- **Phase 0 — Foundations (this PR through ~2 weeks)**
  Repo, ARCHITECTURE, ADRs, daemon skeleton, SQLite/sqlite-vec/Kuzu wiring, `eights.memory.{add,search,get}`, `eights.audit.trace`, `eights.identity.*`. CLI: `eights init`, `eights status`, `eights memory search`.

- **Phase 1 — Single adapter live (~weeks 3-4)**
  pp-bridge wired to pair-programmer post-finalize hook. Cross-run recall demonstrably influences next run's prompts. Audit graph populated.

- **Phase 2 — Governance plane**
  Policy Engine + SSGM gates + LASM access checks. Redaction at MCP boundary. `eights.governance.*` complete.

- **Phase 3 — Evolution engine + HITL queue**
  Autogenesis RSPL/SEPL. Risk-class routing. `eights:review` CLI command. First auto-commit on a low-risk resource (e.g. a docs prompt).

- **Phase 4 — Remaining adapters & cross-project mining**
  hydra-bridge, execsuite-bridge, rlm-bridge. Nightly pattern miner. Cost analyst. Dashboard.

---

## 12. Hard invariants (immutable across evolution)

These cannot be modified by the Evolution Engine, ever:

1. **Tenant + scope isolation** — no resource version can broaden access.
2. **Audit logging** — no resource can disable or alter the audit engine.
3. **Safety filters** — `risk_class=critical` resources are `frozen` by default. The frozen roster explicitly includes: TheEights' own policies; ExecutiveSuite `executive-protocol` / `ai-governance` / `financial-frameworks` skills; pair-programmer security / contract / spec rubrics; RLM safety hooks (`pre-tool-safety`, `session-*`, `stop-checkpoint`, `post-state-write-verify`); Hydra HITL gates and redactor configs.
4. **Memory immutability of facts under audit** — facts referenced by an open Decision cannot be deleted, only superseded.
5. **HITL bypass prohibition** — no policy can grant auto-commit to non-`low` risk classes without an explicit operator-signed override.
6. **WriteBridge sandboxing** — no `WriteBridge.write()` may target a path outside its consumer's allowlisted root (enforced via `path.resolve`-containment check + integration test). See ADR-0007.
7. **Eval rubric immutability under evolution** — per-kind judge rubrics (`resource:eights.eval-rubric.*`) are `risk_class=critical, evolution_policy=frozen`. Evolution cannot mutate the criteria it is evaluated by. See ADR-0008.

---

## 13. Open questions (to be resolved during Phase 0–1)

- **Embedding model.** Local (Ollama nomic-embed-text? bge-small?) vs. cloud (OpenAI text-embedding-3-small). Default: local for v1, configurable.
- **Kuzu schema migrations.** Kuzu's schema evolution story on Windows.
- **Process lifecycle.** Auto-start on first MCP connection vs. explicit `eights start`. Lean: explicit, matches pp daemon.
- **Multi-user readiness signal.** When to flip tenancy on (deferred to v2).
- **The name.** "TheEights" — keep or rebrand before public surface? (Cosmetic.)
