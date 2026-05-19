import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/stores/sqlite.js";
import { AuditEngine } from "../src/engines/audit.js";
import { PolicyEngine } from "../src/engines/policy.js";
import { EvolutionEngine } from "../src/engines/evolution.js";
import { EvalRegistry } from "../src/engines/eval/registry.js";
import { YamlStructuralEval } from "../src/engines/eval/yaml-structural.js";
import { RubricBacktestEval } from "../src/engines/eval/rubric-backtest.js";
import { NoopEval } from "../src/engines/eval/noop.js";
import { WriteRouter } from "../src/engines/writeback.js";
import type { Envelope } from "../src/schemas/envelope.js";

describe("eval adapters", () => {
  it("YamlStructuralEval rejects candidate that drops stages", async () => {
    const a = new YamlStructuralEval();
    const r = await a.evaluate({
      rid: "x", kind: "team", consumer: "pp",
      current_content: "name: t\nstages: [spec, code, tests]\n",
      candidate_content: "name: t\nstages: [spec, code]\n",
    });
    expect(r.eval_delta).toBe(-1);
    expect(r.notes).toMatch(/missing stages/);
  });

  it("YamlStructuralEval rejects candidate that broadens tools", async () => {
    const a = new YamlStructuralEval();
    const r = await a.evaluate({
      rid: "x", kind: "team", consumer: "pp",
      current_content: "name: t\ntools: [Read, Grep]\n",
      candidate_content: "name: t\ntools: [Read, Grep, Bash]\n",
    });
    expect(r.eval_delta).toBe(-1);
    expect(r.notes).toMatch(/broadens tool/);
  });

  it("YamlStructuralEval passes a benign edit", async () => {
    const a = new YamlStructuralEval();
    const r = await a.evaluate({
      rid: "x", kind: "team", consumer: "pp",
      current_content: "name: t\nstages: [spec, code]\n",
      candidate_content: "name: t\ndescription: more detail\nstages: [spec, code]\n",
    });
    expect(r.eval_delta).toBeGreaterThan(0);
  });

  it("RubricBacktestEval scores by heuristic structural signals", async () => {
    const a = new RubricBacktestEval();
    const current = "stub";
    const candidate = `---\nname: r\n---\n## Scoring\nThe agent MUST do X. SHOULD do Y. Long elaboration over 400 chars so the length signal fires properly. Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua, enim ad minim veniam.`;
    const r = await a.evaluate({ rid: "x", kind: "rubric", consumer: "pp", current_content: current, candidate_content: candidate });
    expect(r.eval_delta).toBeGreaterThan(0);
  });

  it("EvalRegistry routes by (kind, consumer) and falls back to NoopEval", async () => {
    const reg = new EvalRegistry();
    reg.register(new YamlStructuralEval());
    reg.register(new NoopEval());
    const yaml = await reg.evaluate({ rid: "x", kind: "team", consumer: "pp", current_content: "stages: [a]", candidate_content: "stages: [a]" });
    expect(yaml.notes).toMatch(/structural/);
    const fallback = await reg.evaluate({ rid: "x", kind: "agent", consumer: "execsuite", current_content: "foo", candidate_content: "bar" });
    expect(fallback.eval_delta).toBe(0);
  });
});

describe("evolution engine uses the evaluator on evaluate()", () => {
  let dir: string;
  let sql: SqliteStore;
  let engine: EvolutionEngine;
  const env: Envelope = {
    tenant_id: "local", actor_id: "eval-test",
    project_id: "TheEights", domain: "infra",
    scope: [], trace_id: "t-eval",
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-eval-"));
    sql = new SqliteStore(join(dir, "state.db"));
    sql.migrate();
    const audit = new AuditEngine(sql, join(dir, "events"));
    const policy = new PolicyEngine(sql);
    engine = new EvolutionEngine(sql, join(dir, "resources"), policy, audit);
    engine.setWriteRouter(new WriteRouter([]));
    const reg = new EvalRegistry();
    reg.register(new YamlStructuralEval());
    reg.register(new NoopEval());
    engine.setEvaluator(reg);
    engine.register(env, {
      rid: "resource:test.team.demo",
      kind: "team", risk_class: "low",
      evolution_policy: "auto",   // force auto path for the test
      initial_content: "name: demo\nstages: [spec, code]\n",
    });
  });
  afterAll(() => { sql.close(); rmSync(dir, { recursive: true, force: true }); });

  it("auto-commits a benign team yaml change with delta>=0", async () => {
    const prop = engine.propose(env, {
      rid: "resource:test.team.demo",
      candidate_content: "name: demo\ndescription: now with more detail\nstages: [spec, code]\n",
      justification: "clarification",
    });
    const report = await engine.evaluate(env, prop.proposal_id);
    expect(report.eval_delta).toBeGreaterThan(0);
    const commit = await engine.commit(env, prop.proposal_id);
    expect(commit.committed).toBe(true);
  });

  it("rejects a candidate that drops stages (delta<0)", async () => {
    const prop = engine.propose(env, {
      rid: "resource:test.team.demo",
      candidate_content: "name: demo\nstages: [spec]\n",
      justification: "trying to remove a stage",
    });
    const report = await engine.evaluate(env, prop.proposal_id);
    expect(report.eval_delta).toBe(-1);
    const commit = await engine.commit(env, prop.proposal_id);
    expect(commit.committed).toBe(false);
    expect(commit.reason).toMatch(/eval_delta/);
  });
});
