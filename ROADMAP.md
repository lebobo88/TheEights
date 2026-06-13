# Roadmap

Phased delivery, aligned with §10.2 of the reference architecture doc.

## Status snapshot (2026-05-24)

**Phase 6 complete — all phases shipped.** `eights-daemon` v0.3.0 boots with **70 MCP tools** across 12 namespaces, four WriteBridges with sandbox-enforced writeback to `theeights/auto` git side-branches, **five** bulk registrars (pp, hydra, execsuite, rlm, xenia), four EvalAdapters (LLM-judge for prose, YAML-structural for teams/workflows, rubric-backtest for rubrics, NoopEval catch-all), and full Hydra manifesto alignment (constitution attestation, envelope ingest, budget/ceiling/breaker governance, Eight Cells, squad-scoped redaction). Vitest suite green.

Live deployment numbers: **1,284+ evolvable resources** registered (pp: 59, hydra: 8 squads, execsuite: 42, rlm family: 1,175) across the original four consumers, **plus a fifth consumer — Xenia** (customer-support), whose `xenia-registrar` adds ≈48 resources (agents incl. `soteria-crew/` sub-agents, skills, commands, rubrics, `squad.yaml`, and `pre-response-redaction` / `pre-tool-privilege` critical hooks). Critical-frozen roster: 8 Hydra squads (carry tool-privilege escalation), 3 ExecutiveSuite governance skills (ai-governance, executive-protocol, financial-frameworks), 5 eval judge rubrics, 2 eights policies, Xenia's redaction/privilege hooks, plus RLM safety hooks per project. CycloneDX ML-BOM v1.7 emits 1,288+ components. Hash-chained audit log clean.

**Post-Phase 6 additions.** Xenia wired as the 5th consumer (`xenia-bridge` + `xenia-watcher` + `xenia-registrar`, commit `452e508`). Operator capability-token enforcement (HMAC-SHA256) added on human-override writes — `daemon/src/auth/capability.ts`. AgentMesh enrollment via `mesh-manifest.yaml`; health probe switched from `eights.audit.verify` (slow chain walk) to the cheap `eights.constitution.get` read (ADR-0009).

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

## Phase 5 — Self-evolution closed-loop (DONE)

- [x] Critical-frozen seeds across all consumers (1,284+ evolvable resources; Xenia added as the 5th consumer post-Phase 6)
- [x] Side-branch writeback (`theeights/auto`) per ADR-0007
- [x] LLM-judge / YAML-structural / rubric-backtest / noop eval registry

## Phase 6 — Hydra manifesto alignment (DONE)

