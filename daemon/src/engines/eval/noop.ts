import type { Consumer, ResourceKind } from "../../schemas/resource.js";
import type { EvalAdapter } from "./registry.js";

// NoopEval owns the kinds that are HITL-only *by design* — there is no
// meaningful automated signal, so delta=0 (the human is the evaluator).
// It is deliberately NOT a universal catch-all: config/prose kinds like `squad`
// and `redaction_policy` are covered by YamlStructuralEval / LlmJudgeEval, and
// `constitution` is frozen. A kind with no matching adapter anywhere fails closed
// (evaluator_missing) per TE-EV-2.
const ALL: ResourceKind[] = ["prompt", "team", "rubric", "tool", "workflow", "schema", "policy", "agent", "skill", "command", "hook", "contract"];

export class NoopEval implements EvalAdapter {
  readonly name = "noop";
  readonly kinds: ResourceKind[] = ALL;
  readonly consumers: Consumer[] | "*" = "*";

  async evaluate(): Promise<{ eval_delta: number; metric_scores: Record<string, number>; notes: string }> {
    return { eval_delta: 0, metric_scores: {}, notes: "noop eval — HITL only kinds; delta=0 by design" };
  }
}
