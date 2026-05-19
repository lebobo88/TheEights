import type { Consumer, ResourceKind } from "../../schemas/resource.js";
import type { EvalAdapter } from "./registry.js";

const ALL: ResourceKind[] = ["prompt", "team", "rubric", "tool", "workflow", "schema", "policy", "agent", "skill", "command", "hook", "contract"];

export class NoopEval implements EvalAdapter {
  readonly name = "noop";
  readonly kinds: ResourceKind[] = ALL;
  readonly consumers: Consumer[] | "*" = "*";

  async evaluate(): Promise<{ eval_delta: number; metric_scores: Record<string, number>; notes: string }> {
    return { eval_delta: 0, metric_scores: {}, notes: "noop eval — HITL only kinds; delta=0 by design" };
  }
}
