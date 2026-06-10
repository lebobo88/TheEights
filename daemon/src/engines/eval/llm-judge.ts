/**
 * LlmJudgeEval — scores `candidate` vs `current` for prose/persona kinds
 * (agent, skill, command, contract, prompt) using a local LLM and a per-kind
 * judge rubric resource (frozen per ADR-0008).
 *
 * Score protocol: the judge returns two scalars in [-1, +1] — one for the
 * current content, one for the candidate. eval_delta = candidate - current.
 * On any parse error the adapter returns delta=0 with notes so the loop
 * stays safe (non-auto-commit paths ignore the delta anyway).
 */
import type { Consumer, ResourceKind } from "../../schemas/resource.js";
import type { EvolutionEngine } from "../evolution.js";
import type { Completer } from "./completer.js";
import type { EvalAdapter } from "./registry.js";

const PROSE_KINDS: ResourceKind[] = ["agent", "skill", "command", "contract", "prompt"];

export class LlmJudgeEval implements EvalAdapter {
  readonly name = "llm-judge";
  readonly kinds: ResourceKind[] = PROSE_KINDS;
  readonly consumers: Consumer[] | "*" = "*";

  constructor(
    private readonly engine: EvolutionEngine,
    private readonly llm: Completer,
  ) {}

  async evaluate(input: { rid: string; kind: ResourceKind; consumer: Consumer; current_content: string; candidate_content: string }): Promise<{ eval_delta: number; evaluator_missing?: boolean; metric_scores: Record<string, number>; notes: string }> {
    // TE-EV-2 (#2b): LLM unavailable / null / parse-failure MUST block commit,
    // not pass on delta=0. Return evaluator_missing:true so the evolution engine's
    // evaluator_missing!==false gate rejects the proposal. We do NOT throw because
    // we want to preserve diagnostic notes; the evaluator_missing flag is the gate.
    if (!(await this.llm.available())) {
      return { eval_delta: -1, evaluator_missing: true, metric_scores: {}, notes: "LLM unavailable — blocked (evaluator_missing)" };
    }
    const rubricRid = `resource:eights.eval-rubric.${input.kind}`;
    const rubric = this.engine.getResource(rubricRid);
    const rubricBody = rubric ? this.engine.readVersion(rubric.rid, rubric.current_version) : null;
    const system = [
      "You are an evaluation judge for TheEights' self-evolution loop.",
      "Score each version on the per-kind rubric below.",
      "Output STRICT JSON only, no prose: {\"current\": <score>, \"candidate\": <score>, \"notes\": \"<short>\"}",
      "Scores are floats in [-1, 1]. -1 = far worse than baseline; 0 = equivalent; +1 = clearly better.",
      "Be conservative: if uncertain, score near 0.",
      "",
      `Kind: ${input.kind}`,
      `Consumer: ${input.consumer}`,
      "",
      "Rubric:",
      rubricBody ?? "(no rubric body — use general quality, clarity, safety, role-fit signals)",
    ].join("\n");
    const user = [
      "=== CURRENT ===",
      input.current_content.slice(0, 4000),
      "",
      "=== CANDIDATE ===",
      input.candidate_content.slice(0, 4000),
      "",
      "Respond with JSON only.",
    ].join("\n");

    const raw = await this.llm.complete(system, user, { temperature: 0.1, maxTokens: 256 });
    if (!raw) {
      return { eval_delta: -1, evaluator_missing: true, metric_scores: {}, notes: "LLM returned no content — blocked (evaluator_missing)" };
    }

    const parsed = extractJson(raw);
    if (!parsed) {
      return { eval_delta: -1, evaluator_missing: true, metric_scores: { raw_len: raw.length }, notes: `failed to parse LLM JSON — blocked (evaluator_missing): ${raw.slice(0, 200)}` };
    }

    const cur = clamp(Number(parsed.current ?? 0), -1, 1);
    const cand = clamp(Number(parsed.candidate ?? 0), -1, 1);
    const delta = cand - cur;
    return {
      eval_delta: delta,
      // evaluator_missing is intentionally absent (falsy) on success so the
      // evolution engine's evaluator_missing!==false check sees a clear pass.
      metric_scores: { current_score: cur, candidate_score: cand },
      notes: typeof parsed.notes === "string" ? parsed.notes.slice(0, 500) : "(no notes)",
    };
  }
}

function extractJson(s: string): Record<string, unknown> | null {
  // Try direct parse first, then look for a JSON object in the output.
  try { return JSON.parse(s) as Record<string, unknown>; } catch { /* fall through */ }
  const match = s.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]) as Record<string, unknown>; } catch { return null; }
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(lo, Math.min(hi, n));
}
