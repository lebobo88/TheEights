/**
 * GovernanceStateEngine — durable budget / loop-ceiling / circuit-breaker /
 * HITL queue. Hydra's `BudgetLedger` lived only in `HydraState` (RAM); a crash
 * lost it. This engine moves all four into the audit-backed SQLite store so:
 *
 *   - budget caps survive daemon restart
 *   - loop/depth counts can't be reset by re-instantiating state
 *   - HITL requests outlive the supervisor that opened them
 *   - breaker trips are queryable across runs
 *
 * Every action both gates (returns proceed|downgrade|block|trip) and audits.
 */
import { nanoid } from "nanoid";
import type { SqliteStore } from "../stores/sqlite.js";
import type { AuditEngine } from "./audit.js";
import type { Envelope } from "../schemas/envelope.js";
import { verifyOperatorCapability } from "../auth/capability.js";

export type CeilingKind = "iteration" | "depth" | "failure";
export type BudgetAction = "proceed" | "downgrade" | "block";
export type CeilingAction = "proceed" | "warn" | "block" | "trip";

export interface BudgetChargeResult {
  run_id: string;
  spent: number;
  cap: number;
  remaining: number;
  fraction: number;
  action: BudgetAction;
  reason: string;
}

export interface CeilingTickResult {
  run_id: string;
  kind: CeilingKind;
  count: number;
  cap: number;
  action: CeilingAction;
  reason: string;
}

export interface HitlRequestRow {
  request_id: string;
  run_id: string | null;
  kind: string;
  payload: unknown;
  status: "pending" | "approved" | "rejected" | "expired";
  requested_at: string;
  resolved_at?: string;
  resolved_by?: string;
  decision?: unknown;
}

export interface BreakerStatus {
  node_id: string;
  consecutive_failures: number;
  tripped: boolean;
  tripped_at?: string;
  last_failure_at?: string;
}

const DEFAULTS = {
  budget_cap_usd: 100,
  downgrade_fraction: 0.8,
  iteration_cap: 25,
  depth_cap: 5,
  failure_cap: 3,
};

export class GovernanceStateEngine {
  constructor(
    private readonly sql: SqliteStore,
    private readonly audit: AuditEngine,
  ) {}

  /**
   * Enforce operator capability on a governance op.
   *
   * Checks (in order):
   *   1. capability_token present in envelope
   *   2. token verifies (HMAC, schema, expiry, TTL, field checks)
   *   3. token.actor_id === env.actor_id (bind token actor to envelope actor)
   *   4. token.actor_id registered in actors table with kind='human'
   *   5. single-use: sig.value (jti) not already consumed (replay prevention)
   *      → insert into consumed_capabilities transactionally
   *
   * Throws a descriptive Error on any failure. Reason strings never include token values.
   */
  private requireOperatorCapability(
    env: Envelope,
    capability: string,
    resourceId: string,
    workflowId: string,
    opLabel: string,
  ): void {
    const rawEnv = env as Record<string, unknown>;
    const token = rawEnv["capability_token"];
    if (token === undefined || token === null) {
      this.audit.record("governance.auth.rejected", env, { op: opLabel, reason: "missing capability_token" });
      throw new Error(`${opLabel} requires an operator capability token (capability_token missing in envelope)`);
    }
    const result = verifyOperatorCapability(token, {
      expectedCapability: capability,
      expectedWorkflowId: workflowId,
      expectedResourceId: resourceId,
    });
    if (!result.valid) {
      this.audit.record("governance.auth.rejected", env, { op: opLabel, reason: result.reason });
      throw new Error(`${opLabel} refused: capability token invalid (${result.reason})`);
    }
    // Token actor MUST equal envelope's claimed actor (Fix #2).
    if (result.actor_id !== env.actor_id) {
      this.audit.record("governance.auth.rejected", env, { op: opLabel, reason: "actor_id mismatch" });
      throw new Error(`${opLabel} refused: token actor_id does not match envelope actor_id`);
    }
    const actorId = result.actor_id;
    // actors-table binding: actor_id must exist with kind='human'.
    const actorRow = this.sql.db.prepare(
      `SELECT kind FROM actors WHERE actor_id = ?`,
    ).get(actorId) as { kind: string } | undefined;
    if (!actorRow) {
      this.audit.record("governance.auth.rejected", env, { op: opLabel, reason: "actor not registered" });
      throw new Error(`${opLabel} refused: token actor_id is not registered in actors table`);
    }
    if (actorRow.kind !== "human") {
      this.audit.record("governance.auth.rejected", env, { op: opLabel, reason: "actor_kind not human" });
      throw new Error(`${opLabel} refused: token actor must have kind=human in actors table`);
    }
    // Single-use: use the jti returned by the VERIFIER (from the normalized, HMAC-verified
    // payload) — NOT a re-extraction from the raw token. A hostile getter/toJSON on the raw
    // token could return a different jti at extraction time, allowing replay. result.jti is
    // the jti that was proven-correct by the HMAC check (Fix 6.3).
    const jti = result.jti;
    if (!jti) {
      this.audit.record("governance.auth.rejected", env, { op: opLabel, reason: "jti unavailable from verifier" });
      throw new Error(`${opLabel} refused: capability token is not replayable (jti unavailable)`);
    }
    const consumed_at = new Date().toISOString();
    const inserted = this.sql.db.prepare(
      `INSERT OR IGNORE INTO consumed_capabilities(jti, consumed_at, op) VALUES (?,?,?)`,
    ).run(jti, consumed_at, opLabel);
    if (inserted.changes === 0) {
      this.audit.record("governance.auth.rejected", env, { op: opLabel, reason: "token already consumed (replay)" });
      throw new Error(`${opLabel} refused: capability token has already been used (replay prevented)`);
    }
    this.audit.record("governance.auth.accepted", env, { op: opLabel, actor_id: actorId, capability });
  }

