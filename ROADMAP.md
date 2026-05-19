# Roadmap

Phased delivery, aligned with §10.2 of the reference architecture doc.

## Status snapshot (2026-05-19)

**Phase 5 complete — self-evolution loop extends into Hydra, ExecutiveSuite, pair-programmer, and the entire RLM family.** `eights-daemon` v0.3.0 boots with **35+ MCP tools**, four WriteBridges with sandbox-enforced writeback to `theeights/auto` git side-branches, four bulk registrars, and four EvalAdapters (LLM-judge for prose, YAML-structural for teams/workflows, rubric-backtest for rubrics, NoopEval catch-all). 32/32 vitest passing across 8 files.

Live deployment numbers: **1,284 evolvable resources** registered (pp: 59, hydra: 8 squads, execsuite: 42, rlm family: 1,175). Critical-frozen roster: 8 Hydra squads (carry tool-privilege escalation), 3 ExecutiveSuite governance skills (ai-governance, executive-protocol, financial-frameworks), 5 eval judge rubrics, 2 eights policies, plus RLM safety hooks per project. CycloneDX ML-BOM v1.7 emits 1,288 components. Hash-chained audit log clean.

## Phase 0 — Foundations (DONE)

## Phase 0 — Foundations (DONE)

**Goal:** working daemon with hybrid storage and the read-side MCP tools.

- [x] `ARCHITECTURE.md` locked
- [x] ADRs 0001–0006
- [x] Daemon scaffold (`daemon/`)
- [x] CLI scaffold (`cli/`)
- [x] `eights init` creates `~/.eights/` and per-project `.eights/config.yaml`
- [x] Stores: SQLite + sqlite-vec + LadybugDB wired with health checks
- [x] MCP: `eights.memory.{add,search,get,link}`, `eights.identity.*`, `eights.audit.trace`
- [x] Event log: append-only `.jsonl` with hash-chained integrity
- [x] Memory Steward (basic extraction-on-write)
- [x] Tests: round-trip a memory through vector + graph + episodic

**Exit criteria:** `eights memory search "foo"` from CLI returns hybrid-ranked results from a seeded dataset.

## Phase 1 — pair-programmer bridge live

**Goal:** every `/pp:run` writes to eights; next run reads prior wisdom.

- [x] `adapters/pp-bridge.ts` listens to pp daemon `finalize_run`, `record_verdict`, `archive_artifact`
- [x] Episodic memory: run summary, verdict scores, taxonomy mapping, missability outcomes
- [x] Semantic memory: extracted patterns (e.g. "team feature-team-tdd consistently rejects mocked DB tests")
- [x] pp orchestrator prompt injection: "prior wisdom" block fetched on `start_run`
- [x] Audit graph: `(:Run)-[:PRODUCED]->(:Artifact)`, `(:Run)-[:WROTE]->(:Memory)`

**Exit criteria:** demonstrable behavior change in pp on the 2nd run of a similar task in a different project.

## Phase 2 — Governance plane

- [x] Policy Engine (pure-function, deterministic)
- [x] SSGM gates: consistency, decay, access — all fire on `memory.add` and `memory.consolidate`
- [x] LASM cross-layer access checks
- [x] `eights.governance.*` MCP tools
- [x] Redaction middleware at the MCP boundary
- [x] Tamper-evident hash chain over event log verified at startup

**Exit criteria:** an attempt to write a memory that contradicts a frozen fact is rejected with a structured reason; redaction strips PII at retrieval.

## Phase 3 — Evolution engine + HITL queue

- [x] RSPL: versioned, content-addressed resource store (`~/.eights/resources/`)
- [x] SEPL: `propose → evaluate → commit | queue` flow
- [x] Risk-class routing (`low` auto-commits; `medium`+ queues)
- [x] CLI: `eights review` — interactive HITL queue
- [x] Drift detector (nightly job)
- [x] First success: a low-risk resource auto-evolves on real data (e.g. a docs prompt that consistently scored 3.x → tuned candidate auto-committed after eval delta ≥ 0)

**Exit criteria:** observable, auditable, reversible evolution on at least one resource in one consumer system.

## Phase 4 — Remaining adapters + cross-project mining

- [x] `adapters/hydra-bridge.ts` (LangGraph `MemoryRef` resolution)
- [x] `adapters/execsuite-bridge.ts` (decision memos → Agent-BOM nodes; 6/12 month review jobs)
- [x] `adapters/rlm-bridge.ts` (tail `RLM/progress/events.jsonl` for all 14 RLM* siblings)
- [x] Nightly pattern miner (cross-project)
- [x] Cost / performance analyst job
- [x] Dashboard (web or TUI)
- [x] CycloneDX ML-BOM v1.7 export

**Exit criteria:** a decision in ExecutiveSuite is informed by a pattern mined from a pair-programmer run in a different project.

## Out of scope for v1

- Cloud / multi-tenant deployment (architecture supports it; not built)
- Pgvector driver (only sqlite-vec in v1)
- Graph DB swap to Neo4j / Memgraph (only LadybugDB / Kuzu)
- Web UI (CLI + Claude Code skills only)
- Auto-evolution beyond `risk_class=low`
