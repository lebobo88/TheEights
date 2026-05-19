# ADR-0004 — Autogenesis-aligned resource model

**Status:** Accepted (2026-05-18)
**References:** arxiv 2604.15034; reference implementation `vinayak1998/Autogenesis`.

## Decision

Every modifiable artifact in the system (prompt, team yaml, rubric, tool wrapper, workflow, memory schema, policy) is a **Resource** with:

- a stable `rid` (resource id, e.g. `resource:pp.team.feature-team`)
- a `kind`
- a `risk_class` (`low | medium | high | critical`)
- a `current_version` (content-addressed hash)
- a list of signed past versions
- an `evolution_policy` (`auto | auto-low-risk | hitl-only | frozen`)

Mutation goes through the Evolution Engine, never direct file edits. The Engine implements RSPL (resource lifecycle) + SEPL (proposal/eval/commit/rollback) as described in the Autogenesis paper.

## Rationale

- Treating everything mutable as a versioned resource is the only way to reason about "what evolved, when, why, and how to roll it back" — directly addresses the "misevolution" risks in the reference research.
- Aligns with the only open-source RSPL/SEPL reference impl available, so we can borrow API shape and idioms.

## Consequences

- File-based prompt edits in consumer systems eventually flow through `eights.evolution.propose`, not raw filesystem edits. v1 keeps consumer prompts where they are; v2 lifts them into the resource registry.
- The Evolution Engine is the only writer to `~/.eights/resources/`.
