import { describe, it, expect } from "vitest";
import { PromptDriftEval } from "../src/engines/eval/prompt-drift.js";
import { LlmJudgeEval } from "../src/engines/eval/llm-judge.js";
import type { Completer } from "../src/completer.js";
import type { EvolutionEngine } from "../src/engines/evolution.js";
import type { EvalInput } from "../src/engines/eval/registry.js";

function input(p: Partial<EvalInput>): EvalInput {
  return {
    rid: "x", kind: "prompt", consumer: "pp",
    risk_class: "high", justification: "",
    current_content: "", candidate_content: "",
    ...p,
  };
}

describe("PromptDriftEval — diff-aware drift resync evaluator", () => {
  const a = new PromptDriftEval();

  it("defers (not_applicable) when the justification is not a registrar resync", async () => {
    const r = await a.evaluate(input({ justification: "operator improved the wording", current_content: "a", candidate_content: "b" }));
    expect(r.not_applicable).toBe(true);
  });

  it("scores a benign resync with a small positive delta", async () => {
    const r = await a.evaluate(input({
      justification: "registrar re-scan: source file changed",
      current_content: "The agent MUST validate. It SHOULD log. Body line one. Body line two.",
      candidate_content: "The agent MUST validate. It SHOULD log. Body line one. Body line two. Added a clarifying sentence.",
    }));
    expect(r.not_applicable).toBeFalsy();
    expect(r.eval_delta).toBeGreaterThan(0);
    expect(r.notes).toMatch(/benign source-drift resync/);
  });

  it("blocks a resync that removes guardrail/normative language", async () => {
    const r = await a.evaluate(input({
      justification: "registrar re-scan: source file changed",
      current_content: "The agent MUST validate. It MUST NOT delete. It SHOULD log.",
      candidate_content: "The agent validates and logs.",
    }));
    expect(r.eval_delta).toBe(-1);
    expect(r.notes).toMatch(/normative\/guardrail/);
  });

  it("blocks a resync that collapses the content", async () => {
    const r = await a.evaluate(input({
      justification: "source file changed",
      current_content: "x".repeat(1000) + " MUST",
      candidate_content: "x".repeat(100) + " MUST",
    }));
    expect(r.eval_delta).toBe(-1);
    expect(r.notes).toMatch(/collapsed content/);
  });
});

// Minimal EvolutionEngine stand-in: LlmJudgeEval only calls getResource/readVersion
// to fetch an optional rubric body.
const engineStub = {
  getResource: () => null,
  readVersion: () => null,
} as unknown as EvolutionEngine;

class StubCompleter implements Completer {
  lastError: string | null = null;
  constructor(private readonly payload: string) {}
  async available(): Promise<boolean> { return true; }
  async complete(): Promise<string | null> { return this.payload; }
}

describe("LlmJudgeEval — judge-tier escalation by risk", () => {
  const primary = new StubCompleter('{"current":0,"candidate":0.2,"notes":"primary"}');
  const escalation = new StubCompleter('{"current":0,"candidate":0.9,"notes":"escalated"}');
  const judge = new LlmJudgeEval(engineStub, primary, { completer: escalation, atOrAbove: "high" });

  it("low-risk prose uses the fast automated judge", async () => {
    const r = await judge.evaluate(input({ risk_class: "low", current_content: "a", candidate_content: "b" }));
    expect(r.metric_scores.candidate_score).toBe(0.2);
    expect(r.notes).not.toMatch(/escalated/);
  });

  it("high-risk prose escalates to the manual/agent judge", async () => {
    const r = await judge.evaluate(input({ risk_class: "high", current_content: "a", candidate_content: "b" }));
    expect(r.metric_scores.candidate_score).toBe(0.9);
    expect(r.notes).toMatch(/\[escalated: human\/agent judge\]/);
  });

  it("critical-risk also escalates (>= threshold)", async () => {
    const r = await judge.evaluate(input({ risk_class: "critical", current_content: "a", candidate_content: "b" }));
    expect(r.metric_scores.candidate_score).toBe(0.9);
  });

  it("without an escalation slot, all risk levels use the primary judge", async () => {
    const j2 = new LlmJudgeEval(engineStub, primary);
    const r = await j2.evaluate(input({ risk_class: "critical", current_content: "a", candidate_content: "b" }));
    expect(r.metric_scores.candidate_score).toBe(0.2);
  });
});