  /**
   * Set or update a per-run cap. Requires a "governance.cap.set" operator capability
   * bound to run_id (resource_id = run_id, workflow_id = run_id).
   * Gated so an adversary cannot weaken governance ceilings without a signed token.
   */
  setCap(env: Envelope, run_id: string, kind: "budget" | CeilingKind, cap: number): void {
    this.requireOperatorCapability(env, "governance.cap.set", run_id, run_id, "setCap");
    this.sql.db.prepare(
      `INSERT INTO governance_caps(run_id, kind, cap) VALUES (?,?,?)
       ON CONFLICT(run_id, kind) DO UPDATE SET cap = excluded.cap`,
    ).run(run_id, kind, cap);
    this.audit.record("governance.cap.set", env, { run_id, kind, cap });
  }

  private getCap(run_id: string, kind: "budget" | CeilingKind): number {
    const row = this.sql.db.prepare(
      `SELECT cap FROM governance_caps WHERE run_id = ? AND kind = ?`,
    ).get(run_id, kind) as { cap: number } | undefined;
    if (row) return row.cap;
    switch (kind) {
      case "budget": return DEFAULTS.budget_cap_usd;
      case "iteration": return DEFAULTS.iteration_cap;
      case "depth": return DEFAULTS.depth_cap;
      case "failure": return DEFAULTS.failure_cap;
    }
  }

