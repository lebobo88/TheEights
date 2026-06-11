/**
 * evolution-govfix2.test.ts
 *
 * Tests for the second-pass governance hardening (wf-gov-sweep-20260611):
 *
 * FIX 1  LlmJudgeEval: parsed-but-invalid shape -> evaluator_missing (fail closed)
 *        + evaluate() enforces finite delta from ALL adapters
 * FIX 2  Plain "auto" on non-low risk_class -> commit blocked
 *        + importFromSource() same risk gate as commit()
 * FIX 3  Existing-resource path: use stored risk_class; reject risk_class downgrade
 *        + accepted upgrade persisted to DB with audit event
 * FIX 4  SSGM stubs: enforced:false, no passed:true claim; commit not gated by SSGM
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/stores/sqlite.js";
import { AuditEngine } from "../src/engines/audit.js";
import { PolicyEngine } from "../src/engines/policy.js";
import { EvolutionEngine, contentHash, isCommittableDelta } from "../src/engines/evolution.js";
import { GovernanceStateEngine } from "../src/engines/governance-state.js";
import { EvalRegistry } from "../src/engines/eval/registry.js";
import { WriteRouter } from "../src/engines/writeback.js";
import { LlmJudgeEval } from "../src/engines/eval/llm-judge.js";
import type { EvalAdapter } from "../src/engines/eval/registry.js";
import type { Completer } from "../src/engines/eval/completer.js";
import type { Envelope } from "../src/schemas/envelope.js";
import type { EvaluationReport } from "../src/schemas/proposal.js";
import { mintOperatorCapability } from "../src/auth/capability.js";

const ENV: Envelope = {
  tenant_id: "local", actor_id: "govfix2-test", project_id: "TheEights",
  domain: "infra", scope: [], trace_id: "t-govfix2",
};

function makeEngine(tag: string): { dir: string; sql: SqliteStore; engine: EvolutionEngine } {
  const dir = mkdtempSync(join(tmpdir(), `eights-gf2-${tag}-`));
  const sql = new SqliteStore(join(dir, "state.db"));
  sql.migrate();
  const audit = new AuditEngine(sql, join(dir, "events"));
  const policy = new PolicyEngine(sql);
  const governance = new GovernanceStateEngine(sql, audit);
  const engine = new EvolutionEngine(sql, join(dir, "resources"), policy, audit);
  engine.setWriteRouter(new WriteRouter([]));
  engine.setGovernance(governance);
  return { dir, sql, engine };
}

function teardown(dir: string, sql: SqliteStore): void {
  sql.close();
  rmSync(dir, { recursive: true, force: true });
}

const PASS_ADAPTER: EvalAdapter = {
  name: "pass", kinds: ["prompt", "policy", "agent", "squad"],
  consumers: "*",
  async evaluate() { return { eval_delta: 1, metric_scores: {}, notes: "ok" }; },
};

// ---------------------------------------------------------------------------
// FIX 1 — LlmJudgeEval: parsed-but-invalid shape fails closed
// ---------------------------------------------------------------------------
describe("FIX 1 — LlmJudgeEval: parsed-but-invalid shape -> evaluator_missing", () => {
  const stubEngine = { getResource: () => null, readVersion: () => null } as unknown as EvolutionEngine;

  it("parsed {} (missing both fields) -> evaluator_missing:true, delta:-1", async () => {
    const c: Completer = { async available() { return true; }, async complete() { return "{}"; } };
    const judge = new LlmJudgeEval(stubEngine, c);
    const r = await judge.evaluate({ rid: "x", kind: "prompt", consumer: "eights", current_content: "a", candidate_content: "b" });
    expect(r.evaluator_missing).toBe(true);
    expect(r.eval_delta).toBe(-1);
    expect(r.notes).toMatch(/shape invalid/);
  });

  it("parsed [] (array not object) -> evaluator_missing:true (extractJson returns null)", async () => {
    const c: Completer = { async available() { return true; }, async complete() { return "[]"; } };
    const judge = new LlmJudgeEval(stubEngine, c);
    const r = await judge.evaluate({ rid: "x", kind: "prompt", consumer: "eights", current_content: "a", candidate_content: "b" });
    // extractJson returns null for arrays (type guard); upstream parse-failure path
    expect(r.evaluator_missing).toBe(true);
    expect(r.eval_delta).toBe(-1);
  });

  it("current='x', candidate=null -> evaluator_missing:true", async () => {
    const c: Completer = {
      async available() { return true; },
      async complete() { return JSON.stringify({ current: "x", candidate: null, notes: "bad" }); },
    };
    const judge = new LlmJudgeEval(stubEngine, c);
    const r = await judge.evaluate({ rid: "x", kind: "prompt", consumer: "eights", current_content: "a", candidate_content: "b" });
    expect(r.evaluator_missing).toBe(true);
    expect(r.eval_delta).toBe(-1);
    expect(r.notes).toMatch(/shape invalid/);
  });

  it("current=2 (out of range [-1,1]) -> evaluator_missing:true", async () => {
    const c: Completer = {
      async available() { return true; },
      async complete() { return JSON.stringify({ current: 2, candidate: 0.5, notes: "out" }); },
    };
    const judge = new LlmJudgeEval(stubEngine, c);
    const r = await judge.evaluate({ rid: "x", kind: "prompt", consumer: "eights", current_content: "a", candidate_content: "b" });
    expect(r.evaluator_missing).toBe(true);
    expect(r.eval_delta).toBe(-1);
    expect(r.notes).toMatch(/shape invalid/);
  });

  it("current=0.5, candidate=0.8 -> valid delta 0.3, evaluator_missing absent", async () => {
    const c: Completer = {
      async available() { return true; },
      async complete() { return JSON.stringify({ current: 0.5, candidate: 0.8, notes: "good" }); },
    };
    const judge = new LlmJudgeEval(stubEngine, c);
    const r = await judge.evaluate({ rid: "x", kind: "prompt", consumer: "eights", current_content: "a", candidate_content: "b" });
    expect(r.evaluator_missing).toBeFalsy();
    expect(r.eval_delta).toBeCloseTo(0.3, 10);
    expect(r.metric_scores["current_score"]).toBe(0.5);
    expect(r.metric_scores["candidate_score"]).toBe(0.8);
  });

  it("current=NaN (coerced) -> evaluator_missing:true (NaN is not finite)", async () => {
    const c: Completer = {
      async available() { return true; },
      // JSON.stringify cannot encode NaN directly; simulate by numeric coercion failure via string
      async complete() { return '{"current": "nan_str", "candidate": 0.5, "notes": "nan"}'; },
    };
    const judge = new LlmJudgeEval(stubEngine, c);
    const r = await judge.evaluate({ rid: "x", kind: "prompt", consumer: "eights", current_content: "a", candidate_content: "b" });
    expect(r.evaluator_missing).toBe(true);
    expect(r.eval_delta).toBe(-1);
  });

  it("current=Infinity would be caught (typeof number but not finite)", async () => {
    // JSON spec doesn't allow Infinity, so JSON.parse throws — extractJson returns null
    const c: Completer = {
      async available() { return true; },
      async complete() { return '{"current": 1e999, "candidate": 0.5}'; },  // 1e999 = Infinity in JS parse
    };
    const judge = new LlmJudgeEval(stubEngine, c);
    const r = await judge.evaluate({ rid: "x", kind: "prompt", consumer: "eights", current_content: "a", candidate_content: "b" });
    // JSON.parse("1e999") -> Infinity (valid parse), so extractJson succeeds
    // but Infinity fails isValidScore (Number.isFinite)
    expect(r.evaluator_missing).toBe(true);
    expect(r.eval_delta).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — plain "auto" must be risk-gated (only allowed on risk_class=low)
// ---------------------------------------------------------------------------
describe("FIX 2 — plain 'auto' policy blocked on non-low risk_class", () => {
  it("policy=auto + risk_class=high -> commit blocked", async () => {
    const { dir, sql, engine } = makeEngine("f2-high");
    try {
      const reg = new EvalRegistry();
      reg.register(PASS_ADAPTER);
      engine.setEvaluator(reg);

      // Plant a high+auto resource directly (bypasses register() compat check to simulate
      // a pre-fix stored row or an injected attack).
      const content = "high risk auto resource";
      const version = contentHash(content);
      const now = new Date().toISOString();
      sql.db.prepare(
        `INSERT INTO resources(rid, kind, risk_class, current_version, evolution_policy, audit_url, consumer, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run("resource:gf2.f2.high-auto", "policy", "high", version, "auto",
        "graph://resources/gf2.f2.high-auto", "eights", now, now);
      sql.db.prepare(
        `INSERT OR IGNORE INTO resource_versions(rid, version, content, signature, created_at, created_by, justification, evidence_memory_ids_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run("resource:gf2.f2.high-auto", version, content, "v1:test", now, "test", "planted", "[]");

      const originalVersion = engine.getResource("resource:gf2.f2.high-auto")!.current_version;
      const prop = engine.propose(ENV, {
        rid: "resource:gf2.f2.high-auto", candidate_content: "attack via auto",
        justification: "policy bypass attempt",
      });
      await engine.evaluate(ENV, prop.proposal_id);
      const result = await engine.commit(ENV, prop.proposal_id);
      expect(result.committed).toBe(false);
      expect(result.reason).toMatch(/auto policy requires risk_class=low/);
      // Version must not have changed.
      expect(engine.getResource("resource:gf2.f2.high-auto")!.current_version).toBe(originalVersion);
    } finally { teardown(dir, sql); }
  });

  it("policy=auto + risk_class=medium -> commit blocked", async () => {
    const { dir, sql, engine } = makeEngine("f2-med");
    try {
      const reg = new EvalRegistry();
      reg.register(PASS_ADAPTER);
      engine.setEvaluator(reg);

      const content = "medium risk auto resource";
      const version = contentHash(content);
      const now = new Date().toISOString();
      sql.db.prepare(
        `INSERT INTO resources(rid, kind, risk_class, current_version, evolution_policy, audit_url, consumer, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run("resource:gf2.f2.med-auto", "policy", "medium", version, "auto",
        "graph://resources/gf2.f2.med-auto", "eights", now, now);
      sql.db.prepare(
        `INSERT OR IGNORE INTO resource_versions(rid, version, content, signature, created_at, created_by, justification, evidence_memory_ids_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run("resource:gf2.f2.med-auto", version, content, "v1:test", now, "test", "planted", "[]");

      const prop = engine.propose(ENV, {
        rid: "resource:gf2.f2.med-auto", candidate_content: "attack via auto on medium",
        justification: "policy bypass attempt",
      });
      await engine.evaluate(ENV, prop.proposal_id);
      const result = await engine.commit(ENV, prop.proposal_id);
      expect(result.committed).toBe(false);
      expect(result.reason).toMatch(/auto policy requires risk_class=low/);
    } finally { teardown(dir, sql); }
  });

  it("policy=auto + risk_class=low -> proceeds to eval checks (commits on delta>=0)", async () => {
    const { dir, sql, engine } = makeEngine("f2-low");
    try {
      const reg = new EvalRegistry();
      reg.register(PASS_ADAPTER);
      engine.setEvaluator(reg);

      engine.register(ENV, {
        rid: "resource:gf2.f2.low-auto", kind: "prompt", risk_class: "low",
        evolution_policy: "auto", initial_content: "original",
      });
      const prop = engine.propose(ENV, {
        rid: "resource:gf2.f2.low-auto", candidate_content: "improved",
        justification: "low auto should commit",
      });
      await engine.evaluate(ENV, prop.proposal_id);
      const result = await engine.commit(ENV, prop.proposal_id);
      expect(result.committed).toBe(true);
    } finally { teardown(dir, sql); }
  });

  it("policy=auto-low-risk + non-low -> blocked (regression guard, must keep passing)", async () => {
    const { dir, sql, engine } = makeEngine("f2-alr");
    try {
      const reg = new EvalRegistry();
      reg.register(PASS_ADAPTER);
      engine.setEvaluator(reg);

      const content = "medium auto-low-risk";
      const version = contentHash(content);
      const now = new Date().toISOString();
      sql.db.prepare(
        `INSERT INTO resources(rid, kind, risk_class, current_version, evolution_policy, audit_url, consumer, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run("resource:gf2.f2.alr-med", "policy", "medium", version, "auto-low-risk",
        "graph://resources/gf2.f2.alr-med", "eights", now, now);
      sql.db.prepare(
        `INSERT OR IGNORE INTO resource_versions(rid, version, content, signature, created_at, created_by, justification, evidence_memory_ids_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run("resource:gf2.f2.alr-med", version, content, "v1:test", now, "test", "planted", "[]");

      const prop = engine.propose(ENV, {
        rid: "resource:gf2.f2.alr-med", candidate_content: "attack",
        justification: "auto-low-risk on medium",
      });
      await engine.evaluate(ENV, prop.proposal_id);
      const result = await engine.commit(ENV, prop.proposal_id);
      expect(result.committed).toBe(false);
      expect(result.reason).toMatch(/auto-low-risk/);
    } finally { teardown(dir, sql); }
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — existing-resource: use stored risk_class; reject downgrade
// ---------------------------------------------------------------------------
describe("FIX 3 — existing-resource compat uses stored risk_class; rejects downgrade", () => {
  it("critical resource re-registered with input risk_class=low -> rejected (downgrade)", () => {
    const { dir, sql, engine } = makeEngine("f3-down");
    try {
      engine.register(ENV, {
        rid: "resource:gf3.critical", kind: "policy", risk_class: "critical",
        initial_content: "critical content",
      });
      // Attempt to re-register with a lower risk_class to weaken governance
      expect(() => engine.register(ENV, {
        rid: "resource:gf3.critical", kind: "policy",
        risk_class: "low",  // downgrade from critical -> should be rejected
        initial_content: "critical content",
      })).toThrow(/cannot downgrade risk_class from 'critical' to 'low'/);
    } finally { teardown(dir, sql); }
  });

  it("high resource re-registered with input risk_class=medium -> rejected (downgrade)", () => {
    const { dir, sql, engine } = makeEngine("f3-down2");
    try {
      engine.register(ENV, {
        rid: "resource:gf3.high", kind: "policy", risk_class: "high",
        evolution_policy: "hitl-only", initial_content: "high content",
      });
      expect(() => engine.register(ENV, {
        rid: "resource:gf3.high", kind: "policy",
        risk_class: "medium",  // downgrade
        initial_content: "high content",
      })).toThrow(/cannot downgrade risk_class from 'high' to 'medium'/);
    } finally { teardown(dir, sql); }
  });

  it("re-registering with same risk_class -> ok (no downgrade)", () => {
    const { dir, sql, engine } = makeEngine("f3-same");
    try {
      engine.register(ENV, {
        rid: "resource:gf3.same", kind: "policy", risk_class: "critical",
        initial_content: "x",
      });
      expect(() => engine.register(ENV, {
        rid: "resource:gf3.same", kind: "policy",
        risk_class: "critical",  // same
        initial_content: "x",
      })).not.toThrow();
    } finally { teardown(dir, sql); }
  });

  it("re-registering upgrading low->high -> ok (compat checked with new high)", () => {
    const { dir, sql, engine } = makeEngine("f3-up");
    try {
      engine.register(ENV, {
        rid: "resource:gf3.upgrade", kind: "prompt", risk_class: "low",
        evolution_policy: "auto", initial_content: "x",
      });
      // Upgrade to high with hitl-only policy (compat: high+hitl-only is valid)
      expect(() => engine.register(ENV, {
        rid: "resource:gf3.upgrade", kind: "prompt",
        risk_class: "high", evolution_policy: "hitl-only",
        initial_content: "x",
      })).not.toThrow();
    } finally { teardown(dir, sql); }
  });

  it("compat check uses STORED risk_class even when caller supplies lower: critical+auto stored, caller says low+auto -> still throws (compat on stored critical)", () => {
    const { dir, sql, engine } = makeEngine("f3-stored-compat");
    try {
      // Plant critical+auto directly in DB (pre-fix row)
      const content = "critical content";
      const version = contentHash(content);
      const now = new Date().toISOString();
      sql.db.prepare(
        `INSERT INTO resources(rid, kind, risk_class, current_version, evolution_policy, audit_url, consumer, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run("resource:gf3.stored-compat", "policy", "critical", version, "auto",
        "graph://resources/gf3.stored-compat", "eights", now, now);
      sql.db.prepare(
        `INSERT OR IGNORE INTO resource_versions(rid, version, content, signature, created_at, created_by, justification, evidence_memory_ids_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run("resource:gf3.stored-compat", version, content, "v1:test", now, "test", "planted", "[]");

      // Caller tries to re-register with input risk_class=low (a downgrade from critical).
      // The downgrade check fires FIRST (critical -> low is a downgrade).
      expect(() => engine.register(ENV, {
        rid: "resource:gf3.stored-compat", kind: "policy",
        risk_class: "low",  // downgrade from stored critical
        initial_content: content,
      })).toThrow(/cannot downgrade risk_class/);
    } finally { teardown(dir, sql); }
  });

  it("re-registering critical with caller-supplied risk_class=critical runs compat on stored (critical+auto stored -> still throws on compat)", () => {
    const { dir, sql, engine } = makeEngine("f3-compat-stored");
    try {
      const content = "critical auto content";
      const version = contentHash(content);
      const now = new Date().toISOString();
      // Plant critical+auto (pre-fix incompatible row)
      sql.db.prepare(
        `INSERT INTO resources(rid, kind, risk_class, current_version, evolution_policy, audit_url, consumer, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run("resource:gf3.crit-compat", "policy", "critical", version, "auto",
        "graph://resources/gf3.crit-compat", "eights", now, now);
      sql.db.prepare(
        `INSERT OR IGNORE INTO resource_versions(rid, version, content, signature, created_at, created_by, justification, evidence_memory_ids_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run("resource:gf3.crit-compat", version, content, "v1:test", now, "test", "planted", "[]");

      // Re-register with same risk_class=critical, no explicit policy -> uses stored "auto"
      // compat check: critical + auto -> should throw risk/policy conflict
      expect(() => engine.register(ENV, {
        rid: "resource:gf3.crit-compat", kind: "policy",
        risk_class: "critical",  // same (no downgrade), but stored policy=auto is incompatible
        initial_content: content,
      })).toThrow(/risk\/policy conflict/);
    } finally { teardown(dir, sql); }
  });
});

// ---------------------------------------------------------------------------
// FIX 4 — SSGM stubs: enforced:false, no passed:true; advisory only (no commit gate)
// ---------------------------------------------------------------------------
describe("FIX 4 — SSGM gates: honest enforced:false, not gating commit", () => {
  let dir: string; let sql: SqliteStore; let engine: EvolutionEngine;

  beforeAll(() => {
    ({ dir, sql, engine } = makeEngine("f4"));
    const reg = new EvalRegistry();
    reg.register(PASS_ADAPTER);
    engine.setEvaluator(reg);
    engine.register(ENV, {
      rid: "resource:gf4.prompt", kind: "prompt", risk_class: "low",
      evolution_policy: "auto", initial_content: "original",
    });
  });
  afterAll(() => teardown(dir, sql));

  it("evaluate() returns ssgm_gate_results with enforced:false for all three gates", async () => {
    const prop = engine.propose(ENV, {
      rid: "resource:gf4.prompt", candidate_content: "improved",
      justification: "ssgm honest representation test",
    });
    const report = await engine.evaluate(ENV, prop.proposal_id);
    const ssgm = report.ssgm_gate_results;

    // All three gates must report enforced:false (not implemented)
    expect(ssgm.consistency.enforced).toBe(false);
    expect(ssgm.temporal_decay.enforced).toBe(false);
    expect(ssgm.access_control.enforced).toBe(false);

    // No gate claims passed:true (the gates did not run)
    expect(ssgm.consistency.passed).toBeUndefined();
    expect(ssgm.temporal_decay.passed).toBeUndefined();
    expect(ssgm.access_control.passed).toBeUndefined();
  });

  it("ssgm enforced:false does NOT block commit (gates are advisory only)", async () => {
    // The previous test's proposal will be in evaluating state.
    // Create a fresh proposal and confirm commit proceeds despite enforced:false.
    const prop = engine.propose(ENV, {
      rid: "resource:gf4.prompt", candidate_content: "further improvement",
      justification: "advisory-only ssgm commit test",
    });
    await engine.evaluate(ENV, prop.proposal_id);
    const result = await engine.commit(ENV, prop.proposal_id);
    // commit() should succeed (eval passed, evaluator_missing:false) regardless of ssgm not enforced
    expect(result.committed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FIX 1 (adjacent gap) — evaluate() enforces finite delta from ALL adapters
// ---------------------------------------------------------------------------
describe("FIX 1 (gap) — evaluate() enforces finite delta from any adapter", () => {
  it("adapter returning NaN delta -> evaluator_missing:true, commit blocked", async () => {
    const { dir, sql, engine } = makeEngine("f1g-nan");
    try {
      const nanAdapter: EvalAdapter = {
        name: "nan", kinds: ["prompt"], consumers: "*",
        async evaluate() { return { eval_delta: NaN, metric_scores: {}, notes: "nan" }; },
      };
      const reg = new EvalRegistry();
      reg.register(nanAdapter);
      engine.setEvaluator(reg);

      engine.register(ENV, {
        rid: "resource:gf1g.nan", kind: "prompt", risk_class: "low",
        evolution_policy: "auto", initial_content: "original",
      });
      const originalVersion = engine.getResource("resource:gf1g.nan")!.current_version;
      const prop = engine.propose(ENV, {
        rid: "resource:gf1g.nan", candidate_content: "candidate",
        justification: "nan delta test",
      });
      const report = await engine.evaluate(ENV, prop.proposal_id);
      // evaluate() must catch the NaN and surface evaluator_missing:true
      expect(report.evaluator_missing).toBe(true);
      expect(report.eval_delta).toBe(-1);
      expect(report.notes).toMatch(/non-finite/);

      const result = await engine.commit(ENV, prop.proposal_id);
      expect(result.committed).toBe(false);
      expect(result.reason).toMatch(/evaluator_missing/);
      // Version must be unchanged
      expect(engine.getResource("resource:gf1g.nan")!.current_version).toBe(originalVersion);
    } finally { teardown(dir, sql); }
  });

  it("adapter returning Infinity delta -> evaluator_missing:true, commit blocked", async () => {
    const { dir, sql, engine } = makeEngine("f1g-inf");
    try {
      const infAdapter: EvalAdapter = {
        name: "inf", kinds: ["prompt"], consumers: "*",
        async evaluate() { return { eval_delta: Infinity, metric_scores: {}, notes: "inf" }; },
      };
      const reg = new EvalRegistry();
      reg.register(infAdapter);
      engine.setEvaluator(reg);

      engine.register(ENV, {
        rid: "resource:gf1g.inf", kind: "prompt", risk_class: "low",
        evolution_policy: "auto", initial_content: "original",
      });
      const prop = engine.propose(ENV, {
        rid: "resource:gf1g.inf", candidate_content: "candidate",
        justification: "infinity delta test",
      });
      const report = await engine.evaluate(ENV, prop.proposal_id);
      expect(report.evaluator_missing).toBe(true);
      expect(report.eval_delta).toBe(-1);

      const result = await engine.commit(ENV, prop.proposal_id);
      expect(result.committed).toBe(false);
    } finally { teardown(dir, sql); }
  });

  it("adapter returning non-number (null coerced) delta -> evaluator_missing:true", async () => {
    const { dir, sql, engine } = makeEngine("f1g-null");
    try {
      const nullDeltaAdapter: EvalAdapter = {
        name: "nulld", kinds: ["prompt"], consumers: "*",
        // Simulate an adapter that returns a non-number delta (type cast to satisfy TS)
        async evaluate() { return { eval_delta: null as unknown as number, metric_scores: {}, notes: "null-delta" }; },
      };
      const reg = new EvalRegistry();
      reg.register(nullDeltaAdapter);
      engine.setEvaluator(reg);

      engine.register(ENV, {
        rid: "resource:gf1g.null", kind: "prompt", risk_class: "low",
        evolution_policy: "auto", initial_content: "original",
      });
      const prop = engine.propose(ENV, {
        rid: "resource:gf1g.null", candidate_content: "candidate",
        justification: "null delta test",
      });
      const report = await engine.evaluate(ENV, prop.proposal_id);
      expect(report.evaluator_missing).toBe(true);
      expect(report.eval_delta).toBe(-1);

      const result = await engine.commit(ENV, prop.proposal_id);
      expect(result.committed).toBe(false);
    } finally { teardown(dir, sql); }
  });

  it("adapter returning valid finite delta -> evaluator_missing:false, commits", async () => {
    const { dir, sql, engine } = makeEngine("f1g-ok");
    try {
      const reg = new EvalRegistry();
      reg.register(PASS_ADAPTER);
      engine.setEvaluator(reg);

      engine.register(ENV, {
        rid: "resource:gf1g.ok", kind: "prompt", risk_class: "low",
        evolution_policy: "auto", initial_content: "original",
      });
      const prop = engine.propose(ENV, {
        rid: "resource:gf1g.ok", candidate_content: "improved",
        justification: "valid delta",
      });
      const report = await engine.evaluate(ENV, prop.proposal_id);
      expect(report.evaluator_missing).toBe(false);

      const result = await engine.commit(ENV, prop.proposal_id);
      expect(result.committed).toBe(true);
    } finally { teardown(dir, sql); }
  });
});

// ---------------------------------------------------------------------------
// FIX 2 (adjacent gap) — importFromSource() must apply the same risk gate
// ---------------------------------------------------------------------------
describe("FIX 2 (gap) — importFromSource() risk-gates auto/auto-low-risk on non-low", () => {
  it("auto+high resource: importFromSource queues proposal, does NOT auto-apply", () => {
    const { dir, sql, engine } = makeEngine("f2g-high");
    try {
      // Plant auto+high resource (simulates pre-fix stored row)
      const content = "high auto content";
      const version = contentHash(content);
      const now = new Date().toISOString();
      sql.db.prepare(
        `INSERT INTO resources(rid, kind, risk_class, current_version, evolution_policy, audit_url, consumer, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run("resource:gf2g.high-auto", "policy", "high", version, "auto",
        "graph://resources/gf2g.high-auto", "eights", now, now);
      sql.db.prepare(
        `INSERT OR IGNORE INTO resource_versions(rid, version, content, signature, created_at, created_by, justification, evidence_memory_ids_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run("resource:gf2g.high-auto", version, content, "v1:test", now, "test", "planted", "[]");

      const originalVersion = engine.getResource("resource:gf2g.high-auto")!.current_version;
      const returned = engine.importFromSource(ENV, "resource:gf2g.high-auto", "attacker content", "external re-scan");

      // Must return current (unchanged) version — NOT the new content's hash
      expect(returned).toBe(originalVersion);
      // Stored version must be unchanged
      expect(engine.getResource("resource:gf2g.high-auto")!.current_version).toBe(originalVersion);
      // A pending proposal must exist (queued for HITL)
      const pending = engine.listPending();
      expect(pending.some((p) => p.resource_rid === "resource:gf2g.high-auto")).toBe(true);
    } finally { teardown(dir, sql); }
  });

  it("auto-low-risk+medium resource: importFromSource queues proposal, does NOT auto-apply", () => {
    const { dir, sql, engine } = makeEngine("f2g-alr-med");
    try {
      const content = "alr medium content";
      const version = contentHash(content);
      const now = new Date().toISOString();
      sql.db.prepare(
        `INSERT INTO resources(rid, kind, risk_class, current_version, evolution_policy, audit_url, consumer, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run("resource:gf2g.alr-med", "policy", "medium", version, "auto-low-risk",
        "graph://resources/gf2g.alr-med", "eights", now, now);
      sql.db.prepare(
        `INSERT OR IGNORE INTO resource_versions(rid, version, content, signature, created_at, created_by, justification, evidence_memory_ids_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run("resource:gf2g.alr-med", version, content, "v1:test", now, "test", "planted", "[]");

      const originalVersion = engine.getResource("resource:gf2g.alr-med")!.current_version;
      const returned = engine.importFromSource(ENV, "resource:gf2g.alr-med", "new content", "re-scan");
      expect(returned).toBe(originalVersion);
      expect(engine.getResource("resource:gf2g.alr-med")!.current_version).toBe(originalVersion);
      expect(engine.listPending().some((p) => p.resource_rid === "resource:gf2g.alr-med")).toBe(true);
    } finally { teardown(dir, sql); }
  });

  it("auto+low resource: importFromSource still auto-applies (no regression)", () => {
    const { dir, sql, engine } = makeEngine("f2g-low");
    try {
      engine.register(ENV, {
        rid: "resource:gf2g.low-auto", kind: "prompt", risk_class: "low",
        evolution_policy: "auto", initial_content: "original",
      });
      const originalVersion = engine.getResource("resource:gf2g.low-auto")!.current_version;
      const newVersion = engine.importFromSource(ENV, "resource:gf2g.low-auto", "updated content", "re-scan");
      // Version must have changed (direct import)
      expect(newVersion).not.toBe(originalVersion);
      expect(engine.getResource("resource:gf2g.low-auto")!.current_version).toBe(newVersion);
      // No pending proposals
      expect(engine.listPending().some((p) => p.resource_rid === "resource:gf2g.low-auto")).toBe(false);
    } finally { teardown(dir, sql); }
  });

  it("unknown policy resource: importFromSource queues proposal (fail-closed), does NOT auto-apply", () => {
    const { dir, sql, engine } = makeEngine("f2g-unk");
    try {
      const content = "unknown policy content";
      const version = contentHash(content);
      const now = new Date().toISOString();
      sql.db.prepare(
        `INSERT INTO resources(rid, kind, risk_class, current_version, evolution_policy, audit_url, consumer, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run("resource:gf2g.unknown", "prompt", "low", version, "turbo-auto",
        "graph://resources/gf2g.unknown", "eights", now, now);
      sql.db.prepare(
        `INSERT OR IGNORE INTO resource_versions(rid, version, content, signature, created_at, created_by, justification, evidence_memory_ids_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run("resource:gf2g.unknown", version, content, "v1:test", now, "test", "planted", "[]");

      const originalVersion = engine.getResource("resource:gf2g.unknown")!.current_version;
      const returned = engine.importFromSource(ENV, "resource:gf2g.unknown", "new content", "re-scan");
      expect(returned).toBe(originalVersion);
      expect(engine.getResource("resource:gf2g.unknown")!.current_version).toBe(originalVersion);
      expect(engine.listPending().some((p) => p.resource_rid === "resource:gf2g.unknown")).toBe(true);
    } finally { teardown(dir, sql); }
  });
});

// ---------------------------------------------------------------------------
// FIX 3 (adjacent gap) — upgrade persisted to DB + audit event
// ---------------------------------------------------------------------------
describe("FIX 3 (gap) — risk_class upgrade is persisted to DB with audit event", () => {
  it("low->high upgrade: getResource() returns high after re-register + audit event emitted", () => {
    const { dir, sql, engine } = makeEngine("f3g-persist");
    try {
      engine.register(ENV, {
        rid: "resource:gf3g.upgrade", kind: "prompt", risk_class: "low",
        evolution_policy: "auto", initial_content: "x",
      });
      // Confirm stored as low
      expect(engine.getResource("resource:gf3g.upgrade")!.risk_class).toBe("low");

      // Re-register with higher risk_class + compatible policy
      engine.register(ENV, {
        rid: "resource:gf3g.upgrade", kind: "prompt",
        risk_class: "high", evolution_policy: "hitl-only",
        initial_content: "x",
      });

      // Stored row must now reflect the upgraded risk_class
      const after = engine.getResource("resource:gf3g.upgrade")!;
      expect(after.risk_class).toBe("high");
      expect(after.evolution_policy).toBe("hitl-only");

      // Audit event must have been recorded for the upgrade
      const auditRow = sql.db.prepare(
        `SELECT payload_json FROM events WHERE kind = 'evolution.register.upgraded' AND json_extract(payload_json, '$.rid') = ? ORDER BY event_id DESC LIMIT 1`,
      ).get("resource:gf3g.upgrade") as { payload_json: string } | undefined;
      expect(auditRow).toBeDefined();
      const payload = JSON.parse(auditRow!.payload_json) as Record<string, unknown>;
      expect(payload["prior_risk_class"]).toBe("low");
      expect(payload["new_risk_class"]).toBe("high");
    } finally { teardown(dir, sql); }
  });

  it("same risk_class re-register: NO DB write, NO upgrade audit event", () => {
    const { dir, sql, engine } = makeEngine("f3g-noop");
    try {
      engine.register(ENV, {
        rid: "resource:gf3g.noop", kind: "policy", risk_class: "critical",
        initial_content: "x",
      });
      // Count audit events before re-register
      const countBefore = (sql.db.prepare(
        `SELECT COUNT(*) as n FROM events WHERE kind = 'evolution.register.upgraded'`,
      ).get() as { n: number }).n;

      engine.register(ENV, {
        rid: "resource:gf3g.noop", kind: "policy",
        risk_class: "critical", initial_content: "x",
      });

      const countAfter = (sql.db.prepare(
        `SELECT COUNT(*) as n FROM events WHERE kind = 'evolution.register.upgraded'`,
      ).get() as { n: number }).n;
      // No new upgrade event should have been emitted
      expect(countAfter).toBe(countBefore);
    } finally { teardown(dir, sql); }
  });

  it("low->high upgrade: subsequent downgrade attempt back to low is correctly rejected against PERSISTED high", () => {
    const { dir, sql, engine } = makeEngine("f3g-persist-then-down");
    try {
      engine.register(ENV, {
        rid: "resource:gf3g.ptd", kind: "prompt", risk_class: "low",
        evolution_policy: "auto", initial_content: "x",
      });
      // Upgrade low -> high
      engine.register(ENV, {
        rid: "resource:gf3g.ptd", kind: "prompt",
        risk_class: "high", evolution_policy: "hitl-only",
        initial_content: "x",
      });
      // Now attempt to downgrade back to low — must fail against persisted "high"
      expect(() => engine.register(ENV, {
        rid: "resource:gf3g.ptd", kind: "prompt",
        risk_class: "low", initial_content: "x",
      })).toThrow(/cannot downgrade risk_class from 'high' to 'low'/);
    } finally { teardown(dir, sql); }
  });
});

// ---------------------------------------------------------------------------
// isCommittableDelta unit tests — shared helper
// ---------------------------------------------------------------------------
describe("isCommittableDelta — shared gate helper", () => {
  const base = (overrides: Partial<EvaluationReport>): EvaluationReport => ({
    proposal_id: "p1", eval_delta: 0, metric_scores: {},
    ssgm_gate_results: {
      consistency: { enforced: false, conflicts: [] },
      temporal_decay: { enforced: false },
      access_control: { enforced: false },
    },
    notes: "test",
    evaluator_missing: false,
    ...overrides,
  });

  it("evaluator_missing:false + delta=0.2 -> true", () => {
    expect(isCommittableDelta(base({ eval_delta: 0.2 }))).toBe(true);
  });
  it("evaluator_missing:false + delta=0 -> true (boundary)", () => {
    expect(isCommittableDelta(base({ eval_delta: 0 }))).toBe(true);
  });
  it("evaluator_missing:false + delta=null -> false", () => {
    expect(isCommittableDelta(base({ eval_delta: null as unknown as number }))).toBe(false);
  });
  it("evaluator_missing:false + delta=NaN -> false", () => {
    expect(isCommittableDelta(base({ eval_delta: NaN }))).toBe(false);
  });
  it("evaluator_missing:false + delta=Infinity -> false", () => {
    expect(isCommittableDelta(base({ eval_delta: Infinity }))).toBe(false);
  });
  it("evaluator_missing:false + delta=-0.1 -> false (negative)", () => {
    expect(isCommittableDelta(base({ eval_delta: -0.1 }))).toBe(false);
  });
  it("evaluator_missing:true + delta=0.5 -> false", () => {
    expect(isCommittableDelta(base({ evaluator_missing: true, eval_delta: 0.5 }))).toBe(false);
  });
  it("evaluator_missing:undefined + delta=0.5 -> false", () => {
    expect(isCommittableDelta(base({ evaluator_missing: undefined, eval_delta: 0.5 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FIX 1 (gate) — commit() and approve() block persisted malformed eval reports
// ---------------------------------------------------------------------------

const TEST_OP_KEY = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const TEST_KEY_ID = "test-key";

function registerHumanActor(sql: SqliteStore, actor_id: string): void {
  sql.db.prepare(
    `INSERT OR IGNORE INTO actors(actor_id, kind, created_at) VALUES (?, 'human', datetime('now'))`,
  ).run(actor_id);
}

function opEnvWith(base: Envelope, capability: string, resourceId: string, workflowId: string): Envelope {
  const prev = process.env["HYDRA_OPERATOR_KEY"];
  const prevId = process.env["HYDRA_OPERATOR_KEY_ID"];
  process.env["HYDRA_OPERATOR_KEY"] = TEST_OP_KEY;
  process.env["HYDRA_OPERATOR_KEY_ID"] = TEST_KEY_ID;
  try {
    const token = mintOperatorCapability({
      v: 1, actor_id: base.actor_id, actor_kind: "human",
      capability, resource_id: resourceId, workflow_id: workflowId,
      issued_at: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    return { ...base, capability_token: token } as unknown as Envelope;
  } finally {
    if (prev === undefined) delete process.env["HYDRA_OPERATOR_KEY"];
    else process.env["HYDRA_OPERATOR_KEY"] = prev;
    if (prevId === undefined) delete process.env["HYDRA_OPERATOR_KEY_ID"];
    else process.env["HYDRA_OPERATOR_KEY_ID"] = prevId;
  }
}

function withOpKey<T>(fn: () => T): T {
  const prev = process.env["HYDRA_OPERATOR_KEY"];
  const prevId = process.env["HYDRA_OPERATOR_KEY_ID"];
  process.env["HYDRA_OPERATOR_KEY"] = TEST_OP_KEY;
  process.env["HYDRA_OPERATOR_KEY_ID"] = TEST_KEY_ID;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env["HYDRA_OPERATOR_KEY"];
    else process.env["HYDRA_OPERATOR_KEY"] = prev;
    if (prevId === undefined) delete process.env["HYDRA_OPERATOR_KEY_ID"];
    else process.env["HYDRA_OPERATOR_KEY_ID"] = prevId;
  }
}

/** Plant a raw evaluation_json into a proposal row, bypassing evaluate(). */
function plantEvalReport(sql: SqliteStore, proposal_id: string, report: unknown): void {
  sql.db.prepare(`UPDATE proposals SET evaluation_json = ? WHERE proposal_id = ?`)
    .run(JSON.stringify(report), proposal_id);
}

