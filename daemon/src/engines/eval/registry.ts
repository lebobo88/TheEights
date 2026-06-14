/**
 * EvalAdapter dispatch registry. Looks up the right adapter by
 * (resource kind, consumer) and invokes it. Falls back to NoopEval which
 * returns delta=0 — the non-auto risk classes ignore the delta anyway.
 */
import type { Consumer, ResourceKind, RiskClass } from "../../schemas/resource.js";
import type { EvaluatorAdapter } from "../evolution.js";

/** The full evaluation context handed to every adapter. */
export interface EvalInput {
  rid: string;
  kind: ResourceKind;
  consumer: Consumer;
  /** Resource risk class — drives judge-tier escalation (high/critical → human/agent judge). */
  risk_class: RiskClass;
  /** Proposal justification — lets diff-aware adapters detect registrar drift resyncs. */
  justification: string;
  current_content: string;
  candidate_content: string;
}

export interface EvalResult {
  eval_delta: number;
  metric_scores: Record<string, number>;
  notes: string;
  /** True when no adapter was found for (kind, consumer). The caller MUST treat
   *  this as a hard block — delta=-1 is belt-and-suspenders, but this flag is
   *  the authoritative gate (TE-EV-2). */
  evaluator_missing?: boolean;
  /** True when the adapter matched on (kind, consumer) but the *content* is not
   *  in the genre this adapter handles (e.g. YamlStructuralEval handed a prose
   *  design-decision rather than a YAML mapping). This is a soft "wrong tool —
   *  try the next adapter" signal, NOT a block: the registry skips this adapter
   *  and falls through to the next matching one. Distinct from evaluator_missing,
   *  which is a hard fail-closed block. An adapter MUST NOT set both. */
  not_applicable?: boolean;
}

export interface EvalAdapter {
  name: string;
  kinds: ResourceKind[];
  consumers: Consumer[] | "*";
  evaluate(input: EvalInput): Promise<EvalResult>;
}

export class EvalRegistry implements EvaluatorAdapter {
  private adapters: EvalAdapter[] = [];

  register(adapter: EvalAdapter): void { this.adapters.push(adapter); }

  /** All adapters that match on (kind, consumer), in registration order. */
  matching(kind: ResourceKind, consumer: Consumer): EvalAdapter[] {
    return this.adapters.filter(
      (a) => a.kinds.includes(kind) && (a.consumers === "*" || a.consumers.includes(consumer)),
    );
  }

  /** Back-compat: the first matching adapter (or null). */
  pick(kind: ResourceKind, consumer: Consumer): EvalAdapter | null {
    return this.matching(kind, consumer)[0] ?? null;
  }

  async evaluate(input: EvalInput): Promise<EvalResult> {
    const candidates = this.matching(input.kind, input.consumer);
    if (candidates.length === 0) {
      // TE-EV-2: no adapter matched — return explicit failure so callers cannot
      // silently treat delta=0 as "ok to commit".
      return {
        eval_delta: -1,
        evaluator_missing: true,
        metric_scores: {},
        notes: `no adapter for (${input.kind}, ${input.consumer}) — evaluator_missing`,
      };
    }
    // Layered fallthrough: try each matching adapter in order. An adapter that
    // returns not_applicable is the wrong tool for this content genre (e.g.
    // structural handed prose) — skip it and try the next. A result that is
    // NOT not_applicable is authoritative and returned as-is (including a hard
    // evaluator_missing block, e.g. LLM judge with the LLM down — that must NOT
    // silently fall through to a permissive noop).
    let lastDeferred: EvalResult | null = null;
    for (const a of candidates) {
      const r = await a.evaluate(input);
      if (r.not_applicable) { lastDeferred = r; continue; }
      return r;
    }
    // Every matching adapter deferred — fail closed (TE-EV-2).
    return {
      eval_delta: -1,
      evaluator_missing: true,
      metric_scores: lastDeferred?.metric_scores ?? {},
      notes: `all matching adapters deferred (not_applicable) for (${input.kind}, ${input.consumer}) — evaluator_missing`,
    };
  }
}
