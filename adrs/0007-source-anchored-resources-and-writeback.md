# ADR-0007 — Source-anchored resources + writeback to consumer repos

**Status:** Accepted (2026-05-19, Phase 5)
**Supersedes part of ADR-0004 (Autogenesis resource model):** that ADR established that prompts/teams/rubrics/etc. are versioned resources. This ADR extends the model so committed versions also propagate back to the consumer system's filesystem.

## Context

Through Phase 4, the EvolutionEngine mutated only its own `~/.eights/resources/` tree. Consumer artifacts inside pair-programmer, Hydra, ExecutiveSuite, and RLM-CLI siblings could be *observed* via watchers but never *changed* by the loop. Self-evolution was half-open: TheEights could judge but could not act.

## Decision

A Resource may declare zero or more **source paths** — absolute filesystem locations in a consumer repo that mirror the canonical content. When the EvolutionEngine commits a new version, it:

1. Writes the canonical version to `~/.eights/resources/<sanitized-rid>/<version>.content` as before.
2. Looks up `resource_sources` for the rid.
3. Dispatches to the matching `WriteBridge` (one per consumer) which performs the consumer-side write under that consumer's `writeback_mode`.
4. Updates `resource_sources.last_written_version` + `last_written_at`.
5. Audits the writeback as a structured event distinct from `evolution.commit`.

Default `writeback_mode` is `in-place+branch`: write the file in place and stage a commit on a `theeights/auto` branch in the consumer repo via the shared `GitWriter`. The consumer's `main`/`master` branch is never touched. Force-push is prohibited.

## Sandboxing — hard invariant #6

Every `WriteBridge.canHandle(path)` MUST return `false` for any path that is not `path.resolve`-contained inside the consumer's allowlisted root. Test-enforced. A `write()` that bypasses `canHandle` throws and surfaces as an audit anomaly.

**Consumer roots are resolved in `daemon/src/config.ts` (`loadConfig()`), not hardcoded.** This keeps the sandbox portable across machines and clones. The default for the base (`siblingsRoot`) is the **parent directory of the TheEights clone** (side-by-side sibling layout), and every root is independently overridable via an environment variable. The bridges/registrars/watchers read these resolved values; they never derive paths from `process.cwd()`.

| Consumer | Allowlisted root(s) | Env override | Default (`siblingsRoot` = parent of clone) |
| --- | --- | --- | --- |
| pp | repo ∪ `~/.claude` | `EIGHTS_PP_ROOT` | `<siblingsRoot>/pair-programmer` ∪ `~/.claude` |
| hydra | repo | `EIGHTS_HYDRA_ROOT` | `<siblingsRoot>/Hydra` |
| execsuite | repo | `EIGHTS_EXECSUITE_ROOT` | `<siblingsRoot>/ExecutiveSuite` |
| rlm | starter repo + any `^RLM*` dir under the scan root | `EIGHTS_RLM_STARTER_ROOT`, `EIGHTS_RLM_ROOT` (scan) | `<siblingsRoot>/RLM-CLI-Starter` + `^RLM*` under `<siblingsRoot>` |

The base itself is `EIGHTS_SIBLINGS_ROOT`. The RLM **scan root** (`EIGHTS_RLM_ROOT`) is kept separate from the starter **repo root** (`EIGHTS_RLM_STARTER_ROOT`) and is independently pinnable so the `^RLM*` claim surface can be constrained on a broad parent.

> **Sandbox-contract note:** changing a default root *relocates* the writeback sandbox to where the repos actually live; it does not broaden tenant/scope access (each root is still a specific allowlisted directory). Operators changing layout should set the env vars explicitly. **Stale-source caveat:** `EvolutionEngine.register()` upserts `resource_sources` without pruning, so a deployment that previously registered sources under a *different* root should re-seed a clean `~/.eights` (or prune manually) to avoid drift/writeback against dead paths.

## Failure mode

If `WriteBridge.write()` throws:
- The registry commit is **not rolled back** — the canonical version stands.
- The failure is logged as `evolution.writeback.failed` with the rid, source path, and exception.
- The next drift scan surfaces the divergence loudly.

This is deliberate: the substrate is the source of truth. Filesystem failures should never erase a validated evolution event.

## Risk-class invariants preserved

- `critical` resources are still `frozen`. A frozen resource cannot have a writeback attempted because it cannot have a proposal committed in the first place.
- `auto` writebacks still require `eval_delta >= 0`. The eval gate from ADR-0006 stays first.
- `hitl-only` writebacks require an explicit `eights.evolution.approve` call from an operator-signed envelope.

## Consequences

- `Resource` schema gains `consumer` and `sources[]`. SQLite schema gains the `resource_sources` table (migration v2 in `daemon/src/stores/sqlite.ts.applyV2`).
- Four `WriteBridge` impls live under `daemon/src/engines/writers/`.
- Consumer repos pick up a `theeights/auto` branch the first time they receive a writeback. Reviewing the branch is the human's main review surface for low-risk auto-commits.
- Hand-edits to source files are no longer invisible — drift detection covers them.
