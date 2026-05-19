# ADR-0006 — Risk-class → default evolution policy

**Status:** Accepted (2026-05-18)

## Decision

The user's locked stance ("auto-commit on low-risk; HITL on the rest") is encoded as a deterministic mapping from `risk_class` to default `evolution_policy`:

| risk_class | default evolution_policy | rationale |
|---|---|---|
| `low` | `auto` | docs prompts, formatting templates, comment styles, changelog templates — wrong answers are cheap and observable |
| `medium` | `hitl-only` | team compositions, non-critical rubrics, retrieval prompts — drift here changes behavior shape, not safety |
| `high` | `hitl-only` | security/contract/spec gates, judging rubrics, taxonomy mappings — drift here changes correctness guarantees |
| `critical` | `frozen` | policy rules, identity/scope rules, governance gates themselves — drift here destroys the trust model |

`frozen` is not overridable by another resource. To modify a critical resource the operator runs `eights resource unfreeze <rid>` interactively, which itself is logged with a separate signature.

## Eval gate (applies to all auto commits)

Before any `auto` commit, `evolution.evaluate` must return `eval_delta >= 0` on the resource's pinned eval suite. Negative delta = reject + audit event, regardless of risk class.

## Consequences

- The Evolution Engine reads this mapping from a `policy` resource (`resource:eights.policy.evolution-defaults`) — so the mapping itself can evolve, but only via HITL (since the resource is `risk_class=critical` and therefore frozen).
- New resource kinds added by adapters must declare a default `risk_class`. The lint step at adapter load time enforces this.
