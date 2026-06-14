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

  it("YamlStructuralEval defers (not_applicable) on prose, never throws or emits garbage keys", async () => {
    const a = new YamlStructuralEval();
    // Real failure modes from the R6 batch: prose design-decisions of kind=schema.
    const r1 = await a.evaluate({
      rid: "x", kind: "schema", consumer: "rlm",
      current_content: "Roles are admin, collaborator, client, anonymous.",
      candidate_content: "Denormalize entity_mode onto hot-path tables (invoices, contracts) only; join elsewhere.",
    });
    expect(r1.not_applicable).toBe(true);
    expect(r1.eval_delta).not.toBe(-1);          // no spurious failure verdict
    expect(r1.notes).not.toMatch(/\b0, 1, 2\b/); // no character-index key enumeration
  });

  it("YamlStructuralEval defers on a mapping-vs-prose mix without throwing", async () => {
    const a = new YamlStructuralEval();
    // The exact crash shape from the R6 batch: current parses to a YAML mapping,
    // candidate is bare prose (parses to a string). Old code did `key in <string>`
    // and threw "Cannot use 'in' operator". Now it must defer cleanly.
    const r = await a.evaluate({
      rid: "x", kind: "schema", consumer: "eights",
      current_content: "name: cms\nblocks: [hero, footer]\n",
      candidate_content: "Add twenty new content blocks across the services and contact pages without removing existing ones.",
    });
    expect(r.not_applicable).toBe(true);
  });

  it("YamlStructuralEval defers prose that parses as a single-key mapping (space in key)", async () => {
    const a = new YamlStructuralEval();
    // The R6 'postgis_upgrade' / 'audit_triggers_scope' shape: a prose sentence
    // whose leading "Word word:" makes YAML produce {"PostGIS extension": ...}.
    const r = await a.evaluate({
      rid: "x", kind: "schema", consumer: "rlm",
      current_content: "PostGIS extension: present in the current data model.",
      candidate_content: "Defer the PostGIS extension until a Phase 6 geospatial need is proven.",
    });
    expect(r.not_applicable).toBe(true);
    expect(r.eval_delta).not.toBe(-1);
  });

  it("EvalRegistry falls through a deferring structural adapter to the next match", async () => {
    const reg = new EvalRegistry();
    reg.register(new YamlStructuralEval());
    reg.register(new NoopEval());
    // kind=schema prose: structural defers -> noop applies (delta 0).
    const r = await reg.evaluate({
      rid: "x", kind: "schema", consumer: "rlm",
      current_content: "prose A with no mapping",
      candidate_content: "prose B with no mapping",
    });
    expect(r.not_applicable).toBeFalsy();
    expect(r.eval_delta).toBe(0);
    expect(r.notes).toMatch(/noop/);
  });

  it("EvalRegistry fails closed (evaluator_missing) when every matching adapter defers", async () => {
    const reg = new EvalRegistry();
    reg.register(new YamlStructuralEval()); // the only adapter; defers on prose
    const r = await reg.evaluate({
      rid: "x", kind: "schema", consumer: "rlm",
      current_content: "prose A", candidate_content: "prose B",
    });
    expect(r.evaluator_missing).toBe(true);
    expect(r.eval_delta).toBe(-1);
  });

  it("EvalRegistry covers kind=squad (previously evaluator_missing)", async () => {
    const reg = new EvalRegistry();
    reg.register(new YamlStructuralEval());
    reg.register(new NoopEval());
    const r = await reg.evaluate({
      rid: "x", kind: "squad", consumer: "hydra",
      current_content: "entrypoint: stub", candidate_content: "entrypoint: claude-skill",
    });
    expect(r.evaluator_missing).toBeFalsy();
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
    // propose() requires the acting actor to exist in the actors table.
    sql.db.prepare(
      `INSERT OR IGNORE INTO actors(actor_id, kind, created_at) VALUES (?, 'human', datetime('now'))`,
    ).run("eval-test");
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