  budgetCharge(env: Envelope, run_id: string, cost_usd: number, tokens?: number): BudgetChargeResult {
    const cap = this.getCap(run_id, "budget");
    const prior = this.sql.db.prepare(
      `SELECT COALESCE(SUM(delta), 0) AS spent FROM governance_ledger WHERE run_id = ? AND kind = 'budget'`,
    ).get(run_id) as { spent: number };
    const spent = prior.spent + cost_usd;
    const fraction = spent / cap;
    let action: BudgetAction = "proceed";
    let reason = "ok";
    if (fraction >= 1) { action = "block"; reason = "cap exceeded"; }
    else if (fraction >= DEFAULTS.downgrade_fraction) { action = "downgrade"; reason = "80% threshold — downgrade model tier"; }
    const at = new Date().toISOString();
    this.sql.db.prepare(
      `INSERT INTO governance_ledger(run_id, kind, delta, total, cap, action, at, actor_id, trace_id, meta_json)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(run_id, "budget", cost_usd, spent, cap, action, at, env.actor_id, env.trace_id, JSON.stringify({ tokens }));
    this.audit.record("governance.budget.charge", env, { run_id, cost_usd, spent, cap, fraction, action });
    return { run_id, spent, cap, remaining: Math.max(0, cap - spent), fraction, action, reason };
  }

  ceilingTick(env: Envelope, run_id: string, kind: CeilingKind, delta = 1): CeilingTickResult {
    const cap = this.getCap(run_id, kind);
    const prior = this.sql.db.prepare(
      `SELECT COALESCE(SUM(delta), 0) AS total FROM governance_ledger WHERE run_id = ? AND kind = ?`,
    ).get(run_id, kind) as { total: number };
    const count = prior.total + delta;
    let action: CeilingAction = "proceed";
    let reason = "ok";
    if (count >= cap) {
      action = kind === "failure" ? "trip" : "block";
      reason = `${kind} cap (${cap}) reached`;
    } else if (count >= cap * 0.8) {
      action = "warn";
      reason = `${kind} at 80% of cap`;
    }
    const at = new Date().toISOString();
    this.sql.db.prepare(
      `INSERT INTO governance_ledger(run_id, kind, delta, total, cap, action, at, actor_id, trace_id, meta_json)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(run_id, kind, delta, count, cap, action, at, env.actor_id, env.trace_id, "{}");
    this.audit.record(`governance.ceiling.${kind}`, env, { run_id, count, cap, action });
    return { run_id, kind, count, cap, action, reason };
  }

  // ---------- HITL queue ----------

  hitlRequest(env: Envelope, input: { run_id?: string; kind: string; payload: unknown }): HitlRequestRow {
    const request_id = `hitl_${nanoid()}`;
    const requested_at = new Date().toISOString();
    this.sql.db.prepare(
      `INSERT INTO hitl_queue(request_id, run_id, kind, payload_json, status, requested_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(request_id, input.run_id ?? null, input.kind, JSON.stringify(input.payload), "pending", requested_at);
    this.audit.record("governance.hitl.request", env, { request_id, run_id: input.run_id, kind: input.kind });
    return { request_id, run_id: input.run_id ?? null, kind: input.kind, payload: input.payload, status: "pending", requested_at };
  }

  hitlResolve(env: Envelope, request_id: string, decision: "approved" | "rejected", note?: unknown): HitlRequestRow {
    // Fetch the HITL row first so we can use its run_id as workflow_id in the capability binding.
    const existing = this.sql.db.prepare(
      `SELECT run_id FROM hitl_queue WHERE request_id = ?`,
    ).get(request_id) as { run_id: string | null } | undefined;
    const workflowId = existing?.run_id ?? request_id;
    // Enforce operator capability — fail closed: no valid token means no resolution.
    this.requireOperatorCapability(env, "hitl.resolve", request_id, workflowId, "hitlResolve");
    const resolved_at = new Date().toISOString();
    this.sql.db.prepare(
      `UPDATE hitl_queue SET status = ?, resolved_at = ?, resolved_by = ?, decision_json = ?
       WHERE request_id = ? AND status = 'pending'`,
    ).run(decision, resolved_at, env.actor_id, JSON.stringify({ note }), request_id);
    this.audit.record("governance.hitl.resolve", env, { request_id, decision });
    return this.hitlGet(request_id);
  }

  hitlList(env: Envelope, status: HitlRequestRow["status"] = "pending"): HitlRequestRow[] {
    const rows = this.sql.db.prepare(
      `SELECT * FROM hitl_queue WHERE status = ? ORDER BY requested_at ASC`,
    ).all(status) as Array<{ request_id: string; run_id: string | null; kind: string; payload_json: string; status: HitlRequestRow["status"]; requested_at: string; resolved_at: string | null; resolved_by: string | null; decision_json: string | null }>;
    this.audit.record("governance.hitl.list", env, { status, count: rows.length });
    return rows.map(rowToHitl);
  }

  hitlGet(request_id: string): HitlRequestRow {
    const row = this.sql.db.prepare(
      `SELECT * FROM hitl_queue WHERE request_id = ?`,
    ).get(request_id) as { request_id: string; run_id: string | null; kind: string; payload_json: string; status: HitlRequestRow["status"]; requested_at: string; resolved_at: string | null; resolved_by: string | null; decision_json: string | null } | undefined;
    if (!row) throw new Error(`unknown hitl request ${request_id}`);
    return rowToHitl(row);
  }

  // ---------- Circuit breaker ----------

  breakerStatus(node_id: string): BreakerStatus {
    const row = this.sql.db.prepare(
      `SELECT consecutive_failures, tripped, tripped_at, last_failure_at FROM breaker_state WHERE node_id = ?`,
    ).get(node_id) as { consecutive_failures: number; tripped: number; tripped_at: string | null; last_failure_at: string | null } | undefined;
    if (!row) return { node_id, consecutive_failures: 0, tripped: false };
    return {
      node_id,
      consecutive_failures: row.consecutive_failures,
      tripped: row.tripped === 1,
      tripped_at: row.tripped_at ?? undefined,
      last_failure_at: row.last_failure_at ?? undefined,
    };
  }

  breakerOutcome(env: Envelope, node_id: string, outcome: "success" | "failure"): BreakerStatus {
    const now = new Date().toISOString();
    if (outcome === "success") {
      // If the breaker is currently tripped, a "success" outcome would clear it.
      // Capability check + clear are wrapped in a single transaction to prevent a
      // TOCTOU race where a concurrent trip could be cleared without a fresh token
      // (Fix #1 atomic: the check and the conditional clear are one unit of work).
      const status = this.sql.db.transaction(() => {
        const current = this.breakerStatus(node_id);
        if (current.tripped) {
          // requireOperatorCapability throws on failure, rolling back the transaction.
          this.requireOperatorCapability(env, "governance.breaker.reset", node_id, node_id, "breakerOutcome(success/untrip)");
        }
        this.sql.db.prepare(
          `INSERT INTO breaker_state(node_id, consecutive_failures, tripped) VALUES (?, 0, 0)
           ON CONFLICT(node_id) DO UPDATE SET consecutive_failures = 0, tripped = 0, tripped_at = NULL`,
        ).run(node_id);
        return this.breakerStatus(node_id);
      })();
      this.audit.record("governance.breaker.success", env, { node_id });
      return status;
    }
    const status = this.breakerStatus(node_id);
    const next = status.consecutive_failures + 1;
    const tripped = next >= DEFAULTS.failure_cap;
    this.sql.db.prepare(
      `INSERT INTO breaker_state(node_id, consecutive_failures, tripped, tripped_at, last_failure_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(node_id) DO UPDATE SET
         consecutive_failures = excluded.consecutive_failures,
         tripped = excluded.tripped,
         tripped_at = CASE WHEN excluded.tripped = 1 AND breaker_state.tripped = 0 THEN excluded.tripped_at ELSE breaker_state.tripped_at END,
         last_failure_at = excluded.last_failure_at`,
    ).run(node_id, next, tripped ? 1 : 0, tripped ? now : null, now);
    this.audit.record(tripped ? "governance.breaker.trip" : "governance.breaker.failure", env, { node_id, consecutive_failures: next });
    return this.breakerStatus(node_id);
  }

  breakerReset(env: Envelope, node_id: string): BreakerStatus {
    // Enforce operator capability — node_id is the resource; use node_id as workflow_id too
    // (breaker resets are node-scoped, not workflow-scoped).
    this.requireOperatorCapability(env, "governance.breaker.reset", node_id, node_id, "breakerReset");
    this.sql.db.prepare(
      `INSERT INTO breaker_state(node_id, consecutive_failures, tripped) VALUES (?, 0, 0)
       ON CONFLICT(node_id) DO UPDATE SET consecutive_failures = 0, tripped = 0, tripped_at = NULL`,
    ).run(node_id);
    this.audit.record("governance.breaker.reset", env, { node_id });
    return this.breakerStatus(node_id);
  }
}

function rowToHitl(row: { request_id: string; run_id: string | null; kind: string; payload_json: string; status: HitlRequestRow["status"]; requested_at: string; resolved_at: string | null; resolved_by: string | null; decision_json: string | null }): HitlRequestRow {
  return {
    request_id: row.request_id,
    run_id: row.run_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as unknown,
    status: row.status,
    requested_at: row.requested_at,
    resolved_at: row.resolved_at ?? undefined,
    resolved_by: row.resolved_by ?? undefined,
    decision: row.decision_json ? JSON.parse(row.decision_json) as unknown : undefined,
  };
}
