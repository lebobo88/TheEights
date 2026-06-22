# Request

Make TheEights MCP daemon answer the stdio `initialize` handshake in well under 1 second on a cold start, so a downstream consumer (AgentSmith) never loses its connect race and wedges. --repo theeights

Root cause (verified): in daemon/src/index.ts the MCP transport is only started at `startMcpServer(tools, …)` near line 415, but several heavy operations are `await`ed BEFORE it, so the transport isn't listening until they finish: `sql.migrate()` (~line 149) on a ~760MB sqlite db; `graph.open()` + `graph.ensureSchema()` (~line 155, LadybugDB); and especially `await createEmbedder(providerCfg)` / `await createCompleter(providerCfg)` (~line 190-191) plus `await embedder.available()` / `await completer.available()` (~line 198-200) which can block on provider/model probes. The existing comment "Transport up FIRST — answers the gateway's initialize handshake in <1s" is currently false because of these preceding awaits.

Requirements:
(2a-i) Reorder boot so the stdio MCP transport (startMcpServer) is attached and answering initialize/tools-list as early as possible — before the embedder/completer construction and their `.available()` probes, and before any other non-essential heavy await. The existing fail-closed audit-readiness gate (auditGate / auditReady, tools refused until the chain verifies in the background) MUST be preserved exactly — do not serve audited tools before the chain verifies.
(2a-ii) Make embedder/completer init + availability probes lazy or backgrounded (e.g. resolve them after the transport is up, or on first use), so a slow/unreachable provider can never delay initialize. Memory/search tools that need the embedder should degrade or wait on readiness, not block boot.
(2a-iii) If sql.migrate() and graph.open() on a large store are themselves slow, ensure they cannot block the initialize response — keep correctness (a tool needing the db still waits for it) but the handshake must return first. Prefer minimal, surgical reordering over a rewrite.

HARD CONSTRAINTS: do NOT disable, mute, or weaken the audit engine or the audit-readiness gate (AGENTS.md hard rule — the chain is never muted); do NOT edit any CONSTITUTION.md; preserve fail-closed semantics (unverified chain ⇒ audited tools refused). Add/extend unit tests proving the transport/initialize path does not await embedder/completer availability. Build clean and the full daemon test suite must pass before done.</goal>
<parameter name="squad">engineering
