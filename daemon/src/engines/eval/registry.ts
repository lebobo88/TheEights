/**
 * EvalAdapter dispatch registry. Looks up the right adapter by
 * (resource kind, consumer) and invokes it. Falls back to NoopEval which
 * returns delta=0 — the non-auto risk classes ignore the delta anyway.
 */
import type { Consumer, ResourceKind } from "../../schemas/resource.js";
import type { EvaluatorAdapter } from "../evolution.js";

export interface EvalResult {
  eval_delta: number;
  metric_scores: Record<string, number>;
  notes: string;
  /** True when no adapter was found for (kind, consumer). The caller MUST treat
   *  this as a hard block — delta=-1 is belt-and-suspenders, but this flag is
   *  the authoritative gate (TE-EV-2). */
  evaluator_missing?: boolean;
}

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
  }): Promise<EvalResult>;
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

  async evaluate(input: { rid: string; kind: ResourceKind; consumer: Consumer; current_content: string; candidate_content: string }): Promise<EvalResult> {
    const a = this.pick(input.kind, input.consumer);
    if (!a) {
      // TE-EV-2: no adapter matched — return explicit failure so callers cannot
      // silently treat delta=0 as "ok to commit".
      return {
        eval_delta: -1,
        evaluator_missing: true,
        metric_scores: {},
        notes: `no adapter for (${input.kind}, ${input.consumer}) — evaluator_missing`,
      };
    }
    return a.evaluate(input);
  }
}