/** Sets up an engine with a low+auto resource and a pending proposal. Returns proposal_id. */
async function makeProposalForGateTest(
  tag: string,
  makeEng: typeof makeEngine,
): Promise<{ dir: string; sql: SqliteStore; engine: EvolutionEngine; proposal_id: string; originalVersion: string }> {
  const { dir, sql, engine } = makeEng(tag);
  registerHumanActor(sql, "gate-test-operator");
  const reg = new EvalRegistry();
  reg.register(PASS_ADAPTER);
  engine.setEvaluator(reg);
  engine.register(ENV, {
    rid: `resource:gfgate.${tag}`, kind: "prompt", risk_class: "low",
    evolution_policy: "auto", initial_content: "original",
  });
  const originalVersion = engine.getResource(`resource:gfgate.${tag}`)!.current_version;
  const prop = engine.propose(ENV, {
    rid: `resource:gfgate.${tag}`, candidate_content: "candidate",
    justification: "gate test",
  });
  return { dir, sql, engine, proposal_id: prop.proposal_id, originalVersion };
}

describe("FIX 1 (gate) — commit() blocks persisted malformed eval_delta", () => {
  it("persisted eval_delta=null + evaluator_missing=false -> commit() blocked", async () => {
    const { dir, sql, engine, proposal_id, originalVersion } = await makeProposalForGateTest("cgate-null", makeEngine);
    try {
      plantEvalReport(sql, proposal_id, {
        proposal_id, eval_delta: null, metric_scores: {}, notes: "tampered",
        ssgm_gate_results: { consistency: { enforced: false, conflicts: [] }, temporal_decay: { enforced: false }, access_control: { enforced: false } },
        evaluator_missing: false,
      });
      const result = await engine.commit(ENV, proposal_id);
      expect(result.committed).toBe(false);
      expect(result.reason).toMatch(/finite|committable/i);
      expect(engine.getResource(`resource:gfgate.cgate-null`)!.current_version).toBe(originalVersion);
    } finally { teardown(dir, sql); }
  });

  it("persisted eval_delta=NaN (serialised as null by JSON.stringify, parsed back as null) -> commit() blocked", async () => {
    const { dir, sql, engine, proposal_id, originalVersion } = await makeProposalForGateTest("cgate-nan", makeEngine);
    try {
      // NaN serialises to null in JSON; the gate must reject null just like NaN
      plantEvalReport(sql, proposal_id, {
        proposal_id, eval_delta: null /* NaN→null via JSON */, metric_scores: {}, notes: "nan",
        ssgm_gate_results: { consistency: { enforced: false, conflicts: [] }, temporal_decay: { enforced: false }, access_control: { enforced: false } },
        evaluator_missing: false,
      });
      const result = await engine.commit(ENV, proposal_id);
      expect(result.committed).toBe(false);
      expect(result.reason).toMatch(/finite|committable/i);
      expect(engine.getResource(`resource:gfgate.cgate-nan`)!.current_version).toBe(originalVersion);
    } finally { teardown(dir, sql); }
  });

  it("persisted eval_delta=Infinity (stored as string since JSON can't encode it; cast back to non-finite) -> commit() blocked", async () => {
    const { dir, sql, engine, proposal_id, originalVersion } = await makeProposalForGateTest("cgate-inf", makeEngine);
    try {
      // Simulate a report where eval_delta was somehow stored as a non-finite-looking value.
      // We store the string "Infinity" which, when parsed from JSON, is a string — typeof !== "number".
      const raw = `{"proposal_id":"${proposal_id}","eval_delta":"Infinity","metric_scores":{},"notes":"inf","ssgm_gate_results":{"consistency":{"enforced":false,"conflicts":[]},"temporal_decay":{"enforced":false},"access_control":{"enforced":false}},"evaluator_missing":false}`;
      sql.db.prepare(`UPDATE proposals SET evaluation_json = ? WHERE proposal_id = ?`).run(raw, proposal_id);
      const result = await engine.commit(ENV, proposal_id);
      expect(result.committed).toBe(false);
      // "Infinity" as string fails typeof === "number" check
      expect(result.reason).toMatch(/finite|committable/i);
      expect(engine.getResource(`resource:gfgate.cgate-inf`)!.current_version).toBe(originalVersion);
    } finally { teardown(dir, sql); }
  });

  it("persisted eval_delta=0.2 + evaluator_missing=false -> commit() succeeds", async () => {
    const { dir, sql, engine, proposal_id } = await makeProposalForGateTest("cgate-ok", makeEngine);
    try {
      plantEvalReport(sql, proposal_id, {
        proposal_id, eval_delta: 0.2, metric_scores: {}, notes: "valid",
        ssgm_gate_results: { consistency: { enforced: false, conflicts: [] }, temporal_decay: { enforced: false }, access_control: { enforced: false } },
        evaluator_missing: false,
      });
      const result = await engine.commit(ENV, proposal_id);
      expect(result.committed).toBe(true);
    } finally { teardown(dir, sql); }
  });
});

