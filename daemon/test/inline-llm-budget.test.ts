/**
 * Inline (request-path) completers forward the tight budget into Completer.complete,
 * and a degraded judge/classifier surfaces a bounded null / fail-closed result
 * rather than hanging.
 */
import { describe, it, expect } from "vitest";
import { CellClassifier } from "../src/cognitive/cell-classifier.js";
import { LlmJudgeEval } from "../src/engines/eval/llm-judge.js";
import type { Completer, CompletionOpts } from "../src/completer.js";
import type { EvolutionEngine } from "../src/engines/evolution.js";
import type { EvalInput } from "../src/engines/eval/registry.js";

/** Records the opts of the last complete() call; returns a configurable value. */
class SpyCompleter implements Completer {
  lastError: string | null = null;
  lastOpts: CompletionOpts | undefined;
  constructor(private readonly value: string | null, private readonly avail = true) {}
  async available(): Promise<boolean> { return this.avail; }
  async complete(_system: string, _user: string, opts?: CompletionOpts): Promise<string | null> {
    this.lastOpts = opts;
    return this.value;
  }
}

const BUDGET = { timeoutMs: 12_345, maxRetries: 0 };

describe("CellClassifier inline budget", () => {
  it("forwards the inline budget and returns null when the completer yields null (timeout)", async () => {
    const spy = new SpyCompleter(null);
    const classifier = new CellClassifier(spy, BUDGET);
    // Text with no keyword hit so it falls through to the completer.
    const cell = await classifier.classifyAsync("qzx wibble frob", "nondescript blob");
    expect(cell).toBeNull();
    expect(spy.lastOpts?.timeoutMs).toBe(BUDGET.timeoutMs);
    expect(spy.lastOpts?.maxRetries).toBe(BUDGET.maxRetries);
  });
});

describe("LlmJudgeEval inline budget", () => {
  const fakeEngine = {
    getResource: () => null,
    readVersion: () => null,
  } as unknown as EvolutionEngine;

  const input: EvalInput = {
    kind: "agent",
    consumer: "pp",
    risk_class: "low",
    current_content: "current",
    candidate_content: "candidate",
  } as EvalInput;

  it("forwards the inline budget into the judge completion", async () => {
    const spy = new SpyCompleter('{"current":0,"candidate":0.5,"notes":"ok"}');
    const judge = new LlmJudgeEval(fakeEngine, spy, undefined, BUDGET);
    await judge.evaluate(input);
    expect(spy.lastOpts?.timeoutMs).toBe(BUDGET.timeoutMs);
    expect(spy.lastOpts?.maxRetries).toBe(BUDGET.maxRetries);
  });

  it("fails closed (evaluator_missing) when the judge returns null (timeout)", async () => {
    const spy = new SpyCompleter(null);
    const judge = new LlmJudgeEval(fakeEngine, spy, undefined, BUDGET);
    const result = await judge.evaluate(input);
    expect(result.evaluator_missing).toBe(true);
    expect(result.eval_delta).toBeLessThan(0);
  });
});
