# ADR-0008 — EvalAdapter contract + LLM-as-judge for non-deterministic kinds

**Status:** Accepted (2026-05-19, Phase 5)
**Replaces the Phase 3 stub** in `EvolutionEngine.evaluate()` which returned `eval_delta=0` for everything.

## Context

The Autogenesis SEPL flow requires a non-zero, defensible `eval_delta` for any auto-commit path. With Phase 5 expanding the evolvable surface from 3 internal seeds to ~200 consumer artifacts across many kinds (prompts, agents, skills, teams, rubrics, hooks, workflows), a single eval strategy doesn't fit. Different kinds need different signals.

## Decision

`EvalAdapter` is an interface; the EvolutionEngine dispatches `(kind, consumer)` to the registered adapter that claims the tuple. Four starter adapters ship:

| Adapter | Kinds | Strategy |
|---|---|---|
| `LlmJudgeEval` | `agent`, `skill`, `command`, `contract`, `prompt` (prose) | Calls a local LLM (default: Ollama via `OllamaCompleter`) with a per-kind **judge rubric** (itself a frozen Resource), the current + candidate content, and top-K evidence memories. Expects a scalar score in `[-1, +1]` for each; returns the delta. |
| `RubricBacktestEval` | `rubric` | Re-runs the candidate rubric against a sliding window of the last 50 verdict memories. Returns delta in `(passed_rate, outcome_stability)` vs. current. |
| `YamlStructuralEval` | `team`, `workflow`, `schema` | Parses both yamls. Verifies schema, runs property tests (no removed stages, no broadened tool whitelists, all referenced agent ids still exist). Returns `+0.1` on clean structural pass, `-1` on any structural violation. |
| `NoopEval` | catch-all | Returns `delta=0`. The non-auto risk classes (medium/high) ignore the delta anyway because `hitl-only` skips the auto gate. |

## Per-kind judge rubrics — frozen resources

The judge rubric for each prose kind is itself an evolvable resource — but with `risk_class=critical, evolution_policy=frozen`. This is hard invariant #7: **evolution cannot mutate the criteria it is evaluated by**. Unfreeze requires operator-signed override and creates a separate audit event.

Seeded rubrics:
- `resource:eights.eval-rubric.agent`
- `resource:eights.eval-rubric.skill`
- `resource:eights.eval-rubric.command`
- `resource:eights.eval-rubric.contract`
- `resource:eights.eval-rubric.prompt`

Bodies in `daemon/src/engines/eval/rubrics/*.md`, loaded at `seedCriticalResources()` time.

## Local LLM by default

`OllamaCompleter` mirrors `OllamaEmbedder`: detects `localhost:11434`, uses `gpt-oss:20b` by default (already pulled per Phase 1 observation), falls back to `qwen3:4b` if not available, returns `null` and the eval surfaces a `NoopEval`-equivalent if Ollama is unreachable. Configurable via `EIGHTS_LLM_MODEL`.

## Score normalization

Each adapter normalizes to `eval_delta ∈ [-1, +1]`. Composite adapters that want to combine signals do so by their own definition; the registry just returns whatever the matched adapter produced. Adapters MUST include their reasoning in `notes` and per-metric scores in `metric_scores`.

## Cost ceiling

LLM-as-judge calls are cheap on local hardware but not free. The miner-driven proposal pipeline gates eval frequency: a pattern needs to cross a `confidence > 0.55, count >= 3` threshold before a proposal is even drafted. Drafts go to evaluation only once. Adapters MAY cache per `(rid, current_version, candidate_version)` hash to avoid re-eval.

## Consequences

- `daemon/src/engines/eval/` is the new home for eval logic.
- `evolution.evaluate()` becomes a thin dispatch + audit wrapper around the registry.
- Eval-rubric resources land as the first non-policy critical-frozen seeds.
- The audit log gains structured eval reports per proposal — the `EvaluationReport.metric_scores` field is now actually populated.
