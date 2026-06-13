# ADR-0009 — AgentMesh enrollment + cheap-read health probe

**Status:** Accepted (2026-06-04 / 2026-06-05, post-Phase 6)
**Relates to:** ADR-0003 (Node 20 daemon, MCP-first surface). This ADR does not change the MCP surface; it adds an out-of-band control-plane descriptor and corrects the health-probe tool.

## Context

Through Phase 6 each consumer wired TheEights' MCP server by hand-editing its own client config (`~/.claude.json`, `~/.hydra/backends.json`, etc.). There was no single, machine-readable description of *how* a sibling daemon is spawned, health-checked, and torn down, so spawn specs drifted: the gateway at one point had `"dist/index.js"` (a path that never existed at the repo root) baked into `~/.hydra/backends.json` under key `eights`, producing a broken spawn and a crash loop.

The workspace introduced **AgentMesh** — a control plane (`meshd`) that reads a per-sibling manifest and owns the `backends.json` entry for that sibling, so the spawn spec, health probe, and lifecycle policy live with the repo that knows them, not in a hand-maintained client config.

A second problem surfaced in the same window: the original health probe called `eights.audit.verify`, which walks the entire hash-chain (~20s on a populated log). Used as a 15s-interval liveness probe it routinely timed out and tripped the crash-loop breaker on a perfectly healthy daemon.

## Decision

### 1. Ship a `mesh-manifest.yaml` at the repo root

`apiVersion: agentmesh/v1`, `kind: SiblingManifest`. It declares:

- **`metadata`** — `id: theeights`, `version`, and a `backendsKey: "eights"` reconciliation field. The mesh registry key is `eights` (no underscores) while `metadata.id` is `theeights`; the explicit `backendsKey` stops `meshd` from guessing (Amendment 2026-06-04).
- **`runtime`** — `type: node20-ts`, `entrypoint: daemon/dist/index.js` (the real built path; Amendment 2026-06-05 fixed the `dist/index.js` drift), `cwd`, and the `healthProbe` block.
- **`mcp.endpoint`** — `stdio`, plus the discovered real tool names required by `audit.exportTool` and `governance.attestTool`.
- **`lifecycle`** — `startTimeoutMs`, `gracefulShutdownMs`, and a `crashLoopBreaker` (threshold 5 / 60s window).
- **`audit`** — `exportTool: eights.audit.trace` (TheEights exposes `eights.audit.trace`, not `…export`), `dedupeKeyField: event_id`.
- **`governance`** — `constitutionPath: CONSTITUTION.md`, `attestTool: eights.constitution.attest`.

`meshd` reads this manifest and writes/owns the `eights` entry in `~/.hydra/backends.json`. The manifest is the source of truth; hand edits to the backends entry are reverted on the next enrollment sync.

### 2. Switch the health probe from `eights.audit.verify` to `eights.constitution.get`

The `healthProbe` is an `mcp-tool-call` against **`eights.constitution.get`** — a cheap, no-args read that returns the constitution snapshot — at `intervalMs: 15000`, `timeoutMs: 5000`, `failureThreshold: 3`.

`eights.constitution.get` is a single indexed read and returns well inside the 5s budget, where `eights.audit.verify` (a full chain walk) did not. This satisfies the panel mandate (`verdict_8x1XjJZpZ4` absorption #2, 2026-06-04). Deep chain integrity is still verified — at daemon startup via the fail-closed readiness gate (`mcp/server.ts`), and on demand via `eights.audit.verify` — just not on the hot liveness path.

## Consequences

- A new top-level `mesh-manifest.yaml` is the canonical spawn/health/lifecycle descriptor for the `eights` backend. No `daemon/src/` change was required.
- The health probe no longer false-trips the crash-loop breaker on a healthy daemon.
- The probe tool (`eights.constitution.get`) is a read, so it is still envelope-gated and audited like every other tool call — liveness checks leave an audit trail, which is acceptable and intended.
- Startup integrity remains fail-closed: the readiness gate refuses every audited read/write until the chain verifies, so moving the *probe* off `audit.verify` does not weaken Hard Invariant #2 (audit immutability).
