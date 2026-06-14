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
import type { Consumer, ResourceKind, RiskClass } from "../../schemas/resource.js";
import type { EvolutionEngine } from "../evolution.js";
import type { Completer } from "./completer.js";
import type { EvalAdapter, EvalInput, EvalResult } from "./registry.js";

const RISK_RANK: Record<RiskClass, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Judge-tier escalation: prose proposals at or above `atOrAbove` risk are judged
 * by `completer` (typically a human/agent ManualCompleter) instead of the fast
 * automated model — the stakes warrant a stronger judge. See providers/manual-completer.ts.
 */
export interface JudgeEscalation {
  completer: Completer;
  atOrAbove: RiskClass;
}

// Prose/persona kinds the LLM judge owns outright (no structural analogue),
// PLUS the config kinds (schema/workflow/team/squad) for which YamlStructuralEval
// defers when their content is a prose design-decision rather than a YAML mapping.
// For those config kinds the registry runs structural FIRST; the LLM judge only
// gets the turn when structural returns not_applicable (i.e. the content is prose).
const PROSE_KINDS: ResourceKind[] = [
  "agent", "skill", "command", "contract", "prompt",
  "schema", "workflow", "team", "squad",
];

export class LlmJudgeEval implements EvalAdapter {
  readonly name = "llm-judge";
  readonly kinds: ResourceKind[] = PROSE_KINDS;
  readonly consumers: Consumer[] | "*" = "*";

  constructor(
    private readonly engine: EvolutionEngine,
    private readonly llm: Completer,
    private readonly escalation?: JudgeEscalation,
  ) {}

  /** Pick the judge for this proposal: escalate high-risk prose to the stronger judge. */
  private judgeFor(risk: RiskClass): { completer: Completer; tier: "automated" | "escalated" } {
    if (this.escalation && RISK_RANK[risk] >= RISK_RANK[this.escalation.atOrAbove]) {
      return { completer: this.escalation.completer, tier: "escalated" };
    }
    return { completer: this.llm, tier: "automated" };
  }

  async evaluate(input: EvalInput): Promise<EvalResult> {
    const { completer: judge, tier } = this.judgeFor(input.risk_class);
    const tag = tier === "escalated" ? " [escalated: human/agent judge]" : "";

    // TE-EV-2 (#2b): LLM unavailable / null / parse-failure MUST block commit,
    // not pass on delta=0. Return evaluator_missing:true so the evolution engine's
    // evaluator_missing!==false gate rejects the proposal. We do NOT throw because
    // we want to preserve diagnostic notes; the evaluator_missing flag is the gate.
    if (!(await judge.available())) {
      return { eval_delta: -1, evaluator_missing: true, metric_scores: {}, notes: `judge unavailable — blocked (evaluator_missing)${tag}` };
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

    const raw = await judge.complete(system, user, { temperature: 0.1, maxTokens: 256 });
    if (!raw) {
      return { eval_delta: -1, evaluator_missing: true, metric_scores: {}, notes: `judge returned no content — blocked (evaluator_missing)${tag}` };
    }

    const parsed = extractJson(raw);
    if (!parsed) {
      return { eval_delta: -1, evaluator_missing: true, metric_scores: { raw_len: raw.length }, notes: `failed to parse LLM JSON — blocked (evaluator_missing): ${raw.slice(0, 200)}` };
    }

    // FIX 1: validate that both current and candidate are finite numbers in [-1, 1].
    // A parsed-but-invalid result (missing fields, non-number, NaN, Infinity, out of range)
    // must fail closed — do NOT coerce undefined/null/NaN to 0 (which would pass the gate).
    const rawCur = parsed["current"];
    const rawCand = parsed["candidate"];
    const isValidScore = (x: unknown): x is number =>
      typeof x === "number" && Number.isFinite(x) && x >= -1 && x <= 1;
    if (!isValidScore(rawCur) || !isValidScore(rawCand)) {
      return {
        eval_delta: -1,
        evaluator_missing: true,
        metric_scores: {},
        notes: `LLM JSON shape invalid — blocked (evaluator_missing): current=${JSON.stringify(rawCur)}, candidate=${JSON.stringify(rawCand)}`,
      };
    }

    const delta = rawCand - rawCur;
    const baseNotes = typeof parsed["notes"] === "string" ? parsed["notes"].slice(0, 480) : "(no notes)";
    return {
      eval_delta: delta,
      // evaluator_missing is intentionally absent (falsy) on success so the
      // evolution engine's evaluator_missing!==false check sees a clear pass.
      metric_scores: { current_score: rawCur, candidate_score: rawCand },
      notes: `${baseNotes}${tag}`,
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