describe("FIX 1 (gate) — approve() blocks persisted malformed eval_delta", () => {
  /** approve() requires operator capability + HITL resolved. Use hitl-only resource + governance. */
  async function makeHitlProposal(tag: string): Promise<{
    dir: string; sql: SqliteStore; engine: EvolutionEngine;
    governance: GovernanceStateEngine; proposal_id: string; originalVersion: string;
  }> {
    const dir = mkdtempSync(join(tmpdir(), `eights-gf-ag-${tag}-`));
    const sql = new SqliteStore(join(dir, "state.db"));
    sql.migrate();
    const audit = new AuditEngine(sql, join(dir, "events"));
    const policy = new PolicyEngine(sql);
    const governance = new GovernanceStateEngine(sql, audit);
    const engine = new EvolutionEngine(sql, join(dir, "resources"), policy, audit);
    engine.setWriteRouter(new WriteRouter([]));
    engine.setGovernance(governance);
    const reg = new EvalRegistry();
    reg.register(PASS_ADAPTER);
    engine.setEvaluator(reg);

    // Register human actors
    registerHumanActor(sql, "gate-test-operator");

    // Use a medium+hitl-only resource so approve() path is exercised
    engine.register(ENV, {
      rid: `resource:gfagate.${tag}`, kind: "prompt", risk_class: "medium",
      initial_content: "original",
    });
    const originalVersion = engine.getResource(`resource:gfagate.${tag}`)!.current_version;
    const prop = engine.propose(ENV, {
      rid: `resource:gfagate.${tag}`, candidate_content: "candidate",
      justification: "approve gate test",
    });
    // Must commit() first to create the HITL queue row, then resolve it
    await engine.commit(ENV, prop.proposal_id);
    const hitlRow = sql.db.prepare(
      `SELECT request_id FROM hitl_queue WHERE kind='evolution.approve' AND json_extract(payload_json,'$.proposal_id')=? LIMIT 1`,
    ).get(prop.proposal_id) as { request_id: string } | undefined;
    if (hitlRow) {
      const resolveEnv = opEnvWith(
        { ...ENV, actor_id: "gate-test-operator" },
        "hitl.resolve", hitlRow.request_id, hitlRow.request_id,
      );
      withOpKey(() => governance.hitlResolve(resolveEnv, hitlRow.request_id, "approved"));
    }
    return { dir, sql, engine, governance, proposal_id: prop.proposal_id, originalVersion };
  }

  it("persisted eval_delta=null + evaluator_missing=false -> approve() blocked", async () => {
    const { dir, sql, engine, proposal_id, originalVersion } = await makeHitlProposal("agate-null");
    try {
      plantEvalReport(sql, proposal_id, {
        proposal_id, eval_delta: null, metric_scores: {}, notes: "tampered",
        ssgm_gate_results: { consistency: { enforced: false, conflicts: [] }, temporal_decay: { enforced: false }, access_control: { enforced: false } },
        evaluator_missing: false,
      });
      const approveEnv = opEnvWith(
        { ...ENV, actor_id: "gate-test-operator" },
        "evolution.approve", proposal_id, proposal_id,
      );
      const result = await withOpKey(() => engine.approve(approveEnv, proposal_id));
      expect(result.committed).toBe(false);
      expect(result.reason).toMatch(/finite|committable/i);
      expect(engine.getResource(`resource:gfagate.agate-null`)!.current_version).toBe(originalVersion);
    } finally { teardown(dir, sql); }
  });

  it("persisted eval_delta=NaN (as null in JSON) + evaluator_missing=false -> approve() blocked", async () => {
    const { dir, sql, engine, proposal_id, originalVersion } = await makeHitlProposal("agate-nan");
    try {
      plantEvalReport(sql, proposal_id, {
        proposal_id, eval_delta: null /* NaN→null */, metric_scores: {}, notes: "nan",
        ssgm_gate_results: { consistency: { enforced: false, conflicts: [] }, temporal_decay: { enforced: false }, access_control: { enforced: false } },
        evaluator_missing: false,
      });
      const approveEnv = opEnvWith(
        { ...ENV, actor_id: "gate-test-operator" },
        "evolution.approve", proposal_id, proposal_id,
      );
      const result = await withOpKey(() => engine.approve(approveEnv, proposal_id));
      expect(result.committed).toBe(false);
      expect(result.reason).toMatch(/finite|committable/i);
    } finally { teardown(dir, sql); }
  });

  it("persisted eval_delta=Infinity (as string) + evaluator_missing=false -> approve() blocked", async () => {
    const { dir, sql, engine, proposal_id, originalVersion } = await makeHitlProposal("agate-inf");
    try {
      const raw = `{"proposal_id":"${proposal_id}","eval_delta":"Infinity","metric_scores":{},"notes":"inf","ssgm_gate_results":{"consistency":{"enforced":false,"conflicts":[]},"temporal_decay":{"enforced":false},"access_control":{"enforced":false}},"evaluator_missing":false}`;
      sql.db.prepare(`UPDATE proposals SET evaluation_json = ? WHERE proposal_id = ?`).run(raw, proposal_id);
      const approveEnv = opEnvWith(
        { ...ENV, actor_id: "gate-test-operator" },
        "evolution.approve", proposal_id, proposal_id,
      );
      const result = await withOpKey(() => engine.approve(approveEnv, proposal_id));
      expect(result.committed).toBe(false);
      expect(result.reason).toMatch(/finite|committable/i);
    } finally { teardown(dir, sql); }
  });

  it("persisted eval_delta=0.2 + evaluator_missing=false -> approve() succeeds (after HITL resolved)", async () => {
    const { dir, sql, engine, proposal_id } = await makeHitlProposal("agate-ok");
    try {
      plantEvalReport(sql, proposal_id, {
        proposal_id, eval_delta: 0.2, metric_scores: {}, notes: "valid",
        ssgm_gate_results: { consistency: { enforced: false, conflicts: [] }, temporal_decay: { enforced: false }, access_control: { enforced: false } },
        evaluator_missing: false,
      });
      const approveEnv = opEnvWith(
        { ...ENV, actor_id: "gate-test-operator" },
        "evolution.approve", proposal_id, proposal_id,
      );
      const result = await withOpKey(() => engine.approve(approveEnv, proposal_id));
      expect(result.committed).toBe(true);
    } finally { teardown(dir, sql); }
  });
});
