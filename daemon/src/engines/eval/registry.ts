/**
 * EvalAdapter dispatch registry. Looks up the right adapter by
 * (resource kind, consumer) and invokes it. Falls back to NoopEval which
 * returns delta=0 — the non-auto risk classes ignore the delta anyway.
 */
import type { Consumer, ResourceKind } from "../../schemas/resource.js";
import type { EvaluatorAdapter } from "../evolution.js";

export interface EvalAdapter {
  name: string;
  kinds: ResourceKind[];
  consumers: Consumer[] | "*";
  evaluate(input: {
    rid: string;
    kind: ResourceKind;
    consumer: Consumer;
    current_content: string;
    candidate_content: string;
  }): Promise<{ eval_delta: number; metric_scores: Record<string, number>; notes: string }>;
}

export class EvalRegistry implements EvaluatorAdapter {
  private adapters: EvalAdapter[] = [];

  register(adapter: EvalAdapter): void { this.adapters.push(adapter); }

  pick(kind: ResourceKind, consumer: Consumer): EvalAdapter | null {
    for (const a of this.adapters) {
      if (!a.kinds.includes(kind)) continue;
      if (a.consumers !== "*" && !a.consumers.includes(consumer)) continue;
      return a;
    }
    return null;
  }

  async evaluate(input: { rid: string; kind: ResourceKind; consumer: Consumer; current_content: string; candidate_content: string }): Promise<{ eval_delta: number; metric_scores: Record<string, number>; notes: string }> {
    const a = this.pick(input.kind, input.consumer);
    if (!a) return { eval_delta: 0, metric_scores: {}, notes: `no adapter for (${input.kind}, ${input.consumer})` };
    return a.evaluate(input);
  }
}
