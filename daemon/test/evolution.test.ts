import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/stores/sqlite.js";
import { AuditEngine } from "../src/engines/audit.js";
import { PolicyEngine } from "../src/engines/policy.js";
import { EvolutionEngine } from "../src/engines/evolution.js";
import { GovernanceStateEngine } from "../src/engines/governance-state.js";
import { EvalRegistry } from "../src/engines/eval/registry.js";
import { NoopEval } from "../src/engines/eval/noop.js";
import { WriteRouter } from "../src/engines/writeback.js";
import type { EvalAdapter } from "../src/engines/eval/registry.js";
import type { Envelope } from "../src/schemas/envelope.js";
import { mintOperatorCapability } from "../src/auth/capability.js";

// ---------------------------------------------------------------------------
// Test-only operator key helpers.
// ---------------------------------------------------------------------------
const TEST_OP_KEY = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const TEST_KEY_ID = "test-key";

/** Register an actor as kind='human' so the actors-table binding passes. */
function registerHumanActor(sql: SqliteStore, actor_id: string): void {
  sql.db.prepare(
    `INSERT OR IGNORE INTO actors(actor_id, kind, created_at) VALUES (?, 'human', datetime('now'))`,
  ).run(actor_id);
}

/**
 * Build an Envelope that carries a valid operator capability token.
 * Sets HYDRA_OPERATOR_KEY for the duration of this call.
 */