- [x] **Track 1 — Immortal Head.** `kind: "constitution"` resource (critical-frozen), `eights.constitution.{get,attest,propose_amendment}` MCP tools, hash-chained attestation receipts. Hydra `HydraState` carries `constitution_hash` populated at intake.
- [x] **Track 2 — Memory handle scheme.** `ep://`, `sem://`, `proc://`, `meta://`, `mem://` URI parsing in `schemas/memory-handle.ts`. `memory.add` now returns `{ id, handle }`; new `memory.resolve` + `memory.resolve_batch` tools.
- [x] **Track 3 — HydraEnvelope native ingest.** `engines/hydra.ts` durably records every CSuiteDecisionPacket / PRD / ArchRFC / DevTask / CreativeBrief / ShotList / AssetJob / DecisionRecord / HITLRequest / Handoff with semantic indexing. New `eights.hydra.envelope.{record,query}` + `eights.hydra.handoff.list` MCP tools. Replaces the Phase-4 `adapters/hydra-bridge.ts` stub.
- [x] **Track 4 — Eight Cells semantic axis.** `Cell` enum (vision / context / triggers / influence / risk / focus / constraints / delight) on every memory row. `cognitive/cell-classifier.ts` (keyword-first, optional local-Ollama fallback). New `eights.cells.{distribution,query,classify}`.
- [x] **Track 5 — Governance plane.** `engines/governance-state.ts`: durable budget ledger (proceed → downgrade @ 80% → block @ 100%), loop ceilings (iteration / depth / failure), circuit breaker (3-strike), durable HITL queue. New `eights.governance.{budget.charge, ceiling.tick, cap.set, hitl.request, hitl.resolve, hitl.list, breaker.status, breaker.outcome, breaker.reset}`.
- [x] **Track 6 — Squad-scoped redaction.** `kind: "redaction_policy"` resource (high-risk → HITL-only). `engines/redaction.ts` walks any payload, strips scope-tagged refs per target squad, runs the existing PII patterns. New `eights.governance.redact_for_squad`.
- [x] **Track 7 — Squads as evolvable resources.** `kind: "squad"` (executive / legal-compliance / governance → critical-frozen; others → high). `hydra-registrar` bulk-registers all squads. New `eights.squad.{list,get}`.
- [x] **Track 8 — OTEL bridge.** Optional `observability/otel-sink.ts` exporter, hard-gated to localhost endpoints (refuses non-loopback at startup). Off by default; enable via `EIGHTS_OTEL_ENABLED=1`.
- [x] **Track 9 — Procedural spine.** `engines/registrars/prompts.ts` bulk-registers every `.claude/`, `.codex/`, `.gemini/` agent prompt across the four consumer repos as `kind: "prompt"`. New `eights.prompt.{list,get,diff}` for HITL reviewers.
- [x] **Track 10 — Cognitive services.** `cognitive/memory-steward.ts` (6h cadence consolidation), `cost-analyst.ts` (daily burn memo), `iolaus.ts` (daily deprecation sweep — the manifesto's "Cauterizer").
- [x] **Track 11 — Tests + docs.** 11 new vitest cases in `test/phase6.test.ts`; all 43/43 daemon tests green. ROADMAP + ARCHITECTURE refreshed.

**Exit criterion:** every Hydra workflow now binds to a constitution receipt at intake, records every cross-squad envelope to TheEights, charges budget through `governance.budget.charge` (durable across restart), redacts cross-squad payloads through `redact_for_squad`, and loads agent prompts via `eights.prompt.get`. All eleven Phase-6 tests pass.

## Out of scope for v1

- Cloud / multi-tenant deployment (architecture supports it; not built). Note: cloud LLM/embedding providers (OpenAI, DeepSeek, AuthHub) are opt-in in v1 behind `EIGHTS_ALLOW_CLOUD_PROVIDERS=1` — this is provider routing, not multi-tenant deployment.
- Pgvector driver (only sqlite-vec in v1)
- Graph DB swap to Neo4j / Memgraph (only LadybugDB / Kuzu)
- Auto-evolution beyond `risk_class=low`

## Phase 7 — Web UI: the Living Agent-BOM Atlas (IN PROGRESS)

A read-only web observability UI now IS in scope, as the **Living Agent-BOM Atlas**
(new top-level `web/` package, sibling to `daemon/` and `cli/`). It supersedes the
prior "Web UI — out of scope" line.

- **Frontend** — React + Vite + TypeScript (strict, ESM, Node 20). A pixel-faithful
  port of the design prototype: a force-directed SVG graph of the entire codebase
  (~250 nodes, 11 lenses), with drag/zoom/pan/search/inspector/legend-filter. The
  curated structural graph is the static skeleton.
- **Read-only MCP bridge** (`web/server/`) — a localhost-only Node consumer that is
  JUST ANOTHER MCP CLIENT (reuses the `cli/src/mcp-client.ts` shape). It hydrates the
  Atlas's observability layer with LIVE data (header counts, pending proposals + HITL
  queue, per-consumer resource totals, chain-verify status, Eight-Cells distribution,
  Hydra envelopes/handoffs, live edge pulses from recent audit events). Graceful
  "live: offline" fallback to baked static values when the daemon is unreachable.
- **Read-only by construction** — fixed `eights-atlas` envelope (empty scope,
  invariant #1), a hard 13-tool read whitelist + forbidden-verb denylist (no
  write/commit/approve/charge), 127.0.0.1 bind, GET-only. No `daemon/src/` change, no
  new daemon surface; every proxied read is still audited (invariant #3).

**Status:** scaffold + faithful port + bridge code complete and built; live wiring
gated on operator HITL sign-off (`live_surface_signoff`). See `web/README.md`.
