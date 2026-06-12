# AGENTS.md — TheEights

> Behavioral contract for any AI agent (Claude Code, Copilot CLI, Gemini CLI, Codex CLI, custom MCP clients) working on **this repository**.

## What this repo is

TheEights is the persistent memory + governance + self-evolution substrate for the workspace. It is a Node 20 LTS daemon exposing MCP servers, plus a thin CLI shim. **It is not an orchestrator.** It does not own agent execution, planning, or LLM calls except in its own narrow cognitive services (Memory Steward, Cost Analyst, etc.).

Read `ARCHITECTURE.md` first. Read `ROADMAP.md` for phase scope.

## Hard rules (immutable, do not bypass)

1. **The Hard Invariants in `ARCHITECTURE.md` §12 are inviolable.**
   - No code path may broaden tenant/scope access.
   - No code path may disable, mute, or alter the audit engine.
   - No code path may grant auto-commit to non-`low` risk classes.
   - `risk_class=critical` resources are `frozen` — Evolution Engine code paths must enforce this in the type system, not in convention.

2. **Every MCP tool takes an `Envelope`.** No exceptions. If you add a new tool, it accepts `Envelope` as its first argument and enforces it before any read/write.

3. **Every read/write produces an audit event.** Use the audit engine; do not write to stores directly from MCP handlers.

4. **No silent mutation.** All resource changes go through the Evolution Engine, even seed data.

5. **No telemetry to anywhere other than the local event log.** v1 is local-first single-user. No outbound HTTP from the daemon except for user-configured LLM/embedding provider endpoints (see below). The Phase-6 OTEL sink is opt-in AND hard-gated to localhost endpoints; it refuses any non-loopback hostname at startup.

   **Cloud provider exception:** User-configured LLM/embedding provider endpoints (OpenAI, DeepSeek, AuthHub) are permitted when `EIGHTS_ALLOW_CLOUD_PROVIDERS=1` is explicitly set. This exception applies only to the provider transport layer (`daemon/src/providers/`), not to telemetry or observability sinks. The `EIGHTS_LLM_COMPLETIONS=1` toggle must also be set for completions to be active.

6. **Constitution attestation is mandatory at workflow intake.** Every supervisor MUST call `eights.constitution.attest` before its planning phase and bind the returned `receipt_signature` to its run state. Refusal aborts the workflow.

7. **Hydra squads are not edited as YAML files.** They are `kind: "squad"` resources. Adding or modifying a squad goes through `eights.evolution.propose` + HITL approval. Direct YAML edits get blown away by the next registrar sweep.

## Coding standards

- **Language:** TypeScript (strict mode) for daemon + CLI. Python only inside `adapters/` if a consumer system is Python-native.
- **Style:** Prettier defaults, ESLint with `@typescript-eslint/recommended-type-checked`. No `any` — use `unknown` + narrowing.
- **Schemas:** Zod for runtime, JSON Schema export for adapters. The `Envelope` and every MCP tool's input/output have Zod schemas in `daemon/src/schemas/`.
- **Errors:** typed error union per engine. Never throw `string` or untyped Error.
- **Tests:** Vitest. New engines require a round-trip test through their MCP tool surface.
- **Logging:** pino JSON to `~/.eights/logs/eights-daemon-YYYY-MM-DD.log`. Never `console.log` in daemon code.
- **No backwards-compat shims** for unreleased code.
- **no-premature-done**: do not declare a task done until the full relevant Vitest suite passes and the build is clean. A contract in a sibling engine can break silently if only the new test is checked.

## Layering rules

- MCP handlers (`daemon/src/mcp/`) call engines. They do not call stores directly.
- Engines (`daemon/src/engines/`) call stores. They do not call MCP handlers.
- Stores (`daemon/src/stores/`) are pure CRUD + query. No business logic.
- Providers (`daemon/src/providers/`) implement the `Embedder` and `Completer` interfaces. They import only interfaces from the root `src/` level (`embeddings.ts`, `completer.ts`). They do not import engines, stores, or MCP handlers. The `local/` subdirectory is gitignored for private providers (AuthHub SDK).
- Cognitive services (`daemon/src/cognitive/`) call engines + LLMs. They do not call stores.
- Scheduled jobs (`daemon/src/cognitive/*-job.ts`) follow a `start() / stop() / runOnce()` triad and never block daemon shutdown. Memory Steward, Cost Analyst, and Iolaus live here.
- Observability sinks (`daemon/src/observability/`) attach to existing engines (audit, metrics) by composition, not by mutation of their internal state. The OTEL sink is the canonical example: it wraps `AuditEngine.record` rather than reaching into the queue.
- Adapters (`daemon/src/adapters/`) call MCP tools through the daemon's own internal MCP client. They do not import engines directly. This keeps adapters portable.
- The web package (`web/`) is a **new top-level consumer-style package, a sibling of `daemon/` and `cli/` — never inside `daemon/src/`**. It is the Living Agent-BOM Atlas: an observability UI **with a governed operator-write path** (no longer purely read-only as of the `atlas-hitl-actions-2026-06-01` campaign). Its bridge (`web/server/`) is **just another MCP client over the existing stdio boundary** (it reuses the `cli/src/mcp-client.ts` shape and spawns `daemon/dist/index.js`). It adds **no new daemon surface** and makes **no changes under `daemon/src/`**.
  - **READ path — read-only by construction (unchanged):** a fixed `eights-atlas` envelope with empty scope (invariant #1), a hard read-only tool whitelist + forbidden-verb denylist (no write/commit/approve/charge), `127.0.0.1`-only bind + `Host` loopback check + `GET`-only. Every proxied read is still audited (invariant #3).
  - **WRITE path — governed operator-write (separate):** lets the operator Approve / Reject / Rollback self-evolution proposals from the browser. It is a **separate** path with a distinct, minimal allowlist of EXACTLY `{evolution.approve, evolution.reject, evolution.rollback}` (no other write tool reachable), a distinct **operator envelope** (actor `operator-rob`, domain `governance`, minimal hard-coded scope — does NOT broaden scope, invariant #1), a **per-session CSRF `X-Atlas-Token`** required on every **POST** (loopback bind + `Host` check retained), in-UI confirm + typed-confirm for high/critical + every rollback, and **server-side frozen/critical refusal** (requires an operator `unfreeze` via CLI — surfaced, never faked). It invokes ONLY the **governed** `eights.evolution.*` tools, which enforce policy/HITL/frozen-refusal/write-back/audit daemon-side (invariants #2, #3, #5 intact — the operator action is the operator-signed override #5 requires). Every action is audited under actor `operator-rob`. See `web/README.md`.

## When adding a new consumer system (5th, 6th, ...)

- Register a `project_id` via `eights.identity.register_project`.
- Decide its default `domain` and `scopes`.
- Write an adapter under `daemon/src/adapters/<name>-bridge.ts` that listens to the consumer's events and translates them to MCP calls.
- **Do not** modify core engines. If you find yourself wanting to, raise it for architecture review first.

## When adding a new resource kind

- Add to the `Resource.kind` union in `schemas/resource.ts`.
- Set its default `risk_class` (start conservative; demote only with evidence).
- Add it to the Evolution Engine's policy table.
- Add at least one eval that runs in `evolution.evaluate`.

## Pair-programmer / Hydra interaction

- This repo MAY use `/pp:run`, `/pp:team`, `/pp:best-of` for feature work. Phase scope is in `ROADMAP.md`.
- Do NOT have agents call back into TheEights from inside a TheEights development task — that's a circular trust gate during development. Use file-based stubs.
