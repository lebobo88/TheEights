# TheEights Diagnostic & Plan — Pending Cross-Vendor Critique

> **Purpose:** Feed this to `mcp__pp_codex__critique` (GPT-5.4 high) in a fresh session for accuracy validation.
> **Created:** 2026-05-25 by Claude Opus 4.7 diagnostic session.

---

## Claims to validate (each numbered for the judge to score)

### Claim Group A: What TheEights Is Tracking

1. **A1**: TheEights has 4 registered projects: pair-programmer, Hydra, ExecutiveSuite, and the RLM family.
2. **A2**: Total evolvable resources: 1,284 (pp: 59, hydra: 8 squads, execsuite: 42, rlm family: 1,175).
3. **A3**: The SQLite database at `~/.eights/state.db` is 1.4GB with WAL.
4. **A4**: 309MB of hash-chained audit events spanning 2026-05-19 through 2026-05-25.
5. **A5**: Four adapters exist: pp-bridge, execsuite-bridge, rlm-bridge, hydra-bridge (Phase 6 replaced the stub with native envelope ingest).

### Claim Group B: Pending Evolution Proposals

6. **B1**: There are exactly 21 pending evolution proposals (all `status: "pending"`).
7. **B2**: Zero proposals have been approved or committed.
8. **B3**: Proposals cover Hydra (2), pair-programmer/AgentSmith (3), ExecutiveSuite (1), RLM Platform (9+), cross-cutting (3+), plus the CMS content block registry from today.
9. **B4**: Proposals were filed by `claude-orchestrator` (earlier ones) and `hydra-supervisor` (later ones, from R5 work sessions).
10. **B5**: The most recent proposal (`rlm/cms-content-block-registry`) was filed 2026-05-25 by `hydra-supervisor`.

### Claim Group C: Why the User Hasn't Seen Results

11. **C1**: All medium/high risk proposals require HITL approval. There is no notification mechanism to alert the user that proposals are pending.
12. **C2**: The cognitive jobs (CostAnalyst every 24h, MemorySteward every 6h, Iolaus daily, Miner hourly) write to memory but never push notifications.
13. **C3**: Three recall hooks exist in pp-daemon's dispatcher (`eights-recall-project` at line 224, `eights-recall-stage` at line 469, `eights-recall-request` at line 716) but are NOT registered in `~/.claude/settings.json`.
14. **C4**: The ROADMAP Phase 1 exit criterion ("prior wisdom block fetched on start_run") is marked done but the actual injection from TheEights → pp orchestrator prompt is not wired in `start_run`'s output.
15. **C5**: WriteBridges default to `in-place+branch` mode (side-branch), not PR mode. No PR is created, so evolutions are invisible in normal workflow.

### Claim Group D: Proposed Fix — Hook Registration

16. **D1**: Adding `eights-recall-project` to SessionStart hooks in `~/.claude/settings.json` requires zero code changes — the handler already exists and is tested.
17. **D2**: Adding `eights-recall-stage` as a PreToolUse hook with matcher `mcp__pp_harness__start_stage` will surface prior verdicts when a stage opens.
18. **D3**: Adding `eights-recall-request` to UserPromptSubmit hooks will surface relevant memories on each user prompt.
19. **D4**: All three hooks gracefully degrade (silent no-op) when TheEights daemon is offline.

### Claim Group E: Architecture Accuracy

20. **E1**: The risk-class routing is: low → auto-commit, medium → hitl-only, high → hitl-only, critical → frozen.
21. **E2**: The Miner runs hourly and looks for: (a) rubric failures ≥3 times in 30 days, (b) missability clusters ≥2 times in 30 days.
22. **E3**: The Miner's LLM proposal path requires `EIGHTS_LLM_COMPLETIONS=1` + Ollama to be active.
23. **E4**: `eights-recall-project` calls `recallProjectContext(cwd, 10)` which queries TheEights via MCP stdio client.
24. **E5**: The pp eights-client has a per-namespace circuit breaker and stays muted for session life if the daemon is unreachable at first probe.

---

## Source files the judge should spot-check

| Claim | File to verify |
|-------|---------------|
| A1-A2 | `TheEights/daemon/src/index.ts` lines 1-50 (project registration) |
| B1-B5 | Live query: `eights.evolution.list_pending` (21 proposals returned in this session) |
| C3 | `pair-programmer/daemon/src/hooks/dispatcher.ts` lines 224, 469, 716 |
| C3 | `~/.claude/settings.json` (no `eights-recall` entries present) |
| C4 | `pair-programmer/daemon/src/orchestrator/runs.ts` (StartRunOutput has no prior_wisdom field) |
| D1-D4 | `dispatcher.ts` handler implementations + graceful degradation patterns |
| E1 | `TheEights/daemon/src/schemas/resource.ts` (DEFAULT_EVOLUTION_POLICY) |
| E2-E3 | `TheEights/daemon/src/engines/miner.ts` |
| E4-E5 | `pair-programmer/daemon/src/ecosystem/eights-client.ts` |

---

## How to run this critique

```
mcp__pp_codex__critique({
  model: "gpt-5.4",
  effort: "high",
  system: "You are a cross-vendor accuracy judge. Score each numbered claim (A1-E5) as CONFIRMED, UNCONFIRMED, or REFUTED with evidence. Flag any claims that cannot be verified from the source files alone.",
  prompt: "<contents of this file>",
  rubric: "accuracy-audit"
})
```
