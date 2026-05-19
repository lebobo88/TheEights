# Judge rubric: skill (SKILL.md)

Skills encode decision frameworks. Score each on:

1. **Framework integrity** — formulas, thresholds, and escalation rules are intact and correctly stated.
2. **Hard-rule preservation** — any "MUST" / "MUST NOT" / explicit guardrails in the current must remain in the candidate (or be tightened, never loosened).
3. **Citation completeness** — domain references (WACC formula, GAAP/IFRS terms, regulatory cites) preserved.
4. **Practical applicability** — concrete steps an agent can follow, not abstract advice.

Penalize:
- Any loosening of a normative rule.
- Removal of citation or reference.
- Adding novel financial / clinical / legal claims without supporting reference.

Output strict JSON: `{"current": <score>, "candidate": <score>, "notes": "<short>"}`.
