/**
 * Deep-fix tests for evolution governance hardening (codex second-pass).
 *
 * #2a  evaluator_missing!==false gate: legacy reports with undefined field block commit
 * #2b  LlmJudgeEval fail-closed: unavailable/null/parse-fail → evaluator_missing:true
 * #3a  Full policy enumeration: auto-low-risk on non-low → blocked; unknown → blocked
 * #3b  Existing-resource compat check: stored critical+auto evaded on re-register → now caught
 * reg  importFromSource bypass: frozen → throws; hitl-only → proposal not direct write; low → imports
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/stores/sqlite.js";
import { AuditEngine } from "../src/engines/audit.js";
import { PolicyEngine } from "../src/engines/policy.js";
import { EvolutionEngine, contentHash } from "../src/engines/evolution.js";
import { GovernanceStateEngine } from "../src/engines/governance-state.js";
import { EvalRegistry } from "../src/engines/eval/registry.js";
import { WriteRouter } from "../src/engines/writeback.js";
import { LlmJudgeEval } from "../src/engines/eval/llm-judge.js";
import type { EvalAdapter } from "../src/engines/eval/registry.js";
import type { Completer } from "../src/engines/eval/completer.js";
import type { Envelope } from "../src/schemas/envelope.js";
import type { EvaluationReport } from "../src/schemas/proposal.js";

const ENV: Envelope = {
  tenant_id: "local", actor_id: "deepfix-test", project_id: "TheEights",
  domain: "infra", scope: [], trace_id: "t-deepfix",
};
const HUMAN_ENV: Envelope = { ...ENV, actor_id: "operator-rob" };

// ---------------------------------------------------------------------------
// Factory: isolated engine per test suite
// ---------------------------------------------------------------------------
function makeEngine(tag: string): { dir: string; sql: SqliteStore; engine: EvolutionEngine; governance: GovernanceStateEngine } {
  const dir = mkdtempSync(join(tmpdir(), `eights-df-${tag}-`));
  const sql = new SqliteStore(join(dir, "state.db"));
  sql.migrate();
  const audit = new AuditEngine(sql, join(dir, "events"));
  const policy = new PolicyEngine(sql);
  const governance = new GovernanceStateEngine(sql, audit);
  const engine = new EvolutionEngine(sql, join(dir, "resources"), policy, audit);
  engine.setWriteRouter(new WriteRouter([]));
  engine.setGovernance(governance);
  return { dir, sql, engine, governance };
}

function teardown(dir: string, sql: SqliteStore): void {
  sql.close();
  rmSync(dir, { recursive: true, force: true });
}

// Minimal passing adapter
const PASS_ADAPTER: EvalAdapter = {
  name: "pass", kinds: ["prompt", "squad", "agent", "policy"],
  consumers: "*",
  async evaluate() { return { eval_delta: 1, metric_scores: {}, notes: "ok" }; },
};

// ---------------------------------------------------------------------------
// #2a — legacy report with evaluator_missing===undefined blocks commit
// ---------------------------------------------------------------------------
describe("#2a — evaluator_missing!==false gate (legacy reports block)", () => {
  let dir: string; let sql: SqliteStore; let engine: EvolutionEngine;

  beforeAll(() => ({ dir, sql, engine } = makeEngine("2a")));
  afterAll(() => teardown(dir, sql));

  it("legacy evaluation with eval_delta:1 but NO evaluator_missing field -> commit blocked", async () => {
    const reg = new EvalRegistry();
    reg.register(PASS_ADAPTER);
    engine.setEvaluator(reg);

    engine.register(ENV, {
      rid: "resource:df.2a.prompt", kind: "prompt", risk_class: "low",
      evolution_policy: "auto", initial_content: "original",
    });
    const originalVersion = engine.getResource("resource:df.2a.prompt")!.current_version;

    const prop = engine.propose(ENV, {
      rid: "resource:df.2a.prompt", candidate_content: "improved",
      justification: "legacy eval test",
    });

    // Manually craft a legacy-style evaluation report WITHOUT evaluator_missing field.
    // Simulates a report persisted before the evaluator_missing field was introduced.
    const legacyReport: Partial<EvaluationReport> = {
      proposal_id: prop.proposal_id,
      eval_delta: 1,
      metric_scores: {},
      ssgm_gate_results: {
        consistency: { passed: true, conflicts: [], enforced: false },
        temporal_decay: { passed: true, enforced: false },
        access_control: { passed: true, enforced: false },
      },
      notes: "legacy report",
      // evaluator_missing intentionally absent (undefined)
    };
    sql.db.prepare(`UPDATE proposals SET evaluation_json = ? WHERE proposal_id = ?`)
      .run(JSON.stringify(legacyReport), prop.proposal_id);

    const result = await engine.commit(ENV, prop.proposal_id);
    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/evaluator_missing/);
    // Version must be unchanged.
    expect(engine.getResource("resource:df.2a.prompt")!.current_version).toBe(originalVersion);
  });

  it("report with evaluator_missing===false and delta>=0 -> commits", async () => {
    const reg = new EvalRegistry();
    reg.register(PASS_ADAPTER);
    engine.setEvaluator(reg);

    const prop = engine.propose(ENV, {
      rid: "resource:df.2a.prompt", candidate_content: "properly evaluated content",
      justification: "valid eval",
    });
    // Use the real evaluate() which sets evaluator_missing:false on success.
    const report = await engine.evaluate(ENV, prop.proposal_id);
    expect(report.evaluator_missing).toBe(false);

    const result = await engine.commit(ENV, prop.proposal_id);
    expect(result.committed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #2b — LlmJudgeEval fail-closed
// ---------------------------------------------------------------------------
describe("#2b — LlmJudgeEval fail-closed (unavailable/null/parse-fail)", () => {
  // Stub Completer implementations
  const unavailableCompleter: Completer = {
    async available() { return false; },
    async complete() { return null; },
  };
  const nullReturnCompleter: Completer = {
    async available() { return true; },
    async complete() { return null; },
  };
  const badJsonCompleter: Completer = {
    async available() { return true; },
    async complete() { return "not valid json at all {{{"; },
  };
  const goodCompleter: Completer = {
    async available() { return true; },
    async complete() { return JSON.stringify({ current: 0.1, candidate: 0.8, notes: "ok" }); },
  };

  it("LLM unavailable -> evaluator_missing:true, delta:-1", async () => {
    const judge = new LlmJudgeEval({ getResource: () => null, readVersion: () => null } as unknown as EvolutionEngine, unavailableCompleter);
    const r = await judge.evaluate({ rid: "x", kind: "prompt", consumer: "eights", current_content: "a", candidate_content: "b" });
    expect(r.evaluator_missing).toBe(true);
    expect(r.eval_delta).toBe(-1);
    expect(r.notes).toMatch(/unavailable/);
  });

  it("LLM returns null -> evaluator_missing:true, delta:-1", async () => {
    const judge = new LlmJudgeEval({ getResource: () => null, readVersion: () => null } as unknown as EvolutionEngine, nullReturnCompleter);
    const r = await judge.evaluate({ rid: "x", kind: "prompt", consumer: "eights", current_content: "a", candidate_content: "b" });
    expect(r.evaluator_missing).toBe(true);
    expect(r.eval_delta).toBe(-1);
    expect(r.notes).toMatch(/no content/);
  });

  it("LLM returns unparseable JSON -> evaluator_missing:true, delta:-1", async () => {
    const judge = new LlmJudgeEval({ getResource: () => null, readVersion: () => null } as unknown as EvolutionEngine, badJsonCompleter);
    const r = await judge.evaluate({ rid: "x", kind: "prompt", consumer: "eights", current_content: "a", candidate_content: "b" });
    expect(r.evaluator_missing).toBe(true);
    expect(r.eval_delta).toBe(-1);
    expect(r.notes).toMatch(/parse/);
  });

  it("LLM unavailable -> commit blocked via engine (evaluator_missing)", async () => {
    const { dir, sql, engine } = makeEngine("2b-engine");
    try {
      const reg = new EvalRegistry();
      const judge = new LlmJudgeEval({ getResource: () => null, readVersion: () => null } as unknown as EvolutionEngine, unavailableCompleter);
      reg.register(judge);
      engine.setEvaluator(reg);

      engine.register(ENV, {
        rid: "resource:df.2b.prompt", kind: "prompt", risk_class: "low",
        evolution_policy: "auto", initial_content: "original",
      });
      const originalVersion = engine.getResource("resource:df.2b.prompt")!.current_version;

      const prop = engine.propose(ENV, {
        rid: "resource:df.2b.prompt", candidate_content: "candidate",
        justification: "llm unavailable test",
      });
      const report = await engine.evaluate(ENV, prop.proposal_id);
      expect(report.evaluator_missing).toBe(true);

      const result = await engine.commit(ENV, prop.proposal_id);
      expect(result.committed).toBe(false);
      expect(result.reason).toMatch(/evaluator_missing/);
      expect(engine.getResource("resource:df.2b.prompt")!.current_version).toBe(originalVersion);
    } finally { teardown(dir, sql); }
  });

  it("LLM available and returns valid JSON -> evaluator_missing absent, commits", async () => {
    const { dir, sql, engine } = makeEngine("2b-pass");
    try {
      const reg = new EvalRegistry();
      const judge = new LlmJudgeEval({ getResource: () => null, readVersion: () => null } as unknown as EvolutionEngine, goodCompleter);
      reg.register(judge);
      engine.setEvaluator(reg);

      engine.register(ENV, {
        rid: "resource:df.2b.pass.prompt", kind: "prompt", risk_class: "low",
        evolution_policy: "auto", initial_content: "original",
      });
      const prop = engine.propose(ENV, {
        rid: "resource:df.2b.pass.prompt", candidate_content: "improved",
        justification: "llm success",
      });
      const report = await engine.evaluate(ENV, prop.proposal_id);
      expect(report.evaluator_missing).toBe(false);
      expect(report.eval_delta).toBeGreaterThan(0);

      const result = await engine.commit(ENV, prop.proposal_id);
      expect(result.committed).toBe(true);
    } finally { teardown(dir, sql); }
  });
});

// ---------------------------------------------------------------------------
// #3a — full policy enumeration: auto-low-risk on non-low / unknown policy
// ---------------------------------------------------------------------------
describe("#3a — full policy enumeration in commit()", () => {
  let dir: string; let sql: SqliteStore; let engine: EvolutionEngine;

  beforeAll(() => {
    ({ dir, sql, engine } = makeEngine("3a"));
    const reg = new EvalRegistry();
    reg.register(PASS_ADAPTER);
    engine.setEvaluator(reg);
    // Register a medium resource with auto-low-risk policy — this is a
    // misconfiguration that bypassed the old commit() switch. We inject
    // it directly via SQL to simulate a pre-fix stored row.
    const content = "medium resource content";
    const version = contentHash(content);
    const now = new Date().toISOString();
    // Bypass register() to plant an incompatible row directly.
    sql.db.prepare(
      `INSERT INTO resources(rid, kind, risk_class, current_version, evolution_policy, audit_url, consumer, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run("resource:df.3a.medium-auto-low", "policy", "medium", version, "auto-low-risk",
      "graph://resources/df.3a.medium-auto-low", "eights", now, now);
    sql.db.prepare(
      `INSERT OR IGNORE INTO resource_versions(rid, version, content, signature, created_at, created_by, justification, evidence_memory_ids_json)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run("resource:df.3a.medium-auto-low", version, content, "v1:test", now, "test", "planted", "[]");
  });
  afterAll(() => teardown(dir, sql));

  it("auto-low-risk policy on medium risk_class -> commit blocked", async () => {
    const originalVersion = engine.getResource("resource:df.3a.medium-auto-low")!.current_version;
    const prop = engine.propose(ENV, {
      rid: "resource:df.3a.medium-auto-low", candidate_content: "attack via auto-low-risk",
      justification: "policy bypass attempt",
    });
    await engine.evaluate(ENV, prop.proposal_id);
    const result = await engine.commit(ENV, prop.proposal_id);
    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/auto-low-risk/);
    // Version unchanged.
    expect(engine.getResource("resource:df.3a.medium-auto-low")!.current_version).toBe(originalVersion);
  });

  it("auto-low-risk policy on low risk_class -> auto-commits (correct)", async () => {
    // Register a low resource with auto-low-risk policy via direct SQL (valid combo).
    const content = "low resource content";
    const version = contentHash(content);
    const now = new Date().toISOString();
    sql.db.prepare(
      `INSERT INTO resources(rid, kind, risk_class, current_version, evolution_policy, audit_url, consumer, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run("resource:df.3a.low-auto-low", "prompt", "low", version, "auto-low-risk",
      "graph://resources/df.3a.low-auto-low", "eights", now, now);
    sql.db.prepare(
      `INSERT OR IGNORE INTO resource_versions(rid, version, content, signature, created_at, created_by, justification, evidence_memory_ids_json)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run("resource:df.3a.low-auto-low", version, content, "v1:test", now, "test", "planted", "[]");

    const prop = engine.propose(ENV, {
      rid: "resource:df.3a.low-auto-low", candidate_content: "improved low content",
      justification: "auto-low-risk on low should commit",
    });
    await engine.evaluate(ENV, prop.proposal_id);
    const result = await engine.commit(ENV, prop.proposal_id);
    expect(result.committed).toBe(true);
  });

  it("unknown/unrecognised policy value -> commit blocked (fail-closed)", async () => {
    // Plant a resource with a fictional policy value.
    const content = "unknown policy resource";
    const version = contentHash(content);
    const now = new Date().toISOString();
    sql.db.prepare(
      `INSERT INTO resources(rid, kind, risk_class, current_version, evolution_policy, audit_url, consumer, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run("resource:df.3a.unknown-policy", "prompt", "low", version, "turbo-auto",
      "graph://resources/df.3a.unknown-policy", "eights", now, now);
    sql.db.prepare(
      `INSERT OR IGNORE INTO resource_versions(rid, version, content, signature, created_at, created_by, justification, evidence_memory_ids_json)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run("resource:df.3a.unknown-policy", version, content, "v1:test", now, "test", "planted", "[]");

    const prop = engine.propose(ENV, {
      rid: "resource:df.3a.unknown-policy", candidate_content: "attack",
      justification: "unknown policy bypass",
    });
    await engine.evaluate(ENV, prop.proposal_id);
    const result = await engine.commit(ENV, prop.proposal_id);
    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/unknown evolution_policy/);
  });
});

// ---------------------------------------------------------------------------
// #3b — existing-resource path runs validateRiskPolicyCompat
// ---------------------------------------------------------------------------
describe("#3b — existing resource re-register triggers compat check", () => {
  it("re-registering with incompatible risk/policy combo is rejected", () => {
    const { dir, sql, engine } = makeEngine("3b");
    try {
      // Plant a critical resource with auto policy directly in SQLite
      // (simulating a pre-fix stored incompatible row).
      const content = "critical content";
      const version = contentHash(content);
      const now = new Date().toISOString();
      sql.db.prepare(
        `INSERT INTO resources(rid, kind, risk_class, current_version, evolution_policy, audit_url, consumer, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run("resource:df.3b.critical-auto", "policy", "critical", version, "auto",
        "graph://resources/df.3b.critical-auto", "eights", now, now);
      sql.db.prepare(
        `INSERT OR IGNORE INTO resource_versions(rid, version, content, signature, created_at, created_by, justification, evidence_memory_ids_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run("resource:df.3b.critical-auto", version, content, "v1:test", now, "test", "planted", "[]");

      // Calling register() on the existing resource must catch the incompatibility.
      expect(() => engine.register(ENV, {
        rid: "resource:df.3b.critical-auto",
        kind: "policy", risk_class: "critical",
        initial_content: content,
      })).toThrow(/risk\/policy conflict/);
    } finally { teardown(dir, sql); }
  });

  it("re-registering a valid critical+frozen resource succeeds", () => {
    const { dir, sql, engine } = makeEngine("3b-ok");
    try {
      engine.register(ENV, {
        rid: "resource:df.3b.critical-frozen", kind: "policy",
        risk_class: "critical", initial_content: "x",
      });
      // Re-register (idempotent update path) — must not throw.
      expect(() => engine.register(ENV, {
        rid: "resource:df.3b.critical-frozen", kind: "policy",
        risk_class: "critical", initial_content: "x",
      })).not.toThrow();
    } finally { teardown(dir, sql); }
  });
});

// ---------------------------------------------------------------------------
// register_now — importFromSource bypass fix
// ---------------------------------------------------------------------------
describe("register_now — importFromSource policy enforcement", () => {
  it("frozen resource -> importFromSource throws, version unchanged", () => {
    const { dir, sql, engine } = makeEngine("ifs-frozen");
    try {
      engine.register(ENV, {
        rid: "resource:df.ifs.frozen", kind: "policy", risk_class: "critical",
        initial_content: "frozen content",
      });
      const originalVersion = engine.getResource("resource:df.ifs.frozen")!.current_version;

      expect(() =>
        engine.importFromSource(ENV, "resource:df.ifs.frozen", "attempted overwrite", "bypass attempt"),
      ).toThrow(/frozen/);

      // Version must not have changed.
      expect(engine.getResource("resource:df.ifs.frozen")!.current_version).toBe(originalVersion);
    } finally { teardown(dir, sql); }
  });

  it("hitl-only resource -> importFromSource creates proposal, does NOT write version", () => {
    const { dir, sql, engine } = makeEngine("ifs-hitl");
    try {
      engine.register(ENV, {
        rid: "resource:df.ifs.hitl", kind: "policy", risk_class: "medium",
        initial_content: "hitl content",
      });
      const originalVersion = engine.getResource("resource:df.ifs.hitl")!.current_version;

      const returned = engine.importFromSource(ENV, "resource:df.ifs.hitl", "updated content", "re-scan");

      // Returns current (unchanged) version.
      expect(returned).toBe(originalVersion);
      // Resource version must not have changed.
      expect(engine.getResource("resource:df.ifs.hitl")!.current_version).toBe(originalVersion);
      // A pending proposal must exist.
      const pending = engine.listPending();
      expect(pending.some((p) => p.resource_rid === "resource:df.ifs.hitl")).toBe(true);
    } finally { teardown(dir, sql); }
  });

  it("auto low-risk resource -> importFromSource imports directly (unchanged behaviour)", () => {
    const { dir, sql, engine } = makeEngine("ifs-auto");
    try {
      engine.register(ENV, {
        rid: "resource:df.ifs.auto", kind: "prompt", risk_class: "low",
        evolution_policy: "auto", initial_content: "original content",
      });
      const originalVersion = engine.getResource("resource:df.ifs.auto")!.current_version;

      const newVersion = engine.importFromSource(ENV, "resource:df.ifs.auto", "updated content", "re-scan");

      // Version must have changed.
      expect(newVersion).not.toBe(originalVersion);
      expect(engine.getResource("resource:df.ifs.auto")!.current_version).toBe(newVersion);
      // No pending proposals — it committed directly.
      const pending = engine.listPending();
      expect(pending.some((p) => p.resource_rid === "resource:df.ifs.auto")).toBe(false);
    } finally { teardown(dir, sql); }
  });

  it("importFromSource on hitl-only with same content -> skips (idempotent, no proposal)", () => {
    const { dir, sql, engine } = makeEngine("ifs-idem");
    try {
      engine.register(ENV, {
        rid: "resource:df.ifs.idem", kind: "policy", risk_class: "medium",
        initial_content: "same content",
      });
      const originalVersion = engine.getResource("resource:df.ifs.idem")!.current_version;

      // Same content — nothing to do.
      const returned = engine.importFromSource(ENV, "resource:df.ifs.idem", "same content", "re-scan");
      expect(returned).toBe(originalVersion);
      expect(engine.listPending().some((p) => p.resource_rid === "resource:df.ifs.idem")).toBe(false);
    } finally { teardown(dir, sql); }
  });
});
