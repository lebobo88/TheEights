/**
 * PromptDriftEval — diff-aware evaluator for registrar source-drift resyncs.
 *
 * When a `.claude/` source file changes on disk, the registrar files a proposal
 * to re-register the new hash (justification: "registrar re-scan: source file
 * changed"). The right governance question for these is NOT "is the new prose a
 * higher-quality persona?" (that's what the LLM judge answers) — it is "is this
 * change a benign sync, or did the on-disk edit quietly remove a guardrail or
 * collapse the content?" This adapter answers that with a cheap, deterministic
 * safety-diff — no LLM, no rubber-stamp.
 *
 * Routing: it only CLAIMS a proposal whose justification marks it a drift resync;
 * for any other prose change it returns not_applicable so the registry falls
 * through to the LLM judge (a genuine rewrite deserves a real quality read).
 *
 *   - benign resync  → small positive delta (committable; a human still approves).
 *   - suspicious diff → -1 (blocks auto-approve; routes to manual review).
 */
import type { Consumer, ResourceKind } from "../../schemas/resource.js";
import type { EvalAdapter, EvalInput, EvalResult } from "./registry.js";

const DRIFT_JUSTIFICATION = /registrar re-?scan|source file changed|source drift|re-?scan:\s*source/i;

// RFC-2119-style guardrail tokens. A resync that drops these has weakened the
// contract and must not pass unattended.
const NORMATIVE = /\b(MUST NOT|SHALL NOT|SHOULD NOT|MUST|SHALL|SHOULD|REQUIRED|PROHIBITED|NEVER|ALWAYS)\b/g;

export class PromptDriftEval implements EvalAdapter {
  readonly name = "prompt-drift";
  readonly kinds: ResourceKind[] = ["prompt", "agent", "skill", "command", "contract"];
  readonly consumers: Consumer[] | "*" = "*";

  async evaluate(input: EvalInput): Promise<EvalResult> {
    if (!DRIFT_JUSTIFICATION.test(input.justification)) {
      // Not a registrar resync — a genuine edit. Defer to the LLM judge.
      return { eval_delta: 0, not_applicable: true, metric_scores: {}, notes: "not a registrar drift resync — deferring to the quality judge" };
    }

    const cur = input.current_content ?? "";
    const cand = input.candidate_content ?? "";

    const curNorm = countMatches(cur, NORMATIVE);
    const candNorm = countMatches(cand, NORMATIVE);
    const sizeRatio = cur.length === 0 ? 1 : cand.length / cur.length;
    const similarity = jaccard(tokenSet(cur), tokenSet(cand));
    const metric_scores = { normative_current: curNorm, normative_candidate: candNorm, size_ratio: round(sizeRatio), similarity: round(similarity) };

    if (cand.trim().length === 0) {
      return { eval_delta: -1, metric_scores, notes: "drift resync emptied the resource — blocked, needs manual review" };
    }
    if (candNorm < curNorm) {
      return { eval_delta: -1, metric_scores, notes: `drift resync removed normative/guardrail language (MUST/SHALL/SHOULD: ${curNorm}→${candNorm}) — blocked, needs manual review` };
    }
    if (sizeRatio < 0.7) {
      return { eval_delta: -1, metric_scores, notes: `drift resync collapsed content to ${Math.round(sizeRatio * 100)}% of current — blocked, needs manual review` };
    }

    // Benign sync: guardrails intact, content not gutted. Small positive so the
    // proposal is committable; the resource is still hitl-only so a human approves.
    return {
      eval_delta: 0.1,
      metric_scores,
      notes: `benign source-drift resync — guardrails intact (normative ${curNorm}→${candNorm}), size ${Math.round(sizeRatio * 100)}%, ~${Math.round(similarity * 100)}% token overlap`,
    };
  }
}

function countMatches(s: string, re: RegExp): number {
  const m = s.match(re);
  return m ? m.length : 0;
}

function tokenSet(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

function round(n: number): number { return Math.round(n * 1000) / 1000; }
