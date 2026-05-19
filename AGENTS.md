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

5. **No telemetry to anywhere other than the local event log.** v1 is local-first single-user. No outbound HTTP from the daemon.

## Coding standards

- **Language:** TypeScript (strict mode) for daemon + CLI. Python only inside `adapters/` if a consumer system is Python-native.
- **Style:** Prettier defaults, ESLint with `@typescript-eslint/recommended-type-checked`. No `any` — use `unknown` + narrowing.
- **Schemas:** Zod for runtime, JSON Schema export for adapters. The `Envelope` and every MCP tool's input/output have Zod schemas in `daemon/src/schemas/`.
- **Errors:** typed error union per engine. Never throw `string` or untyped Error.
- **Tests:** Vitest. New engines require a round-trip test through their MCP tool surface.
- **Logging:** pino JSON to `~/.eights/logs/eights-daemon-YYYY-MM-DD.log`. Never `console.log` in daemon code.
- **No backwards-compat shims** for unreleased code.

## Layering rules

- MCP handlers (`daemon/src/mcp/`) call engines. They do not call stores directly.
- Engines (`daemon/src/engines/`) call stores. They do not call MCP handlers.
- Stores (`daemon/src/stores/`) are pure CRUD + query. No business logic.
- Cognitive services (`daemon/src/cognitive/`) call engines + LLMs. They do not call stores.
- Adapters (`daemon/src/adapters/`) call MCP tools through the daemon's own internal MCP client. They do not import engines directly. This keeps adapters portable.

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
