/**
 * Tests for the evolution governance hardening fixes:
 *
 * TE-EV-1 (#1): 'evolution.approve' is a reserved HITL kind — the public
 *               hitl.request MCP tool must reject it.
 *
 * TE-EV-3 (#3): risk/policy compatibility is enforced in both the engine's
 *               register() and the MCP RegisterArgs Zod schema.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/stores/sqlite.js";
import { AuditEngine } from "../src/engines/audit.js";
import { PolicyEngine } from "../src/engines/policy.js";
import { EvolutionEngine } from "../src/engines/evolution.js";
import { GovernanceStateEngine } from "../src/engines/governance-state.js";
import { registerGovernanceTools } from "../src/mcp/governance.js";
import { RegisterArgs } from "../src/mcp/evolution.js";
import { WriteRouter } from "../src/engines/writeback.js";
import { EvalRegistry } from "../src/engines/eval/registry.js";
import type { EvalAdapter } from "../src/engines/eval/registry.js";
import type { Envelope } from "../src/schemas/envelope.js";

const env: Envelope = {
  tenant_id: "local", actor_id: "test-govfix", project_id: "TheEights",
  domain: "infra", scope: [], trace_id: "t-govfix",
};

// ---------------------------------------------------------------------------
// Shared infrastructure
// ---------------------------------------------------------------------------
let dir: string;
let sql: SqliteStore;
let audit: AuditEngine;
let governance: GovernanceStateEngine;
let evolution: EvolutionEngine;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "eights-govfix-"));
  sql = new SqliteStore(join(dir, "state.db"));
  sql.migrate();
  audit = new AuditEngine(sql, join(dir, "events"));
  const policy = new PolicyEngine(sql);
  governance = new GovernanceStateEngine(sql, audit);
  evolution = new EvolutionEngine(sql, join(dir, "resources"), policy, audit);
  evolution.setWriteRouter(new WriteRouter([]));
  evolution.setGovernance(governance);

  const passingAdapter: EvalAdapter = {
    name: "pass", kinds: ["prompt"], consumers: "*",
    async evaluate() { return { eval_delta: 1, metric_scores: {}, notes: "ok" }; },
  };
  const reg = new EvalRegistry();
  reg.register(passingAdapter);
  evolution.setEvaluator(reg);
});

afterAll(() => { sql.close(); rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// TE-EV-1 / Fix #1: reserved kind enforcement in the public MCP hitl.request
// ---------------------------------------------------------------------------
describe("Fix #1 — 'evolution.approve' is a reserved HITL kind", () => {
  it("public hitl.request with kind='evolution.approve' -> throws (reserved kind)", async () => {
    const tools = registerGovernanceTools(
      // policy engine not needed for these tools — pass a minimal stub
      { policyEvaluate: () => ({}), consistencyCheck: () => ({}), accessCheck: () => ({}), redact: () => ({}) } as never,
      governance,
    );
    const handler = tools["eights.governance.hitl.request"].handler;
    await expect(
      handler({ envelope: env, kind: "evolution.approve", payload: { proposal_id: "fake_prop", rid: "resource:x" } }),
    ).rejects.toThrow(/reserved kind/);
  });

  it("public hitl.request with other kinds still works", async () => {
    const tools = registerGovernanceTools(
      { policyEvaluate: () => ({}), consistencyCheck: () => ({}), accessCheck: () => ({}), redact: () => ({}) } as never,
      governance,
    );
    const handler = tools["eights.governance.hitl.request"].handler;
    const row = await handler({ envelope: env, kind: "workflow.pause", payload: { reason: "test" } });
    expect((row as { kind: string }).kind).toBe("workflow.pause");
    expect((row as { status: string }).status).toBe("pending");
  });

  it("engine-created 'evolution.approve' row still works for the approve() happy path", async () => {
    const humanEnv: Envelope = { ...env, actor_id: "operator-rob" };

    evolution.register(env, {
      rid: "resource:test.reserved.hitl", kind: "prompt", risk_class: "medium",
      initial_content: "original",
    });
    const prop = evolution.propose(env, {
      rid: "resource:test.reserved.hitl", candidate_content: "improved",
      justification: "testing reserved-kind + approve happy path",
    });
    await evolution.evaluate(env, prop.proposal_id);
    // commit() creates the hitl_queue row via engine (not via public MCP tool)
    await evolution.commit(env, prop.proposal_id);

    // Row should exist in DB with kind='evolution.approve'
    const row = sql.db.prepare(
      `SELECT request_id, status FROM hitl_queue
       WHERE kind = 'evolution.approve'
         AND json_extract(payload_json, '$.proposal_id') = ?`,
    ).get(prop.proposal_id) as { request_id: string; status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("pending");

    // Human resolves it
    governance.hitlResolve(humanEnv, row!.request_id, "approved");

    // approve() should now commit
    const result = await evolution.approve(env, prop.proposal_id);
    expect(result.committed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TE-EV-3 / Fix #3: risk/policy compatibility — engine register() layer
// ---------------------------------------------------------------------------
describe("Fix #3 — risk/policy compatibility enforced in engine register()", () => {
  it("critical + auto -> throws", () => {
    expect(() => evolution.register(env, {
      rid: "resource:test.compat.critical-auto", kind: "policy",
      risk_class: "critical", evolution_policy: "auto",
      initial_content: "x",
    })).toThrow(/risk\/policy conflict.*critical.*frozen/);
  });

  it("critical + hitl-only -> throws (must be frozen)", () => {
    expect(() => evolution.register(env, {
      rid: "resource:test.compat.critical-hitl", kind: "policy",
      risk_class: "critical", evolution_policy: "hitl-only",
      initial_content: "x",
    })).toThrow(/risk\/policy conflict.*critical.*frozen/);
  });

  it("high + auto -> throws", () => {
    expect(() => evolution.register(env, {
      rid: "resource:test.compat.high-auto", kind: "policy",
      risk_class: "high", evolution_policy: "auto",
      initial_content: "x",
    })).toThrow(/risk\/policy conflict.*high.*hitl-only/);
  });

  it("medium + auto -> throws", () => {
    expect(() => evolution.register(env, {
      rid: "resource:test.compat.medium-auto", kind: "policy",
      risk_class: "medium", evolution_policy: "auto",
      initial_content: "x",
    })).toThrow(/risk\/policy conflict.*medium.*hitl-only/);
  });

  it("critical + frozen -> allowed", () => {
    expect(() => evolution.register(env, {
      rid: "resource:test.compat.critical-frozen", kind: "policy",
      risk_class: "critical", evolution_policy: "frozen",
      initial_content: "x",
    })).not.toThrow();
  });

  it("low + auto -> allowed", () => {
    expect(() => evolution.register(env, {
      rid: "resource:test.compat.low-auto", kind: "prompt",
      risk_class: "low", evolution_policy: "auto",
      initial_content: "x",
    })).not.toThrow();
  });

  it("high + hitl-only -> allowed", () => {
    expect(() => evolution.register(env, {
      rid: "resource:test.compat.high-hitl", kind: "policy",
      risk_class: "high", evolution_policy: "hitl-only",
      initial_content: "x",
    })).not.toThrow();
  });

  it("critical default (no explicit policy) -> frozen (valid by default, no throw)", () => {
    // DEFAULT_EVOLUTION_POLICY maps critical -> frozen, so no explicit policy = ok
    expect(() => evolution.register(env, {
      rid: "resource:test.compat.critical-default", kind: "policy",
      risk_class: "critical",
      initial_content: "x",
    })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TE-EV-3 / Fix #3: risk/policy compatibility — MCP RegisterArgs Zod schema
// ---------------------------------------------------------------------------
describe("Fix #3 — risk/policy compatibility enforced in MCP RegisterArgs schema", () => {
  it("critical + auto fails Zod parse", () => {
    const result = RegisterArgs.safeParse({
      envelope: env, rid: "r", kind: "policy",
      risk_class: "critical", evolution_policy: "auto",
      initial_content: "x",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0]?.message).toMatch(/risk\/policy conflict/);
    }
  });

  it("high + auto fails Zod parse", () => {
    const result = RegisterArgs.safeParse({
      envelope: env, rid: "r", kind: "policy",
      risk_class: "high", evolution_policy: "auto",
      initial_content: "x",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0]?.message).toMatch(/risk\/policy conflict/);
    }
  });

  it("low + auto passes Zod parse", () => {
    const result = RegisterArgs.safeParse({
      envelope: env, rid: "r", kind: "prompt",
      risk_class: "low", evolution_policy: "auto",
      initial_content: "x",
    });
    expect(result.success).toBe(true);
  });

  it("critical + frozen passes Zod parse", () => {
    const result = RegisterArgs.safeParse({
      envelope: env, rid: "r", kind: "policy",
      risk_class: "critical", evolution_policy: "frozen",
      initial_content: "x",
    });
    expect(result.success).toBe(true);
  });

  it("critical with no explicit policy (defaults to frozen) passes Zod parse", () => {
    const result = RegisterArgs.safeParse({
      envelope: env, rid: "r", kind: "policy",
      risk_class: "critical",
      initial_content: "x",
    });
    expect(result.success).toBe(true);
  });
});
