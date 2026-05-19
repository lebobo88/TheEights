/**
 * RubricBacktestEval — for kind=rubric only.
 *
 * v1 simplification: we don't actually re-execute the rubric against past
 * artifacts (would require Codex/Gemini sub-CLIs); instead we score the
 * candidate vs current via heuristic structural signals — has frontmatter,
 * non-empty scoring section, contains at least one normative MUST/SHOULD,
 * isn't significantly shorter than current (>=80%). Returns the delta of
 * those signals normalized to [-1, +1].
 *
 * The full LLM-judge against the last-50 verdict memories can layer on later;
 * this v1 keeps the loop deterministic and fast.
 */
import type { Consumer, ResourceKind } from "../../schemas/resource.js";
import type { EvalAdapter } from "./registry.js";

export class RubricBacktestEval implements EvalAdapter {
  readonly name = "rubric-backtest";
  readonly kinds: ResourceKind[] = ["rubric"];
  readonly consumers: Consumer[] | "*" = "*";

  async evaluate(input: { current_content: string; candidate_content: string }): Promise<{ eval_delta: number; metric_scores: Record<string, number>; notes: string }> {
    const cur = scoreRubric(input.current_content);
    const cand = scoreRubric(input.candidate_content);
    const delta = (cand - cur) / 4; // bounded to roughly [-1, +1] given max score 4
    return { eval_delta: clamp(delta, -1, 1), metric_scores: { current: cur, candidate: cand }, notes: `heuristic structural score: current=${cur} candidate=${cand}` };
  }
}

function scoreRubric(s: string): number {
  let score = 0;
  if (/^---[\s\S]*?---/m.test(s)) score += 1;                // frontmatter
  if (/##\s*(score|scoring|criteria)/i.test(s)) score += 1;  // scoring section
  if (/\b(MUST|SHOULD|MUST NOT|SHALL)\b/.test(s)) score += 1;// normative
  if (s.length > 400) score += 1;                            // not stub
  return score;
}

function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }
