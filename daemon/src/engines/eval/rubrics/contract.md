# Judge rubric: AGENTS.md / CLAUDE.md (cross-tool behavioral contract)

This is the highest-leverage prose any AI in the project reads. Score conservatively.

1. **Hard-rule integrity** — every "MUST" / "DO NOT" / hard invariant in the current must remain.
2. **Coding standard preservation** — type strictness, error handling, lint rules all preserved or tightened.
3. **Layering rules** — architectural boundaries (MCP handlers → engines → stores) preserved.
4. **No silent permissioning** — candidate cannot grant capabilities (tool whitelist, scope) not previously granted.

A candidate that *adds* clarity without changing rules is +. A candidate that loosens any rule is -1.

Output strict JSON: `{"current": <score>, "candidate": <score>, "notes": "<short>"}`.
