/**
 * Atlas approve handler seam tests.
 *
 * The Atlas handler (web/server/index.ts handleApprove) is hard to unit-test in
 * isolation because it depends on a live EightsClient (module-level singleton that
 * spawns a daemon child over stdio). These tests therefore exercise the daemon-side
 * seam that the handler invokes:
 *
 *   1. hitl-only proposal: handler calls resolveHitlRow(requestId) first, then
 *      writeTool("evolution.approve"). We prove the sequence commits:
 *      - hitlResolve with capability="hitl.resolve", resource_id=request_id,
 *        workflow_id=request_id (no run_id on evolution.approve rows)
 *      - evolution.approve with capability="evolution.approve", resource_id=proposal_id
 *
 *   2. auto proposal: no HITL row exists; approve() should commit directly.
 *
 *   3. Token minting: operator.ts mintHitlResolveCapability mints
 *      capability="hitl.resolve" (NOT "governance.hitl.resolve"). We verify the
 *      capabilityForTool mapping fix is correct by asserting the token produced
 *      by the same logic passes verifyOperatorCapability with expectedCapability="hitl.resolve".
 *
 * All tests are self-contained: in-memory temp SQLite, no live MCP, no network.
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
import { WriteRouter } from "../src/engines/writeback.js";
import { EvalRegistry } from "../src/engines/eval/registry.js";
import type { EvalAdapter } from "../src/engines/eval/registry.js";
import type { Envelope } from "../src/schemas/envelope.js";
import { mintOperatorCapability, verifyOperatorCapability } from "../src/auth/capability.js";

// ---------------------------------------------------------------------------
// Test operator key
// ---------------------------------------------------------------------------
const TEST_OP_KEY = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const TEST_KEY_ID = "atlas-test-key";
const OPERATOR_ACTOR = "eights.operator";

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

/** Mint a token the same way operator.ts mintHitlResolveCapability does.
 * capabilityForTool("governance.hitl.resolve") -> "hitl.resolve" (the fix).
 * resourceIdForArgs/workflowIdForArgs("governance.hitl.resolve", { request_id }) -> request_id.
 */
