# Judge rubric: slash command

Slash commands are entrypoints. Score:

1. **Argument contract clarity** — what the command takes and produces is unambiguous.
2. **Side-effect transparency** — files written, branches modified, external calls all enumerated.
3. **Failure-mode docs** — what happens on error / partial result is explicit.
4. **Brevity** — commands are concise references, not tutorials.

Penalize:
- New side-effects not previously declared.
- Removed argument validation.

Output strict JSON: `{"current": <score>, "candidate": <score>, "notes": "<short>"}`.
