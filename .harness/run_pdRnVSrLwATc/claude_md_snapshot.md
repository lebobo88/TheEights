# CLAUDE.md

@AGENTS.md

This file is Claude Code's view into the project's behavioral contract. It is intentionally a thin shim: the canonical contract is `AGENTS.md`, which every AI agent (Claude Code, Codex, Gemini, Hydra-spawned workers, sibling MCP clients) is expected to read at session start. If `CLAUDE.md` and `AGENTS.md` ever drift, `AGENTS.md` wins.

Read `ARCHITECTURE.md` first for the layered design, then `ROADMAP.md` for phase scope. Hard invariants live in `ARCHITECTURE.md` §12; never edit `CONSTITUTION.md`.

**Session-status hook.** A `SessionStart` hook (`.claude/hooks/eights-session-status.ps1`, wired in `.claude/settings.json`) surfaces a one-line daemon pulse at session open — pending evolution proposals, source-drift count, and audit-chain health. It is advisory and never blocks; if the CLI build is absent it exits silently.
