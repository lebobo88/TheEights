# ADR-0003 — Node 20 LTS daemon, MCP-first surface

**Status:** Accepted (2026-05-18)

## Decision

Daemon is Node 20 LTS, TypeScript strict. Everything an agent can do is an MCP tool or resource. The CLI is a thin shim that opens an MCP client to the daemon.

## Rationale

- Mirrors `pair-programmer` daemon — same hook patterns, same MCP server library, same OS-level expectations on Windows.
- MCP is the lowest-common-denominator surface; every consumer system (Claude Code, Copilot CLI, Gemini, Codex, Hydra Python, custom) can talk to it.
- TypeScript with Zod gives us a single source of truth for runtime + JSON Schema export to adapters.

## Alternatives considered

- **Python daemon** — Hydra and most RLM siblings are Python, but pair-programmer is Node. Pick one stack; Node wins because of the maturity of the pp daemon patterns we are reusing.
- **Library, not daemon** — rejected at /goal time. We need a single source of truth, hash-chained audit, and resource versioning that survives across consumer processes.

## Consequences

- Python consumers (Hydra) talk over MCP, not in-process.
- The daemon owns its own process lifecycle; consumers launch it via `.mcp.json` spawn or start it explicitly with `eights start`.
