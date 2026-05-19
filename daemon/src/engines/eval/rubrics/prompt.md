# Judge rubric: prompt (general)

For prompts that aren't agents/skills/commands/contracts — the generic "what task should the model do" class. Score:

1. **Task clarity** — what success looks like is concrete.
2. **Constraint preservation** — any prior format/length/style constraints retained.
3. **Output schema** — if the original specified an output structure, candidate must keep it.
4. **No scope creep** — candidate doesn't ask for capabilities the original didn't.

Output strict JSON: `{"current": <score>, "candidate": <score>, "notes": "<short>"}`.
