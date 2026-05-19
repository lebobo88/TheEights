# TheEights

**Persistent, self-evolving memory + governance fabric for every AI agent, team, and project in this workspace.**

TheEights is a local-first daemon + MCP server. It sits *below* your orchestrators (Hydra, pair-programmer, ExecutiveSuite, the RLM family) and gives them a shared persistent memory, an audit graph, governance gates (SSGM + LASM), and a gated self-evolution loop (Autogenesis RSPL/SEPL).

It is **not** an orchestrator. It is **not** an agent framework. It is the substrate the others plug into.

---

## What you get

- 🧠 **Hybrid memory** — vectors (sqlite-vec), graph (LadybugDB / Kuzu), episodic SQL — behind one MCP surface.
- 🛡️ **Governance plane** — SSGM consistency / decay / access gates; LASM defense-in-depth; redaction at the MCP boundary.
- 🔁 **Gated self-evolution** — every prompt, team, rubric, workflow is a versioned resource. Low-risk auto-commits; the rest queues for HITL review.
- 📜 **Auditable** — every read, write, and mutation is in an append-only event log + CycloneDX ML-BOM v1.7 export.
- 🔌 **Plug-compatible** — Mem0-/Anthropic-style memory tools; any MCP-capable agent can talk to it without code changes.

## Status

- ✅ Architecture locked (`ARCHITECTURE.md`)
- 🛠️ Phase 0 — daemon scaffold (this commit)
- ⏳ Phase 1 — pp-bridge → live cross-run recall
- ⏳ Phase 2 — Governance plane
- ⏳ Phase 3 — Evolution engine + HITL queue
- ⏳ Phase 4 — Hydra / ExecutiveSuite / RLM bridges

See `ROADMAP.md`.

## Quickstart

### 1. Build

```powershell
cd C:\AiAppDeployments\TheEights\daemon
npm install
npm run build
```

(Repeat under `cli/` if you intend to use the `eights` CLI.)

### 2. Register the MCP server

**Recommended — user scope (available in every project on this machine):**

```powershell
claude mcp add eights --scope user -- node C:/AiAppDeployments/TheEights/daemon/dist/index.js
claude mcp get eights      # expect: Scope: User config • Status: ✓ Connected
```

This writes to `~/.claude.json` (do not edit by hand). To remove later: `claude mcp remove eights -s user`. Restart any open Claude Code session for the registration to take effect — MCP servers are discovered at session start.

**Alternative — project scope** (a single project's `.mcp.json`, e.g. when pinning a specific build):

```jsonc
{
  "mcpServers": {
    "eights": {
      "command": "node",
      "args": ["C:/AiAppDeployments/TheEights/daemon/dist/index.js"]
    }
  }
}
```

The daemon reads `$env:EIGHTS_HOME` (default `~/.eights/`) and creates it on first run. The `eights` CLI is intentionally not added to PATH; invoke it as `node C:/AiAppDeployments/TheEights/cli/dist/index.js <cmd>` when needed.

## Layout

```
TheEights/
  ARCHITECTURE.md       # Reference architecture (read this first)
  ROADMAP.md            # Phased delivery plan
  AGENTS.md             # Behavioral contract for any AI working in this repo
  CLAUDE.md             # Claude Code shim → @AGENTS.md
  adrs/                 # Decisions
  daemon/               # Node 20 LTS daemon (MCP servers + engines + stores)
  cli/                  # `eights` CLI (thin shim over MCP)
  schemas/              # JSON Schemas (consumed by adapters)
```

## License

Internal, not yet decided. Treat as proprietary for now.
