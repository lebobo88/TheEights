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

## Quickstart (Phase 0)

```powershell
cd C:\AiAppDeployments\TheEights\daemon
npm install
npm run build
npm start              # starts eights-daemon on stdio
```

Then point any MCP-capable client (Claude Code, Copilot CLI, Gemini CLI, Codex CLI) at the daemon via `.mcp.json`:

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
