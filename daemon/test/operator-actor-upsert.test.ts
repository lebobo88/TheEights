/**
 * Startup operator-actor UPSERT test.
 *
 * Proves that the daemon startup registration (daemon/src/index.ts ~211-214)
 * corrects a PRE-EXISTING non-human actor row to kind='human', and that a
 * subsequent operator capability check for that actor passes.
 *
 * Self-contained: temp SQLite, no live MCP, no daemon spawn.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/stores/sqlite.js";
import { AuditEngine } from "../src/engines/audit.js";
import { GovernanceStateEngine } from "../src/engines/governance-state.js";
import { mintOperatorCapability, verifyOperatorCapability } from "../src/auth/capability.js";
import type { Envelope } from "../src/schemas/envelope.js";

const TEST_OP_KEY = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const TEST_KEY_ID = "upsert-test-key";
const OPERATOR_ACTOR_ID = "eights.operator"; // default used by daemon/src/index.ts

/**
 * The exact UPSERT the daemon startup runs (daemon/src/index.ts:211-214).
 * Factored here so the test exercises the identical SQL without spawning a daemon.
 */
function runStartupUpsert(sql: SqliteStore, actorId: string): void {
  sql.db
    .prepare(
      `INSERT INTO actors(actor_id, kind, created_at) VALUES (?, 'human', datetime('now'))
       ON CONFLICT(actor_id) DO UPDATE SET kind = 'human'`,
    )
    .run(actorId);
}

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

let dir: string;
let sql: SqliteStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "eights-upsert-"));
  sql = new SqliteStore(join(dir, "state.db"));
  sql.migrate();
});

afterAll(() => {
  sql.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("startup operator-actor UPSERT", () => {
  it("pre-existing kind='agent' row is corrected to kind='human' by the upsert", () => {
    // Pre-insert actor with kind='agent' simulating an older daemon version.
    sql.db
      .prepare(
        `INSERT OR IGNORE INTO actors(actor_id, kind, created_at) VALUES (?, 'agent', datetime('now'))`,
      )
      .run(OPERATOR_ACTOR_ID);

    // Confirm pre-condition: kind is currently 'agent'.
    const before = sql.db
      .prepare(`SELECT kind FROM actors WHERE actor_id = ?`)
      .get(OPERATOR_ACTOR_ID) as { kind: string } | undefined;
    expect(before?.kind).toBe("agent");

    // Run the startup upsert (identical SQL to daemon/src/index.ts:211-214).
    runStartupUpsert(sql, OPERATOR_ACTOR_ID);

    // Assert kind is now 'human'.
    const after = sql.db
      .prepare(`SELECT kind FROM actors WHERE actor_id = ?`)
      .get(OPERATOR_ACTOR_ID) as { kind: string } | undefined;
    expect(after?.kind).toBe("human");
  });

  it("after upsert, a hitl.resolve capability token for that actor passes requireOperatorCapability", () => {
    // The actor row must already exist as kind='human' from the previous test.
    const requestId = "req_upsert_test_001";

    // Mint a hitl.resolve token (same logic as mintHitlResolveCapability in operator.ts).
    const token = withOpKey(() =>
      mintOperatorCapability({
        v: 1,
        actor_id: OPERATOR_ACTOR_ID,
        actor_kind: "human",
        capability: "hitl.resolve",
        resource_id: requestId,
        workflow_id: requestId,
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );

    // Verify the token passes — this is what GovernanceStateEngine.hitlResolve does.
    const result = withOpKey(() =>
      verifyOperatorCapability(token, {
        expectedCapability: "hitl.resolve",
        expectedResourceId: requestId,
        expectedWorkflowId: requestId,
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.actor_id).toBe(OPERATOR_ACTOR_ID);

    // Also verify the actors-table kind='human' binding that requireOperatorCapability checks.
    const actorRow = sql.db
      .prepare(`SELECT kind FROM actors WHERE actor_id = ?`)
      .get(result.actor_id) as { kind: string } | undefined;
    expect(actorRow?.kind).toBe("human");
  });

  it("subsequent upsert on an already-human row is idempotent (kind remains 'human')", () => {
    // Running startup twice must not degrade the row.
    runStartupUpsert(sql, OPERATOR_ACTOR_ID);
    const row = sql.db
      .prepare(`SELECT kind FROM actors WHERE actor_id = ?`)
      .get(OPERATOR_ACTOR_ID) as { kind: string } | undefined;
    expect(row?.kind).toBe("human");
  });

  it("full hitlResolve engine call succeeds after upsert corrects kind (end-to-end actor binding)", () => {
    // Wire a minimal GovernanceStateEngine and prove hitlResolve does not throw
    // the 'actor_kind not human' refusal after the upsert corrects the row.
    const audit = new AuditEngine(sql, join(dir, "events"));
    const governance = new GovernanceStateEngine(sql, audit);

    // Insert a pending HITL row directly.
    const requestId = "req_upsert_e2e_001";
    sql.db
      .prepare(
        `INSERT INTO hitl_queue(request_id, run_id, kind, payload_json, status, requested_at)
         VALUES (?, NULL, 'workflow.pause', '{}', 'pending', datetime('now'))`,
      )
      .run(requestId);

    const token = withOpKey(() =>
      mintOperatorCapability({
        v: 1,
        actor_id: OPERATOR_ACTOR_ID,
        actor_kind: "human",
        capability: "hitl.resolve",
        resource_id: requestId,
        workflow_id: requestId,
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );

    const env: Envelope = {
      tenant_id: "local",
      actor_id: OPERATOR_ACTOR_ID,
      project_id: "TheEights",
      domain: "governance",
      scope: [],
      trace_id: "t-upsert-e2e",
      capability_token: token,
    } as unknown as Envelope;

    // Should not throw — the upsert corrected kind='human', so the actor binding passes.
    expect(() =>
      withOpKey(() => governance.hitlResolve(env, requestId, "approved")),
    ).not.toThrow();

    const resolved = sql.db
      .prepare(`SELECT status FROM hitl_queue WHERE request_id = ?`)
      .get(requestId) as { status: string } | undefined;
    expect(resolved?.status).toBe("approved");
  });
});