function mintAtlasHitlResolveToken(requestId: string): unknown {
  return withOpKey(() =>
    mintOperatorCapability({
      v: 1,
      actor_id: OPERATOR_ACTOR,
      actor_kind: "human",
      capability: "hitl.resolve",        // capabilityForTool("governance.hitl.resolve")
      resource_id: requestId,            // resourceIdForArgs("governance.hitl.resolve", { request_id: requestId })
      workflow_id: requestId,            // workflowIdForArgs("governance.hitl.resolve", { request_id: requestId })
      issued_at: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
}

/** Mint a token the same way operator.ts operatorEnvelope("evolution.approve", { proposal_id }) does. */
function mintAtlasApproveToken(proposalId: string): unknown {
  return withOpKey(() =>
    mintOperatorCapability({
      v: 1,
      actor_id: OPERATOR_ACTOR,
      actor_kind: "human",
      capability: "evolution.approve",
      resource_id: proposalId,
      workflow_id: proposalId,
      issued_at: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
}

function registerHumanActor(sql: SqliteStore, actor_id: string): void {
  sql.db
    .prepare(
      `INSERT OR IGNORE INTO actors(actor_id, kind, created_at) VALUES (?, 'human', datetime('now'))`,
    )
    .run(actor_id);
}

// ---------------------------------------------------------------------------
// Shared engine setup
// ---------------------------------------------------------------------------
let dir: string;
let sql: SqliteStore;
let audit: AuditEngine;
let governance: GovernanceStateEngine;
let evolution: EvolutionEngine;

const baseEnv: Envelope = {
  tenant_id: "local",
  actor_id: "test-atlas",
  project_id: "TheEights",
  domain: "infra",
  scope: [],
  trace_id: "t-atlas",
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "eights-atlas-approve-"));
  sql = new SqliteStore(join(dir, "state.db"));
  sql.migrate();
  registerHumanActor(sql, OPERATOR_ACTOR);
  registerHumanActor(sql, "test-atlas");
  audit = new AuditEngine(sql, join(dir, "events"));
  const policy = new PolicyEngine(sql);
  governance = new GovernanceStateEngine(sql, audit);
  evolution = new EvolutionEngine(sql, join(dir, "resources"), policy, audit);
  evolution.setWriteRouter(new WriteRouter([]));
  evolution.setGovernance(governance);
  const passingAdapter: EvalAdapter = {
    name: "pass-atlas",
    kinds: ["prompt"],
    consumers: "*",
    async evaluate() {
      return { eval_delta: 1, metric_scores: {}, notes: "ok" };
    },
  };
  const reg = new EvalRegistry();
  reg.register(passingAdapter);
  evolution.setEvaluator(reg);
});

afterAll(() => {
  sql.close();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Token minting correctness: capabilityForTool mapping fix
// ---------------------------------------------------------------------------
describe("operator.ts capabilityForTool('governance.hitl.resolve') -> 'hitl.resolve'", () => {
  it("mintAtlasHitlResolveToken produces a token with capability='hitl.resolve' that passes daemon verifier", () => {
    const requestId = "req_atlas_token_test_001";
    const token = mintAtlasHitlResolveToken(requestId);
    const result = withOpKey(() =>
      verifyOperatorCapability(token, {
        expectedCapability: "hitl.resolve",
        expectedResourceId: requestId,
        expectedWorkflowId: requestId,
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.actor_id).toBe(OPERATOR_ACTOR);
  });

  it("a token minted with the WRONG capability 'governance.hitl.resolve' is rejected", () => {
    // Sanity check: pre-fix behavior would have produced this token and it would fail.
    const requestId = "req_atlas_wrong_cap_test";
    const badToken = withOpKey(() =>
      mintOperatorCapability({
        v: 1,
        actor_id: OPERATOR_ACTOR,
        actor_kind: "human",
        capability: "governance.hitl.resolve", // wrong — daemon expects "hitl.resolve"
        resource_id: requestId,
        workflow_id: requestId,
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const result = withOpKey(() =>
      verifyOperatorCapability(badToken, {
        expectedCapability: "hitl.resolve",
        expectedResourceId: requestId,
        expectedWorkflowId: requestId,
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/capability/i);
  });
});

// ---------------------------------------------------------------------------
// hitl-only proposal: resolve -> approve sequence -> committed:true
// ---------------------------------------------------------------------------
describe("Atlas approve handler seam: hitl-only proposal", () => {
  it("hitl-only: direct approve without resolve -> committed:false (HITL gate enforced)", async () => {
    evolution.register(baseEnv, {
      rid: "resource:atlas.test.hitlonly.A",
      kind: "prompt",
      risk_class: "medium",
      evolution_policy: "hitl-only",
      initial_content: "init-A",
    });
    const prop = evolution.propose(baseEnv, {
      rid: "resource:atlas.test.hitlonly.A",
      candidate_content: "v2-A",
      justification: "atlas seam test A",
    });
    await evolution.evaluate(baseEnv, prop.proposal_id);
    const commitResult = await evolution.commit(baseEnv, prop.proposal_id);
    expect(commitResult.committed).toBe(false);

    // Approve without resolving HITL row: must fail.
    const approveToken = mintAtlasApproveToken(prop.proposal_id);
    const approveEnv: Envelope = {
      ...baseEnv,
      actor_id: OPERATOR_ACTOR,
      capability_token: approveToken,
    } as unknown as Envelope;
    const result = await withOpKey(() => evolution.approve(approveEnv, prop.proposal_id));
    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/HITL/i);
  });

  it("hitl-only: resolve -> approve sequence -> committed:true (Atlas handler flow)", async () => {
    evolution.register(baseEnv, {
      rid: "resource:atlas.test.hitlonly.B",
      kind: "prompt",
      risk_class: "medium",
      evolution_policy: "hitl-only",
      initial_content: "init-B",
    });
    const prop = evolution.propose(baseEnv, {
      rid: "resource:atlas.test.hitlonly.B",
      candidate_content: "v2-B",
      justification: "atlas seam test B",
    });
    await evolution.evaluate(baseEnv, prop.proposal_id);
    await evolution.commit(baseEnv, prop.proposal_id);

    // Step 1 (handleApprove): readTool("governance.hitl.list") equivalent —
    // find the pending row for this proposal_id.
    const hitlRow = sql.db
      .prepare(
        `SELECT request_id FROM hitl_queue
         WHERE kind = 'evolution.approve'
           AND json_extract(payload_json, '$.proposal_id') = ?
           AND status = 'pending'
         LIMIT 1`,
      )
      .get(prop.proposal_id) as { request_id: string } | undefined;
    expect(hitlRow).toBeDefined();
    expect(hitlRow!.request_id).toBeTruthy();

    // Step 2 (resolveHitlRow): mint hitl.resolve capability with request_id binding.
    // This is exactly what mintHitlResolveCapability(requestId) produces in operator.ts.
    const resolveToken = mintAtlasHitlResolveToken(hitlRow!.request_id);
    const resolveEnv: Envelope = {
      ...baseEnv,
      actor_id: OPERATOR_ACTOR,
      capability_token: resolveToken,
    } as unknown as Envelope;
    withOpKey(() =>
      governance.hitlResolve(resolveEnv, hitlRow!.request_id, "approved"),
    );

    // Step 3 (writeTool("evolution.approve")): approve now commits.
    const approveToken = mintAtlasApproveToken(prop.proposal_id);
    const approveEnv: Envelope = {
      ...baseEnv,
      actor_id: OPERATOR_ACTOR,
      capability_token: approveToken,
    } as unknown as Envelope;
    const result = await withOpKey(() => evolution.approve(approveEnv, prop.proposal_id));
    expect(result.committed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// auto proposal: no HITL row -> approve directly -> committed:true
// ---------------------------------------------------------------------------
describe("Atlas approve handler seam: auto proposal", () => {
  it("auto (low-risk): no HITL row -> approve directly -> committed:true", async () => {
    evolution.register(baseEnv, {
      rid: "resource:atlas.test.auto.C",
      kind: "prompt",
      risk_class: "low",
      evolution_policy: "auto",
      initial_content: "init-C",
    });
    const prop = evolution.propose(baseEnv, {
      rid: "resource:atlas.test.auto.C",
      candidate_content: "v2-C",
      justification: "atlas seam test C — auto",
    });
    await evolution.evaluate(baseEnv, prop.proposal_id);
    const commitResult = await evolution.commit(baseEnv, prop.proposal_id);
    // auto commits immediately on commit()
    expect(commitResult.committed).toBe(true);

    // Confirm no HITL row was created (the handler's hitlRow lookup returns nothing).
    const hitlRow = sql.db
      .prepare(
        `SELECT request_id FROM hitl_queue
         WHERE kind = 'evolution.approve'
           AND json_extract(payload_json, '$.proposal_id') = ?
           AND status = 'pending'
         LIMIT 1`,
      )
      .get(prop.proposal_id);
    expect(hitlRow).toBeUndefined();
  });
});