function opEnvWith(
  base: Envelope,
  capability: string,
  resourceId: string,
  workflowId: string,
): Envelope {
  const prev = process.env["HYDRA_OPERATOR_KEY"];
  const prevId = process.env["HYDRA_OPERATOR_KEY_ID"];
  process.env["HYDRA_OPERATOR_KEY"] = TEST_OP_KEY;
  process.env["HYDRA_OPERATOR_KEY_ID"] = TEST_KEY_ID;
  try {
    const token = mintOperatorCapability({
      v: 1,
      actor_id: base.actor_id,
      actor_kind: "human",
      capability,
      resource_id: resourceId,
      workflow_id: workflowId,
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

/**
 * Set HYDRA_OPERATOR_KEY for the duration of a synchronous fn call.
 * Used when verifyOperatorCapability is called at call-time (engine methods read env at verify time).
 */
function withOpKey<T>(fn: () => T): T {
  const prev = process.env["HYDRA_OPERATOR_KEY"];
  const prevId = process.env["HYDRA_OPERATOR_KEY_ID"];
  process.env["HYDRA_OPERATOR_KEY"] = TEST_OP_KEY;
  process.env["HYDRA_OPERATOR_KEY_ID"] = TEST_KEY_ID;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env["HYDRA_OPERATOR_KEY"];
    else process.env["HYDRA_OPERATOR_KEY"] = prev;
    if (prevId === undefined) delete process.env["HYDRA_OPERATOR_KEY_ID"];
    else process.env["HYDRA_OPERATOR_KEY_ID"] = prevId;
  }
}

describe("evolution — RSPL + SEPL + risk routing", () => {
  let dir: string;
  let sql: SqliteStore;
  let engine: EvolutionEngine;
  const env: Envelope = {
    tenant_id: "local", actor_id: "test", project_id: "TheEights",
    domain: "infra", scope: [], trace_id: "t-evo",
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-evo-"));
    sql = new SqliteStore(join(dir, "state.db"));
    sql.migrate();
    // Register the test actor as human so capability enforcement passes.
    registerHumanActor(sql, "test");
    const audit = new AuditEngine(sql, join(dir, "events"));
    const policy = new PolicyEngine(sql);
    engine = new EvolutionEngine(sql, join(dir, "resources"), policy, audit);
    engine.setWriteRouter(new WriteRouter([]));
    // TE-EV-2: evaluator MUST be injected; no evaluator = evaluator_missing -> commit blocked.
    // Use a universal passing adapter for this baseline suite.
    const reg = new EvalRegistry();
    const universalPass: EvalAdapter = {
      name: "universal-pass", kinds: ["prompt", "team", "rubric", "tool", "workflow", "schema",
        "policy", "agent", "skill", "command", "hook", "contract", "constitution", "squad", "redaction_policy"],
      consumers: "*",
      async evaluate() { return { eval_delta: 1, metric_scores: {}, notes: "baseline pass" }; },
    };
    reg.register(universalPass);
    engine.setEvaluator(reg);
    engine.seedCriticalResources();
  });

  afterAll(() => { sql.close(); rmSync(dir, { recursive: true, force: true }); });

  it("seeds critical resources and freezes them", () => {
    const policy = engine.getResource("resource:eights.policy.evolution-defaults");
    expect(policy).not.toBeNull();
    expect(policy!.evolution_policy).toBe("frozen");
    expect(() => engine.propose(env, {
      rid: "resource:eights.policy.evolution-defaults",
      candidate_content: "bad",
      justification: "should be rejected",
    })).toThrow(/frozen/);
  });

  it("auto-commits a low-risk proposal with eval_delta>=0", async () => {
    const before = engine.getResource("resource:eights.template.docs-prompt")!;
    expect(before.evolution_policy).toBe("auto");
    const prop = engine.propose(env, {
      rid: "resource:eights.template.docs-prompt",
      candidate_content: "You are a documentation author. Write for senior engineers, prefer concrete examples.",
      justification: "include 'concrete examples' guidance",
    });
    const evalReport = await engine.evaluate(env, prop.proposal_id);
    expect(evalReport.eval_delta).toBeGreaterThanOrEqual(0);
    const result = await engine.commit(env, prop.proposal_id);
    expect(result.committed).toBe(true);
    const after = engine.getResource("resource:eights.template.docs-prompt")!;
    expect(after.current_version).not.toBe(before.current_version);
    expect(after.versions.length).toBe(2);
  });

  it("rolls back to a prior version", async () => {
    const r = engine.getResource("resource:eights.template.docs-prompt")!;
    const first = r.versions[0]!;
    // resource_id = rid@to_version (binds token to exact rollback target, Fix #6)
    const rollbackEnv = opEnvWith(env, "evolution.rollback", `${r.rid}@${first.version}`, r.rid);
    const result = await withOpKey(() => engine.rollback(rollbackEnv, r.rid, first.version));
    expect(result.current_version).toBe(first.version);
  });

  it("detectDrift returns both registry and consumer-source buckets", () => {
    const drift = engine.detectDrift();
    expect(Array.isArray(drift.registry)).toBe(true);
    expect(Array.isArray(drift.sources)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TE-EV-1: approve() self-commit bypass prevention
// ---------------------------------------------------------------------------
describe("TE-EV-1 — approve() self-commit prevention for hitl-only proposals", () => {
  let dir: string;
  let sql: SqliteStore;
  let engine: EvolutionEngine;
  let governance: GovernanceStateEngine;

  const env: Envelope = {
    tenant_id: "local", actor_id: "test-ev1", project_id: "TheEights",
    domain: "infra", scope: [], trace_id: "t-ev1",
  };
  const humanEnv: Envelope = {
    tenant_id: "local", actor_id: "operator-rob", project_id: "TheEights",
    domain: "governance", scope: [], trace_id: "t-ev1-human",
  };

  /** A trivial adapter that always returns delta=1 so evaluation passes. */
  const passingAdapter: EvalAdapter = {
    name: "always-pass",
    kinds: ["prompt"],
    consumers: "*",
    async evaluate() { return { eval_delta: 1, metric_scores: {}, notes: "ok" }; },
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-ev1-"));
    sql = new SqliteStore(join(dir, "state.db"));
    sql.migrate();
    // Register both test actors as human so capability enforcement passes.
    registerHumanActor(sql, "test-ev1");
    registerHumanActor(sql, "operator-rob");
    const audit = new AuditEngine(sql, join(dir, "events"));
    const policy = new PolicyEngine(sql);
    governance = new GovernanceStateEngine(sql, audit);
    engine = new EvolutionEngine(sql, join(dir, "resources"), policy, audit);
    engine.setWriteRouter(new WriteRouter([]));
    engine.setGovernance(governance);

    const reg = new EvalRegistry();
    reg.register(passingAdapter);
    engine.setEvaluator(reg);

    engine.register(env, {
      rid: "resource:test.hitl.doc",
      kind: "prompt",
      risk_class: "medium",  // default policy = hitl-only
      initial_content: "original content",
    });
  });

  afterAll(() => { sql.close(); rmSync(dir, { recursive: true, force: true }); });

  // WS10 Round 3 (Fix 5): the UNIQUE partial index on (resource_rid) WHERE status IN
  // ('pending','evaluating') means each test must clean up its proposals before the next
  // test can create one on the same resource. Mark any remaining active proposals as
  // 'superseded' so the unique constraint is clear for the next it() block.
  afterEach(() => {
    sql.db.prepare(
      `UPDATE proposals SET status = 'superseded', decided_at = datetime('now'), decided_by = 'test-cleanup'
         WHERE resource_rid = 'resource:test.hitl.doc' AND status IN ('pending', 'evaluating')`,
    ).run();
  });

  it("approve() on hitl-only proposal with NO approved HITL row -> committed:false (self-approve blocked)", async () => {
    const prop = engine.propose(env, {
      rid: "resource:test.hitl.doc",
      candidate_content: "improved content",
      justification: "self-approve attempt",
    });
    await engine.evaluate(env, prop.proposal_id);
    // commit() queues it but does NOT commit
    const commitResult = await engine.commit(env, prop.proposal_id);
    expect(commitResult.committed).toBe(false);
    expect(commitResult.reason).toMatch(/hitl-only/);

    // approve() directly — no HITL row has been resolved yet; still needs a token to reach that check
    const approveEnv = opEnvWith(env, "evolution.approve", prop.proposal_id, prop.proposal_id);
    const approveResult = await withOpKey(() => engine.approve(approveEnv, prop.proposal_id));
    expect(approveResult.committed).toBe(false);
    expect(approveResult.reason).toMatch(/human-approved HITL/);

    // Resource must NOT have changed
    const resource = engine.getResource("resource:test.hitl.doc")!;
    expect(resource.current_version).toBe(
      engine.getResource("resource:test.hitl.doc")!.versions[0]!.version,
    );
  });

  it("approve() after human hitlResolve(...,'approved') -> commits", async () => {
    const prop = engine.propose(env, {
      rid: "resource:test.hitl.doc",
      candidate_content: "human-approved content",
      justification: "proper human approval flow",
    });
    await engine.evaluate(env, prop.proposal_id);
    // Queue the HITL row
    await engine.commit(env, prop.proposal_id);

    // Find the pending HITL row for this proposal
    const row = sql.db.prepare(
      `SELECT request_id FROM hitl_queue
       WHERE kind = 'evolution.approve'
         AND json_extract(payload_json, '$.proposal_id') = ?
         AND status = 'pending'
       LIMIT 1`,
    ).get(prop.proposal_id) as { request_id: string } | undefined;
    expect(row).toBeDefined();

    // Human resolves it — needs a capability token bound to the request_id
    const resolveEnv = opEnvWith(humanEnv, "hitl.resolve", row!.request_id, row!.request_id);
    withOpKey(() => governance.hitlResolve(resolveEnv, row!.request_id, "approved"));

    // Now approve() should commit — needs a capability token bound to the proposal_id
    const approveEnv = opEnvWith(env, "evolution.approve", prop.proposal_id, prop.proposal_id);
    const approveResult = await withOpKey(() => engine.approve(approveEnv, prop.proposal_id));
    expect(approveResult.committed).toBe(true);
    expect(approveResult.version).toBeTruthy();
  });

  it("approve() without evaluation -> rejected (HITL check fires first when no HITL row exists)", async () => {
    const prop = engine.propose(env, {
      rid: "resource:test.hitl.doc",
      candidate_content: "no eval content",
      justification: "skipping evaluate step",
    });
    // Do NOT call engine.evaluate() or engine.commit() — no HITL row created.
    // The HITL guard fires before the eval guard (correct: missing HITL is the
    // primary gate; missing eval would also block but is secondary).
    const approveEnv3 = opEnvWith(env, "evolution.approve", prop.proposal_id, prop.proposal_id);
    const approveResult = await withOpKey(() => engine.approve(approveEnv3, prop.proposal_id));
    expect(approveResult.committed).toBe(false);
    expect(approveResult.reason).toMatch(/human-approved HITL/);
  });

  it("approve() with approved HITL but missing evaluation -> rejected on eval check", async () => {
    const prop = engine.propose(env, {
      rid: "resource:test.hitl.doc",
      candidate_content: "hitl but no eval content",
      justification: "hitl approved but no eval",
    });
    // Manually create and immediately approve a HITL row (bypassing commit()).
    const hitlRow = governance.hitlRequest(env, {
      kind: "evolution.approve",
      payload: { proposal_id: prop.proposal_id, rid: "resource:test.hitl.doc" },
    });
    const resolveEnv2 = opEnvWith(humanEnv, "hitl.resolve", hitlRow.request_id, hitlRow.request_id);
    withOpKey(() => governance.hitlResolve(resolveEnv2, hitlRow.request_id, "approved"));

    // Still no evaluation — should be rejected on eval check
    const approveEnv4 = opEnvWith(env, "evolution.approve", prop.proposal_id, prop.proposal_id);
    const approveResult = await withOpKey(() => engine.approve(approveEnv4, prop.proposal_id));
    expect(approveResult.committed).toBe(false);
    expect(approveResult.reason).toMatch(/evaluate before approve/);
  });

  it("idempotent HITL row creation: commit() called twice does not duplicate rows", async () => {
    const prop = engine.propose(env, {
      rid: "resource:test.hitl.doc",
      candidate_content: "idempotent test content",
      justification: "idempotency check",
    });
    await engine.evaluate(env, prop.proposal_id);
    await engine.commit(env, prop.proposal_id);
    await engine.commit(env, prop.proposal_id);  // second call

    const count = sql.db.prepare(
      `SELECT COUNT(*) AS cnt FROM hitl_queue
       WHERE kind = 'evolution.approve'
         AND json_extract(payload_json, '$.proposal_id') = ?`,
    ).get(prop.proposal_id) as { cnt: number };
    expect(count.cnt).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TE-EV-2: missing evaluator hard-fails, not passes on delta=0
// Each sub-case uses an isolated engine so evaluator injection is clean.
// ---------------------------------------------------------------------------

/** Shared setup helper — creates an isolated store + engine for a single test. */
function makeIsolatedEngine(baseDir: string, label: string) {
  const dir = mkdtempSync(join(baseDir, `eights-${label}-`));
  const sql = new SqliteStore(join(dir, "state.db"));
  sql.migrate();
  // WS10 Round 3 (Fix 1a): actors table lookup in propose() — register the TE-EV-2 actor.
  registerHumanActor(sql, "test-ev2");
  const audit = new AuditEngine(sql, join(dir, "events"));
  const policy = new PolicyEngine(sql);
  const engine = new EvolutionEngine(sql, join(dir, "resources"), policy, audit);
  engine.setWriteRouter(new WriteRouter([]));
  return { dir, sql, engine };
}

describe("TE-EV-2 — missing evaluator blocks auto/commit", () => {
  const env: Envelope = {
    tenant_id: "local", actor_id: "test-ev2", project_id: "TheEights",
    domain: "infra", scope: [], trace_id: "t-ev2",
  };
  const baseDir = tmpdir();

  it("EvalRegistry returns evaluator_missing=true and delta=-1 when no adapter matches", async () => {
    const reg = new EvalRegistry();
    // No adapters registered — pick() returns null.
    const result = await reg.evaluate({
      rid: "x", kind: "squad", consumer: "hydra",
      current_content: "old", candidate_content: "new",
    });
    expect(result.evaluator_missing).toBe(true);
    expect(result.eval_delta).toBe(-1);
  });

  it("(a) evaluator THROWS -> commit blocked, resource version unchanged", async () => {
    const { dir, sql, engine } = makeIsolatedEngine(baseDir, "ev2a");
    try {
      const throwingAdapter: EvalAdapter = {
        name: "throws", kinds: ["prompt"], consumers: "*",
        async evaluate() { throw new Error("simulated evaluator crash"); },
      };
      const reg = new EvalRegistry();
      reg.register(throwingAdapter);
      engine.setEvaluator(reg);

      engine.register(env, {
        rid: "resource:test.ev2a.prompt", kind: "prompt", risk_class: "low",
        evolution_policy: "auto", initial_content: "original",
      });
      const originalVersion = engine.getResource("resource:test.ev2a.prompt")!.current_version;

      const prop = engine.propose(env, {
        rid: "resource:test.ev2a.prompt", candidate_content: "new content",
        justification: "throwing evaluator test",
      });
      const report = await engine.evaluate(env, prop.proposal_id);
      expect(report.evaluator_missing).toBe(true);
      expect(report.eval_delta).toBe(-1);
      expect(report.notes).toMatch(/evaluator threw/);

      const result = await engine.commit(env, prop.proposal_id);
      expect(result.committed).toBe(false);
      expect(result.reason).toMatch(/evaluator_missing/);

      // Resource version must be unchanged — performCommit was NOT reached.
      expect(engine.getResource("resource:test.ev2a.prompt")!.current_version).toBe(originalVersion);
    } finally { sql.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("(b) NO evaluator injected at all -> commit blocked, resource version unchanged", async () => {
    const { dir, sql, engine } = makeIsolatedEngine(baseDir, "ev2b");
    try {
      // setEvaluator() never called.
      engine.register(env, {
        rid: "resource:test.ev2b.prompt", kind: "prompt", risk_class: "low",
        evolution_policy: "auto", initial_content: "original",
      });
      const originalVersion = engine.getResource("resource:test.ev2b.prompt")!.current_version;

      const prop = engine.propose(env, {
        rid: "resource:test.ev2b.prompt", candidate_content: "new content",
        justification: "no evaluator injected",
      });
      const report = await engine.evaluate(env, prop.proposal_id);
      expect(report.evaluator_missing).toBe(true);
      expect(report.eval_delta).toBe(-1);

      const result = await engine.commit(env, prop.proposal_id);
      expect(result.committed).toBe(false);
      expect(result.reason).toMatch(/evaluator_missing/);

      expect(engine.getResource("resource:test.ev2b.prompt")!.current_version).toBe(originalVersion);
    } finally { sql.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("(c) registry has NO matching adapter -> evaluator_missing -> commit blocked, version unchanged", async () => {
    const { dir, sql, engine } = makeIsolatedEngine(baseDir, "ev2c");
    try {
      // NoopEval covers prompt/team/rubric/... but NOT squad/constitution.
      const reg = new EvalRegistry();
      reg.register(new NoopEval());
      engine.setEvaluator(reg);

      engine.register(env, {
        rid: "resource:test.ev2c.squad", kind: "squad", risk_class: "low",
        evolution_policy: "auto", initial_content: "original squad",
      });
      const originalVersion = engine.getResource("resource:test.ev2c.squad")!.current_version;

      const prop = engine.propose(env, {
        rid: "resource:test.ev2c.squad", candidate_content: "new squad",
        justification: "no adapter for squad kind",
      });
      const report = await engine.evaluate(env, prop.proposal_id);
      expect(report.evaluator_missing).toBe(true);
      expect(report.eval_delta).toBe(-1);

      const result = await engine.commit(env, prop.proposal_id);
      expect(result.committed).toBe(false);
      expect(result.reason).toMatch(/evaluator_missing/);

      expect(engine.getResource("resource:test.ev2c.squad")!.current_version).toBe(originalVersion);
    } finally { sql.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("(d) real adapter returning delta>=0 -> commits (no regression)", async () => {
    const { dir, sql, engine } = makeIsolatedEngine(baseDir, "ev2d");
    try {
      const squadAdapter: EvalAdapter = {
        name: "squad-pass", kinds: ["squad"], consumers: "*",
        async evaluate() { return { eval_delta: 1, metric_scores: {}, notes: "squad ok" }; },
      };
      const reg = new EvalRegistry();
      reg.register(squadAdapter);
      engine.setEvaluator(reg);

      engine.register(env, {
        rid: "resource:test.ev2d.squad", kind: "squad", risk_class: "low",
        evolution_policy: "auto", initial_content: "original squad",
      });
      const originalVersion = engine.getResource("resource:test.ev2d.squad")!.current_version;

      const prop = engine.propose(env, {
        rid: "resource:test.ev2d.squad", candidate_content: "improved squad",
        justification: "regression guard — normal auto-commit still works",
      });
      const report = await engine.evaluate(env, prop.proposal_id);
      expect(report.evaluator_missing).toBe(false);
      expect(report.eval_delta).toBe(1);

      const result = await engine.commit(env, prop.proposal_id);
      expect(result.committed).toBe(true);
      // Version must have changed.
      expect(engine.getResource("resource:test.ev2d.squad")!.current_version).not.toBe(originalVersion);
    } finally { sql.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
