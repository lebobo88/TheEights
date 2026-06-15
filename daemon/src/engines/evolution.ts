/**
 * EvolutionEngine — Autogenesis-aligned RSPL + SEPL.
 *
 * RSPL (Resource Substrate): versioned, content-addressed resource registry
 * on disk under ~/.eights/resources/<sanitized-rid>/<version>.{content,sig}.
 *
 * SEPL (Self-Evolution Protocol): propose → evaluate → commit | queue-for-HITL
 * → approve/reject → rollback. Risk-class routing per ADR-0006.
 *
 * Phase 5: resources may carry source_paths that mirror the canonical content
 * back into a consumer's filesystem. On commit, a WriteRouter dispatches to
 * the matching WriteBridge per ADR-0007.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SqliteStore } from "../stores/sqlite.js";
import type { PolicyEngine } from "./policy.js";
import type { AuditEngine } from "./audit.js";
import type { WriteRouter, WriteResult } from "./writeback.js";
import type { GovernanceStateEngine } from "./governance-state.js";
import type { Envelope } from "../schemas/envelope.js";
import { verifyOperatorCapability } from "../auth/capability.js";
import type {
  Resource, ResourceKind, RiskClass, EvolutionPolicy, Consumer, WritebackMode, ResourceSource,
} from "../schemas/resource.js";
import { DEFAULT_EVOLUTION_POLICY } from "../schemas/resource.js";
import type { Proposal, ProposalStatus, EvaluationReport } from "../schemas/proposal.js";

// ---------- WS10: Pagination types ----------

/**
 * Generic paginated result envelope.
 * All MCP boundary list tools return this shape (WS10).
 */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

/** Pagination options used by the *Page methods. */
export interface PaginationOpts {
  limit?: number;
  offset?: number;
}

// ---------- WS10: ReconcileDrift types ----------

export type ReconcileDriftAction = "propose" | "surface" | "skip";

export interface ReconcilePlanEntry {
  rid: string;
  drift_kind: "source" | "registry";
  action: ReconcileDriftAction;
  reason: string;
  proposal_id?: string;
}

export interface ReconcileDriftOpts {
  /** Scope to a single resource id. */
  rid?: string;
  /**
   * When true (THE DEFAULT — if undefined, treated as true), only plans actions
   * without mutating state. Set explicitly to false to create proposals.
   */
  dryRun?: boolean;
  limit?: number;
  offset?: number;
}

export interface ReconcileDriftResult {
  planned: ReconcilePlanEntry[];
  /** Number of drift entries returned in this page (== planned.length). */
  total_drifts: number;
  /** Total resources scanned (for pagination context). */
  total_resources: number;
  applied: boolean;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface ProposeInput {
  rid: string;
  candidate_content: string;
  justification: string;
  evidence_memory_ids?: string[];
}

export interface RegisterResourceInput {
  rid: string;
  kind: ResourceKind;
  risk_class: RiskClass;
  evolution_policy?: EvolutionPolicy;
  initial_content: string;
  audit_url?: string;
  consumer?: Consumer;
  source_paths?: string[];
  writeback_mode?: WritebackMode;
}

export interface EvaluatorAdapter {
  evaluate(input: {
    rid: string;
    kind: ResourceKind;
    consumer: Consumer;
    risk_class: RiskClass;
    justification: string;
    current_content: string;
    candidate_content: string;
  }): Promise<{ eval_delta: number; metric_scores: Record<string, number>; notes: string; evaluator_missing?: boolean }>;
}

const CRITICAL_AUDIT_URL = "graph://resources/critical";

export class EvolutionEngine {
  private writeRouter: WriteRouter | null = null;
  private evaluator: EvaluatorAdapter | null = null;
  private governance: GovernanceStateEngine | null = null;

  constructor(
    private readonly sql: SqliteStore,
    private readonly resourcesDir: string,
    private readonly policy: PolicyEngine,
    private readonly audit: AuditEngine,
  ) {
    mkdirSync(this.resourcesDir, { recursive: true });
  }

  setWriteRouter(router: WriteRouter): void { this.writeRouter = router; }
  setEvaluator(ev: EvaluatorAdapter): void { this.evaluator = ev; }
  /** Inject GovernanceStateEngine so the evolution engine can create and verify
   *  HITL rows for hitl-only proposals (TE-EV-1). Must be called before any
   *  hitl-only commit/approve path is exercised. */
  setGovernance(gov: GovernanceStateEngine): void { this.governance = gov; }

  /**
   * Enforce operator capability on an operator-only evolution op.
   *
   * Checks (in order):
   *   1. capability_token present in envelope
   *   2. token verifies (HMAC, schema, expiry, TTL, field checks)
   *   3. token.actor_id === env.actor_id (bind token actor to envelope actor)
   *   4. token.actor_id registered in actors table with kind='human'
   *   5. single-use: sig.value (jti) not already consumed (replay prevention)
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
      this.audit.record("evolution.auth.rejected", env, { op: opLabel, reason: "missing capability_token" });
      throw new Error(`${opLabel} requires an operator capability token (capability_token missing in envelope)`);
    }
    const result = verifyOperatorCapability(token, {
      expectedCapability: capability,
      expectedWorkflowId: workflowId,
      expectedResourceId: resourceId,
    });
    if (!result.valid) {
      this.audit.record("evolution.auth.rejected", env, { op: opLabel, reason: result.reason });
      throw new Error(`${opLabel} refused: capability token invalid (${result.reason})`);
    }
    // Token actor MUST equal envelope's claimed actor (Fix #2).
    if (result.actor_id !== env.actor_id) {
      this.audit.record("evolution.auth.rejected", env, { op: opLabel, reason: "actor_id mismatch" });
      throw new Error(`${opLabel} refused: token actor_id does not match envelope actor_id`);
    }
    const actorId = result.actor_id;
    // actors-table binding.
    const actorRow = this.sql.db.prepare(
      `SELECT kind FROM actors WHERE actor_id = ?`,
    ).get(actorId) as { kind: string } | undefined;
    if (!actorRow) {
      this.audit.record("evolution.auth.rejected", env, { op: opLabel, reason: "actor not registered" });
      throw new Error(`${opLabel} refused: token actor_id is not registered in actors table`);
    }
    if (actorRow.kind !== "human") {
      this.audit.record("evolution.auth.rejected", env, { op: opLabel, reason: "actor_kind not human" });
      throw new Error(`${opLabel} refused: token actor must have kind=human in actors table`);
    }
    // Single-use: use the jti returned by the VERIFIER (from the normalized, HMAC-verified
    // payload) — NOT a re-extraction from the raw token (Fix 6.3).
    const jti = result.jti;
    if (!jti) {
      this.audit.record("evolution.auth.rejected", env, { op: opLabel, reason: "jti unavailable from verifier" });
      throw new Error(`${opLabel} refused: capability token jti unavailable`);
    }
    const consumed_at = new Date().toISOString();
    const inserted = this.sql.db.prepare(
      `INSERT OR IGNORE INTO consumed_capabilities(jti, consumed_at, op) VALUES (?,?,?)`,
    ).run(jti, consumed_at, opLabel);
    if (inserted.changes === 0) {
      this.audit.record("evolution.auth.rejected", env, { op: opLabel, reason: "token already consumed (replay)" });
      throw new Error(`${opLabel} refused: capability token has already been used (replay prevented)`);
    }
    this.audit.record("evolution.auth.accepted", env, { op: opLabel, actor_id: actorId, capability });
  }

  // ---------- RSPL ----------

  register(env: Envelope, input: RegisterResourceInput): Resource {
    const existing = this.getResource(input.rid);
    if (existing) {
      // FIX 3: on the existing-resource path, use the STORED risk_class as the
      // authoritative severity — a caller must not re-register a critical resource
      // as "low" to weaken governance. Also reject any attempt to DOWNGRADE
      // risk_class (defined as moving to a less severe class).
      const SEVERITY: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
      const storedSeverity = SEVERITY[existing.risk_class] ?? -1;
      const requestedSeverity = SEVERITY[input.risk_class] ?? -1;
      if (requestedSeverity < storedSeverity) {
        const reason = `cannot downgrade risk_class from '${existing.risk_class}' to '${input.risk_class}'`;
        this.audit.record("evolution.register.rejected", env, { rid: input.rid, reason });
        throw new Error(reason);
      }
      // Use the stored (or upgraded) risk_class for compat check, never the
      // caller-supplied lower value. If caller supplies a higher risk_class
      // (upgrade), accept the upgrade and re-check compat with the upgraded class.
      const effective_risk = requestedSeverity >= storedSeverity ? input.risk_class : existing.risk_class;
      const effective_policy = input.evolution_policy ?? existing.evolution_policy;
      // TE-EV-3 (#3b): run compat check on the existing-resource path too. A
      // stored critical+auto combo from before the fix must be caught on re-register
      // so it can't persist / evade the policy gate.
      validateRiskPolicyCompat(effective_risk, effective_policy);
      // FIX 3: persist the upgrade when effective_risk is more severe than stored.
      // Without this the stored row stays at the old risk_class and the upgrade
      // only existed transiently, allowing a subsequent re-register to pass
      // downgrade-check against the original (stale) stored severity.
      if (effective_risk !== existing.risk_class || effective_policy !== existing.evolution_policy) {
        this.sql.db.prepare(
          `UPDATE resources SET risk_class = ?, evolution_policy = ?, updated_at = datetime('now') WHERE rid = ?`,
        ).run(effective_risk, effective_policy, input.rid);
        this.audit.record("evolution.register.upgraded", env, {
          rid: input.rid,
          prior_risk_class: existing.risk_class,
          new_risk_class: effective_risk,
          prior_policy: existing.evolution_policy,
          new_policy: effective_policy,
        });
      }
      // Idempotent: attach any new source paths.
      if (input.source_paths?.length) {
        for (const p of input.source_paths) {
          this.upsertSource(input.rid, p, input.consumer ?? "eights", input.writeback_mode ?? "in-place+branch");
        }
      }
      return this.getResource(input.rid)!;
    }
    const evolution_policy = input.evolution_policy ?? DEFAULT_EVOLUTION_POLICY[input.risk_class];
    // TE-EV-3: enforce risk/policy compatibility. critical must be frozen;
    // high/medium may be at most hitl-only (not auto); only low may be auto.
    validateRiskPolicyCompat(input.risk_class, evolution_policy);
    const version = contentHash(input.initial_content);
    const now = new Date().toISOString();
    const audit_url = input.audit_url ?? `graph://resources/${input.rid}`;
    const consumer = input.consumer ?? "eights";
    this.sql.db.prepare(
      `INSERT INTO resources(rid, kind, risk_class, current_version, evolution_policy, audit_url, consumer, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(input.rid, input.kind, input.risk_class, version, evolution_policy, audit_url, consumer, now, now);
    this.writeVersion(input.rid, version, input.initial_content, "system:seed", "initial seed");
    if (input.source_paths) {
      for (const p of input.source_paths) {
        this.upsertSource(input.rid, p, consumer, input.writeback_mode ?? "in-place+branch");
      }
    }
    this.audit.record("evolution.register", env, {
      rid: input.rid, kind: input.kind, risk_class: input.risk_class, consumer, sources: input.source_paths ?? [],
    });
    return this.getResource(input.rid)!;
  }

  private upsertSource(rid: string, source_path: string, consumer: Consumer, mode: WritebackMode): void {
    this.sql.db.prepare(
      `INSERT INTO resource_sources(rid, source_path, consumer, writeback_mode)
       VALUES (?,?,?,?)
       ON CONFLICT(rid, source_path) DO UPDATE SET consumer=excluded.consumer, writeback_mode=excluded.writeback_mode`,
    ).run(rid, source_path, consumer, mode);
  }

  /**
   * Look up a resource by rid.
   * Internal callers omit `env`; the MCP boundary always passes it so the read is audited.
   * This keeps the signature backwards-compatible: all internal `getResource(rid)` calls
   * continue to work unchanged while the MCP handler gets a mandatory audit trail.
   */
  getResource(rid: string, env?: Envelope): Resource | null {
    const row = this.sql.db.prepare("SELECT * FROM resources WHERE rid = ?").get(rid) as
      | { rid: string; kind: string; risk_class: string; current_version: string; evolution_policy: string; audit_url: string; consumer: string }
      | undefined;
    if (!row) {
      if (env) this.audit.record("evolution.read", env, { op: "get_resource", rid, found: false });
      return null;
    }
    const versions = this.sql.db
      .prepare("SELECT * FROM resource_versions WHERE rid = ? ORDER BY created_at ASC")
      .all(rid) as Array<{ rid: string; version: string; content: string; signature: string; created_at: string; created_by: string; justification: string | null; evidence_memory_ids_json: string }>;
    const sources = this.sql.db
      .prepare("SELECT * FROM resource_sources WHERE rid = ?")
      .all(rid) as Array<{ source_path: string; consumer: string; writeback_mode: string; last_written_version: string | null; last_written_at: string | null }>;
    const resource: Resource = {
      rid: row.rid,
      kind: row.kind as ResourceKind,
      risk_class: row.risk_class as RiskClass,
      current_version: row.current_version,
      evolution_policy: row.evolution_policy as EvolutionPolicy,
      audit_url: row.audit_url,
      consumer: (row.consumer ?? "eights") as Consumer,
      versions: versions.map((v) => ({
        version: v.version,
        content: v.content,
        signature: v.signature,
        created_at: v.created_at,
        created_by: v.created_by,
        justification: v.justification ?? undefined,
        evidence_memory_ids: JSON.parse(v.evidence_memory_ids_json) as string[],
      })),
      sources: sources.map((s) => ({
        source_path: s.source_path,
        consumer: s.consumer as Consumer,
        writeback_mode: s.writeback_mode as WritebackMode,
        last_written_version: s.last_written_version ?? undefined,
        last_written_at: s.last_written_at ?? undefined,
      })),
    };
    if (env) this.audit.record("evolution.read", env, { op: "get_resource", rid, found: true });
    return resource;
  }

  listResources(filter: { consumer?: Consumer; kind?: ResourceKind; risk?: RiskClass } = {}): Resource[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.consumer) { where.push("consumer = ?"); params.push(filter.consumer); }
    if (filter.kind) { where.push("kind = ?"); params.push(filter.kind); }
    if (filter.risk) { where.push("risk_class = ?"); params.push(filter.risk); }
    const sql = `SELECT rid FROM resources ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY rid`;
    const rows = this.sql.db.prepare(sql).all(...params) as Array<{ rid: string }>;
    return rows.map((r) => this.getResource(r.rid)!).filter(Boolean);
  }

  /**
   * WS10: Paginated version of listResources.
   * Uses SQL LIMIT/OFFSET + a separate COUNT(*) — does NOT load all rows then slice.
   * Intended for MCP boundary calls where unbounded results are forbidden.
   * FIX 1b: accepts optional envelope; when present, emits an "evolution.read" audit event.
   */
  listResourcesPage(
    filter: { consumer?: Consumer; kind?: ResourceKind; risk?: RiskClass } = {},
    opts: PaginationOpts = {},
    env?: Envelope,
  ): Page<Resource> {
    const { limit, offset } = clampPage(opts);
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.consumer) { where.push("consumer = ?"); params.push(filter.consumer); }
    if (filter.kind) { where.push("kind = ?"); params.push(filter.kind); }
    if (filter.risk) { where.push("risk_class = ?"); params.push(filter.risk); }
    const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";
    const countRow = this.sql.db
      .prepare(`SELECT COUNT(*) as n FROM resources ${whereClause}`)
      .get(...params) as { n: number };
    const total = countRow.n;
    const rows = this.sql.db
      .prepare(`SELECT rid FROM resources ${whereClause} ORDER BY rid LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<{ rid: string }>;
    const items = rows.map((r) => this.getResource(r.rid)!).filter(Boolean);
    if (env) this.audit.record("evolution.read", env, { op: "list_resources", limit, offset, total });
    return { items, total, limit, offset, has_more: offset + items.length < total };
  }

  readVersion(rid: string, version: string): string | null {
    const path = this.versionPath(rid, version);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  }

  // ---------- SEPL ----------

  propose(env: Envelope, input: ProposeInput): Proposal {
    // FIX 1a (Round 3): write-authz gate — validate actor_id against the actors table.
    // Empty / missing actor_id is rejected before the DB lookup (fast-fail).
    // Any actor_id not present in the actors table is rejected.
    // This blocks reconcileDrift (and any other caller) from bulk-creating proposals
    // with an anonymous or unregistered envelope.
    if (!env.actor_id || env.actor_id.trim() === "") {
      this.audit.record("evolution.propose.rejected", env, { rid: input.rid, reason: "empty actor_id" });
      throw new Error(`propose: anonymous or empty actor_id is not permitted (got '${env.actor_id}')`);
    }
    const actorRow = this.sql.db.prepare(
      `SELECT kind FROM actors WHERE actor_id = ?`,
    ).get(env.actor_id) as { kind: string } | undefined;
    if (!actorRow) {
      this.audit.record("evolution.propose.rejected", env, { rid: input.rid, reason: "actor not registered" });
      throw new Error(`propose: actor '${env.actor_id}' is not registered in the actors table — register it first`);
    }

    const resource = this.getResource(input.rid);
    if (!resource) throw new Error(`unknown resource ${input.rid}`);

    // FIX 1a: critical resources are never proposable (they must be frozen per
    // validateRiskPolicyCompat, but a direct-SQL insertion could bypass that).
    // Belt-and-suspenders check here inside propose() itself.
    // NOTE: error message includes "frozen" so existing tests matching /frozen/ still pass.
    if (resource.risk_class === "critical") {
      this.audit.record("evolution.propose.rejected", env, { rid: input.rid, reason: "critical resource — frozen by governance" });
      throw new Error(`resource ${input.rid} is frozen/critical — proposals require operator unfreeze first`);
    }
    if (resource.evolution_policy === "frozen") {
      this.audit.record("evolution.propose.rejected", env, { rid: input.rid, reason: "frozen" });
      throw new Error(`resource ${input.rid} is frozen — cannot evolve`);
    }

    const candidate_version = contentHash(input.candidate_content);
    const proposal_id = `prop_${randomUUID()}`;
    const now = new Date().toISOString();

    try {
      this.sql.db.prepare(
        `INSERT INTO proposals(proposal_id, resource_rid, candidate_version, candidate_content, justification, evidence_memory_ids_json, proposed_by, proposed_at, status)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        proposal_id, input.rid, candidate_version, input.candidate_content,
        input.justification, JSON.stringify(input.evidence_memory_ids ?? []),
        env.actor_id, now, "pending" satisfies ProposalStatus,
      );
    } catch (err) {
      // FIX 5: The UNIQUE partial index on (resource_rid) WHERE status IN
      // ('pending','evaluating') fires when a second active proposal is attempted
      // for the same resource. Convert to a typed, catchable error so reconcileDrift
      // (and other callers) can handle it cleanly with action="skip".
      if (
        err instanceof Error &&
        (
          (err as NodeJS.ErrnoException & { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" ||
          err.message.includes("UNIQUE constraint failed") ||
          err.message.includes("idx_proposals_active_per_resource")
        )
      ) {
        const typed = Object.assign(
          new Error(`propose: resource '${input.rid}' already has an active pending or evaluating proposal — reject it before creating a new one`),
          { code: "PROPOSAL_ALREADY_PENDING" as const },
        );
        this.audit.record("evolution.propose.rejected", env, { rid: input.rid, reason: "PROPOSAL_ALREADY_PENDING" });
        throw typed;
      }
      throw err;
    }

    this.audit.record("evolution.propose", env, { proposal_id, rid: input.rid, candidate_version });
    return this.getProposal(proposal_id)!;
  }

  /**
   * Run the eval adapter for this proposal, falling back to a delta=0 stub if
   * no adapter is registered. The full per-kind dispatch lives in eval/registry.ts.
   */
  async evaluate(env: Envelope, proposal_id: string): Promise<EvaluationReport> {
    const proposal = this.getProposal(proposal_id);
    if (!proposal) throw new Error(`unknown proposal ${proposal_id}`);
    const resource = this.getResource(proposal.resource_rid);
    if (!resource) throw new Error(`unknown resource ${proposal.resource_rid}`);
    this.setStatus(proposal_id, "evaluating");

    // TE-EV-2: default to fail-closed. evaluator_missing is only cleared when
    // the evaluator runs successfully AND does not report it missing. This means
    // a throwing evaluator, an absent/un-injected evaluator, and a registry with
    // no matching adapter all leave evaluator_missing:true -> commit/approve block.
    let eval_delta = -1;
    let metric_scores: Record<string, number> = {};
    let notes = "no evaluator registered — blocked (evaluator_missing)";
    let evaluator_missing: boolean = true;

    if (this.evaluator) {
      try {
        const current = this.readVersion(resource.rid, resource.current_version) ?? "";
        const r = await this.evaluator.evaluate({
          rid: resource.rid,
          kind: resource.kind,
          consumer: resource.consumer,
          risk_class: resource.risk_class,
          justification: proposal.justification,
          current_content: current,
          candidate_content: proposal.candidate_content,
        });
        // Only clear evaluator_missing when the adapter ran, did NOT signal it,
        // AND returned a finite numeric delta. A NaN/Infinity/non-number delta
        // serialises to null in JSON and `null < 0` is false — it would silently
        // pass the delta gate and allow an auto-commit on a broken evaluation.
        // Always capture metric_scores from the adapter (useful for diagnostics
        // even when the evaluation fails the finite-delta gate).
        metric_scores = r.metric_scores;
        if (!r.evaluator_missing) {
          if (typeof r.eval_delta === "number" && Number.isFinite(r.eval_delta)) {
            evaluator_missing = false;
            eval_delta = r.eval_delta;
            notes = r.notes;
          } else {
            // Adapter returned a non-finite delta — treat as evaluator failure.
            // Do NOT copy r.notes here; our diagnostic message is the gate note.
            eval_delta = -1;
            notes = `evaluator returned non-finite delta (${String(r.eval_delta)}) — blocked (evaluator_missing)`;
            // evaluator_missing stays true
          }
        } else {
          // Registry found no adapter — keep evaluator_missing:true, delta stays -1.
          eval_delta = -1;
          notes = r.notes;
        }
      } catch (err) {
        // Throwing evaluator: keep evaluator_missing:true, delta:-1.
        notes = `evaluator threw: ${err instanceof Error ? err.message : String(err)} — blocked (evaluator_missing)`;
      }
    }

    // FIX 4: SSGM gates are not implemented — do NOT claim passed:true for checks
    // that never run. Use enforced:false and omit passed. These gates are currently
    // advisory/reported only (no code in commit/approve reads .passed to block);
    // if they were required gates and not implemented they would need to fail closed.
    // As-is: purely advisory. Honest representation = enforced:false, no passed claim.
    const ssgm = {
      consistency: { enforced: false, conflicts: [] as string[] },
      temporal_decay: { enforced: false, reason: undefined as string | undefined },
      access_control: { enforced: false, reason: undefined as string | undefined },
    };
    const report: EvaluationReport = { proposal_id, eval_delta, metric_scores, ssgm_gate_results: ssgm, notes, evaluator_missing };
    this.sql.db.prepare(`UPDATE proposals SET evaluation_json = ? WHERE proposal_id = ?`).run(JSON.stringify(report), proposal_id);
    this.audit.record("evolution.evaluate", env, { proposal_id, eval_delta, kind: resource.kind, consumer: resource.consumer });
    return report;
  }

  async commit(env: Envelope, proposal_id: string): Promise<{ committed: boolean; reason: string; version?: string; writeback?: WriteResult[] }> {
    const proposal = this.getProposal(proposal_id);
    if (!proposal) throw new Error(`unknown proposal ${proposal_id}`);
    const resource = this.getResource(proposal.resource_rid);
    if (!resource) throw new Error(`unknown resource ${proposal.resource_rid}`);

    // TE-EV-3 (#3a): enumerate ALL EvolutionPolicy values explicitly.
    // Only "auto" on a low-risk resource may auto-commit.
    // "auto-low-risk" may auto-commit ONLY when risk_class is actually low.
    // "frozen" and "hitl-only" are handled below.
    // Any other / unknown value fails closed.
    const policy = resource.evolution_policy;

    if (policy === "frozen") {
      this.setStatus(proposal_id, "rejected", env.actor_id);
      this.audit.record("evolution.commit.rejected", env, { proposal_id, reason: "frozen" });
      return { committed: false, reason: "resource is frozen" };
    }
    if (policy === "hitl-only") {
      // TE-EV-1: idempotently create a HITL queue row so that approve() can
      // verify a human resolved it. Only insert if no pending/approved row
      // already exists for this proposal_id.
      if (this.governance) {
        const existing = this.sql.db.prepare(
          `SELECT request_id FROM hitl_queue
           WHERE kind = 'evolution.approve'
             AND json_extract(payload_json, '$.proposal_id') = ?
             AND status IN ('pending', 'approved')
           LIMIT 1`,
        ).get(proposal_id) as { request_id: string } | undefined;
        if (!existing) {
          this.governance.hitlRequest(env, {
            kind: "evolution.approve",
            payload: { proposal_id, rid: resource.rid },
          });
        }
      }
      this.audit.record("evolution.commit.queued", env, { proposal_id });
      return { committed: false, reason: "hitl-only — call approve() to commit" };
    }
    if (policy === "auto" && resource.risk_class !== "low") {
      // FIX 2: plain "auto" may only auto-commit when risk_class=low.
      // Any higher risk class must use hitl-only (or frozen for critical).
      this.audit.record("evolution.commit.rejected", env, { proposal_id, reason: "auto policy on non-low risk_class" });
      return { committed: false, reason: "auto policy requires risk_class=low — blocked; update policy to hitl-only or fix risk_class" };
    }
    if (policy === "auto-low-risk" && resource.risk_class !== "low") {
      // auto-low-risk on a non-low resource is a misconfiguration — fail closed
      // and route to HITL so a human can resolve the policy mismatch.
      this.audit.record("evolution.commit.rejected", env, { proposal_id, reason: "auto-low-risk policy on non-low risk_class" });
      return { committed: false, reason: "auto-low-risk policy requires risk_class=low — blocked; update policy to hitl-only or fix risk_class" };
    }
    if (policy !== "auto" && policy !== "auto-low-risk") {
      // Unknown / unrecognised policy value — fail closed.
      this.setStatus(proposal_id, "rejected", env.actor_id);
      this.audit.record("evolution.commit.rejected", env, { proposal_id, reason: `unknown policy: ${policy}` });
      return { committed: false, reason: `unknown evolution_policy '${policy}' — commit rejected (fail-closed)` };
    }
    // policy === "auto" with risk_class=low, OR policy === "auto-low-risk" with risk_class=low:
    // fall through to eval checks.
    const evalReport = proposal.evaluation;
    if (!evalReport) return { committed: false, reason: "must evaluate before commit" };
    // TE-EV-2: require evaluator_missing===false AND a finite non-negative delta.
    // isCommittableDelta() is the single authoritative gate — it rejects null/NaN/
    // Infinity/undefined deltas that would otherwise pass a bare `< 0` check
    // (null < 0 is false in JS; NaN < 0 is false). Legacy/persisted reports with
    // a malformed eval_delta are blocked here regardless of evaluator_missing value.
    if (!isCommittableDelta(evalReport)) {
      this.setStatus(proposal_id, "rejected", env.actor_id);
      const reason = evalReport.evaluator_missing !== false
        ? "evaluator_missing"
        : `eval_delta not committable (got ${String(evalReport.eval_delta)}) — blocked`;
      this.audit.record("evolution.commit.rejected", env, { proposal_id, reason });
      return { committed: false, reason: reason === "evaluator_missing"
        ? "no evaluator registered — auto/commit blocked (evaluator_missing)"
        : `eval_delta must be a finite number >= 0, got ${String(evalReport.eval_delta)} — proposal rejected` };
    }
    return this.performCommit(env, proposal_id);
  }

  async approve(env: Envelope, proposal_id: string): Promise<{ committed: boolean; reason: string; version?: string; writeback?: WriteResult[] }> {
    // Enforce operator capability — bound to this specific proposal_id.
    this.requireOperatorCapability(env, "evolution.approve", proposal_id, proposal_id, "approve");
    const proposal = this.getProposal(proposal_id);
    if (!proposal) throw new Error(`unknown proposal ${proposal_id}`);
    const resource = this.getResource(proposal.resource_rid);
    if (resource?.evolution_policy === "frozen") {
      throw new Error("frozen resources cannot be approved without explicit unfreeze");
    }

    // TE-EV-1: require a human-approved HITL row for hitl-only proposals.
    if (resource?.evolution_policy === "hitl-only") {
      const approvedRow = this.sql.db.prepare(
        `SELECT request_id FROM hitl_queue
         WHERE kind = 'evolution.approve'
           AND json_extract(payload_json, '$.proposal_id') = ?
           AND status = 'approved'
         LIMIT 1`,
      ).get(proposal_id) as { request_id: string } | undefined;
      if (!approvedRow) {
        this.audit.record("evolution.approve.rejected", env, { proposal_id, reason: "no_approved_hitl" });
        return { committed: false, reason: "approve() requires a human-approved HITL request for this proposal" };
      }
    }

    // TE-EV-1 + TE-EV-2: require valid evaluation — same isCommittableDelta gate
    // as commit(). Null/NaN/Infinity/undefined eval_delta values that slip through
    // JSON.parse of a persisted report must be rejected here too.
    const evalReport = proposal.evaluation;
    if (!evalReport) {
      return { committed: false, reason: "must evaluate before approve" };
    }
    if (!isCommittableDelta(evalReport)) {
      const reason = evalReport.evaluator_missing !== false
        ? "evaluator_missing"
        : `eval_delta not committable (got ${String(evalReport.eval_delta)}) — blocked`;
      this.audit.record("evolution.approve.rejected", env, { proposal_id, reason });
      return { committed: false, reason: reason === "evaluator_missing"
        ? "no evaluator registered — approve blocked (evaluator_missing)"
        : `eval_delta must be a finite number >= 0, got ${String(evalReport.eval_delta)} — approve rejected` };
    }

    return this.performCommit(env, proposal_id);
  }

  reject(env: Envelope, proposal_id: string, reason: string): void {
    // Enforce operator capability — bound to this specific proposal_id (Fix #3).
    this.requireOperatorCapability(env, "evolution.reject", proposal_id, proposal_id, "reject");
    this.setStatus(proposal_id, "rejected", env.actor_id);
    this.audit.record("evolution.reject", env, { proposal_id, reason });
  }

  async rollback(env: Envelope, rid: string, to_version: string): Promise<{ rid: string; current_version: string }> {
    // Enforce operator capability — resource_id encodes rid+to_version so the token
    // authorises exactly this rollback target (Fix #6). workflow_id = rid.
    const rollbackResourceId = `${rid}@${to_version}`;
    this.requireOperatorCapability(env, "evolution.rollback", rollbackResourceId, rid, "rollback");
    const resource = this.getResource(rid);
    if (!resource) throw new Error(`unknown resource ${rid}`);
    if (resource.evolution_policy === "frozen") throw new Error("frozen resource cannot be rolled back");
    const target = resource.versions.find((v) => v.version === to_version);
    if (!target) throw new Error(`unknown version ${to_version}`);
    this.sql.db.prepare(`UPDATE resources SET current_version = ?, updated_at = datetime('now') WHERE rid = ?`).run(to_version, rid);
    this.audit.record("evolution.rollback", env, { rid, to_version });
    return { rid, current_version: to_version };
  }

  /** Operator-signed unfreeze. Audited as a distinct event. */
  unfreeze(env: Envelope, rid: string): void {
    // Enforce operator capability — bound to the resource rid.
    this.requireOperatorCapability(env, "evolution.unfreeze", rid, rid, "unfreeze");
    const resource = this.getResource(rid);
    if (!resource) throw new Error(`unknown resource ${rid}`);
    if (resource.evolution_policy !== "frozen") return;
    // Defrost to hitl-only — never to auto.
    this.sql.db.prepare(`UPDATE resources SET evolution_policy = 'hitl-only', updated_at = datetime('now') WHERE rid = ?`).run(rid);
    this.audit.record("evolution.unfreeze", env, { rid, prior: "frozen", new: "hitl-only", operator: env.actor_id });
  }

  listPending(): Proposal[] {
    const rows = this.sql.db.prepare(`SELECT proposal_id FROM proposals WHERE status IN ('pending','evaluating') ORDER BY proposed_at ASC`).all() as Array<{ proposal_id: string }>;
    return rows.map((r) => this.getProposal(r.proposal_id)!).filter(Boolean);
  }

  /**
   * WS10: Paginated version of listPending.
   * Uses SQL LIMIT/OFFSET + a separate COUNT(*) — does NOT load all rows then slice.
   * Intended for MCP boundary calls; clamp limit to [1, 200].
   * FIX 1b: accepts optional envelope; when present, emits an "evolution.read" audit event.
   */
  listPendingPage(opts: PaginationOpts = {}, env?: Envelope): Page<Proposal> {
    const { limit, offset } = clampPage(opts);
    const countRow = this.sql.db
      .prepare(`SELECT COUNT(*) as n FROM proposals WHERE status IN ('pending','evaluating')`)
      .get() as { n: number };
    const total = countRow.n;
    const rows = this.sql.db
      .prepare(`SELECT proposal_id FROM proposals WHERE status IN ('pending','evaluating') ORDER BY proposed_at ASC LIMIT ? OFFSET ?`)
      .all(limit, offset) as Array<{ proposal_id: string }>;
    const items = rows.map((r) => this.getProposal(r.proposal_id)!).filter(Boolean);
    if (env) this.audit.record("evolution.read", env, { op: "list_pending", limit, offset, total });
    return { items, total, limit, offset, has_more: offset + items.length < total };
  }

  getProposal(proposal_id: string): Proposal | null {
    const row = this.sql.db.prepare(`SELECT * FROM proposals WHERE proposal_id = ?`).get(proposal_id) as
      | { proposal_id: string; resource_rid: string; candidate_version: string; candidate_content: string; justification: string; evidence_memory_ids_json: string; proposed_by: string; proposed_at: string; status: string; evaluation_json: string | null; decided_at: string | null; decided_by: string | null }
      | undefined;
    if (!row) return null;
    return {
      proposal_id: row.proposal_id,
      resource_rid: row.resource_rid,
      candidate_version: row.candidate_version,
      candidate_content: row.candidate_content,
      justification: row.justification,
      evidence_memory_ids: JSON.parse(row.evidence_memory_ids_json) as string[],
      proposed_by: row.proposed_by,
      proposed_at: row.proposed_at,
      status: row.status as ProposalStatus,
      evaluation: row.evaluation_json ? JSON.parse(row.evaluation_json) as EvaluationReport : undefined,
      decided_at: row.decided_at ?? undefined,
      decided_by: row.decided_by ?? undefined,
    };
  }

  // ---------- Drift detection ----------

  detectDrift(): {
    registry: Array<{ rid: string; on_disk_hash: string; recorded_hash: string }>;
    sources: Array<{ rid: string; source_path: string; on_disk_hash: string; expected_version: string }>;
  } {
    const resources = this.sql.db.prepare(`SELECT rid, current_version FROM resources`).all() as Array<{ rid: string; current_version: string }>;
    const registry: Array<{ rid: string; on_disk_hash: string; recorded_hash: string }> = [];
    const sources: Array<{ rid: string; source_path: string; on_disk_hash: string; expected_version: string }> = [];

    for (const r of resources) {
      // Registry drift (our own store).
      const content = this.readVersion(r.rid, r.current_version);
      if (content === null) {
        registry.push({ rid: r.rid, on_disk_hash: "MISSING", recorded_hash: r.current_version });
      } else {
        const actual = contentHash(content);
        if (actual !== r.current_version) registry.push({ rid: r.rid, on_disk_hash: actual, recorded_hash: r.current_version });
      }

      // Consumer-source drift.
      const sourceRows = this.sql.db.prepare(`SELECT source_path FROM resource_sources WHERE rid = ?`).all(r.rid) as Array<{ source_path: string }>;
      for (const s of sourceRows) {
        if (!existsSync(s.source_path)) {
          sources.push({ rid: r.rid, source_path: s.source_path, on_disk_hash: "MISSING", expected_version: r.current_version });
          continue;
        }
        try {
          const text = readFileSync(s.source_path, "utf8");
          const h = contentHash(text);
          if (h !== r.current_version) {
            sources.push({ rid: r.rid, source_path: s.source_path, on_disk_hash: h, expected_version: r.current_version });
          }
        } catch (err) {
          sources.push({ rid: r.rid, source_path: s.source_path, on_disk_hash: `ERR:${(err as Error).message}`, expected_version: r.current_version });
        }
      }
    }
    return { registry, sources };
  }

  /**
   * WS10 (FIX 3): Paginated drift detection — paginates over DRIFT ENTRIES, not the
   * resource list. One resource with N sources yields N drift entries; all are
   * subject to the limit cap so no single call can return more than `limit` entries.
   *
   * Strategy: scan all resources, collect all drift entries into a flat stream in
   * memory, then apply limit/offset. For detectDrift use-cases the resource set is
   * bounded (typically <1000), so a full scan + slice is acceptable. The cap ensures
   * the MCP response size is always bounded.
   *
   * Returns:
   *   - `items`: up to `limit` drift entries starting at `offset`
   *   - `total`: total number of drift entries across ALL resources (the real total)
   *   - `total_resources`: COUNT(resources) — for context
   *   - `has_more`: whether more drift entries remain after this page
   *
   * FIX 1b: accepts optional envelope; when present emits an "evolution.read" audit event.
   */
  async detectDriftPage(opts: PaginationOpts = {}, env?: Envelope): Promise<Page<{ rid: string; drift_kind: "registry" | "source"; on_disk_hash: string; recorded_hash?: string; source_path?: string; expected_version?: string }> & { total_resources: number; total_registry: number; total_sources: number }> {
    const { limit, offset } = clampPage(opts);
    // Yield the event loop every N resources so this full on-disk scan (reads
    // every resource version + every source file) does not freeze concurrent
    // MCP calls on the single daemon event loop, and so the server seam's
    // per-tool deadline can actually fire mid-scan under host RAM thrash.
    const YIELD_EVERY = 200;
    const resourceCountRow = this.sql.db.prepare(`SELECT COUNT(*) as n FROM resources`).get() as { n: number };
    const total_resources = resourceCountRow.n;

    // Single-pass scan: visit all resources (unavoidable — drift = on-disk hash comparison),
    // but materialize AT MOST `limit` entries in `items`. Entries outside the window
    // [offset, offset+limit) are counted only — never pushed into any array.
    // Memory is O(limit) not O(total_drift_entries).
    const allResources = this.sql.db
      .prepare(`SELECT rid, current_version FROM resources ORDER BY rid`)
      .all() as Array<{ rid: string; current_version: string }>;

    type DriftEntry = { rid: string; drift_kind: "registry" | "source"; on_disk_hash: string; recorded_hash?: string; source_path?: string; expected_version?: string };
    const items: DriftEntry[] = [];
    let entryIndex = 0; // monotonic counter over all drift entries in iteration order
    let total_registry = 0;
    let total_sources = 0;

    const maybeKeep = (entry: DriftEntry): void => {
      if (entryIndex >= offset && entryIndex < offset + limit) {
        items.push(entry);
      }
      entryIndex++;
    };

    let scanned = 0;
    for (const r of allResources) {
      if (++scanned % YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      // Registry drift
      const content = this.readVersion(r.rid, r.current_version);
      if (content === null) {
        total_registry++;
        maybeKeep({ rid: r.rid, drift_kind: "registry", on_disk_hash: "MISSING", recorded_hash: r.current_version });
        // FIX 2: registry-corrupt resource — skip source processing.
        continue;
      }
      const actual = contentHash(content);
      if (actual !== r.current_version) {
        total_registry++;
        maybeKeep({ rid: r.rid, drift_kind: "registry", on_disk_hash: actual, recorded_hash: r.current_version });
        // FIX 2: hash mismatch — skip source processing for this resource.
        continue;
      }
      // Source drift (only reached when registry is clean for this resource)
      const sourceRows = this.sql.db.prepare(`SELECT source_path FROM resource_sources WHERE rid = ?`).all(r.rid) as Array<{ source_path: string }>;
      for (const s of sourceRows) {
        if (!existsSync(s.source_path)) {
          total_sources++;
          maybeKeep({ rid: r.rid, drift_kind: "source", on_disk_hash: "MISSING", source_path: s.source_path, expected_version: r.current_version });
          continue;
        }
        try {
          const text = readFileSync(s.source_path, "utf8");
          const h = contentHash(text);
          if (h !== r.current_version) {
            total_sources++;
            maybeKeep({ rid: r.rid, drift_kind: "source", on_disk_hash: h, source_path: s.source_path, expected_version: r.current_version });
          }
        } catch (err) {
          total_sources++;
          maybeKeep({ rid: r.rid, drift_kind: "source", on_disk_hash: `ERR:${(err as Error).message}`, source_path: s.source_path, expected_version: r.current_version });
        }
      }
    }

    const total = entryIndex; // == total_registry + total_sources
    if (env) this.audit.record("evolution.read", env, { op: "detect_drift", limit, offset, total, total_registry, total_sources, total_resources });
    return { items, total, total_registry, total_sources, total_resources, limit, offset, has_more: offset + items.length < total };
  }

  /**
   * WS10: Drift reconciliation.
   *
   * Paginates over DRIFT ENTRIES (not the resource list — FIX 3). Collects all
   * drift entries from a full resource scan, then applies limit/offset to the flat
   * entry stream, so a single resource with N drifted sources never exceeds the cap.
   *
   * dryRun DEFAULTS TRUE — pass dryRun:false to create proposals.
   *
   * Rules (fail-closed, in priority order):
   *   FIX 6: CRITICAL/FROZEN checked FIRST, before any source/registry handling.
   *     → action="skip" unconditionally. No mutation. No surface.
   *   FIX 2: REGISTRY DRIFT (hash mismatch or MISSING content file) checked next.
   *     → action="surface". `continue` to NEXT RESOURCE — a registry-corrupt
   *     resource must NEVER also receive a source proposal.
   *   SOURCE DRIFT: action="propose" when !dryRun and no pending proposal for this
   *     rid. Dedup via pre-enumerated Set + unique-index conflict handling.
   *   SOURCE MISSING/UNREADABLE: action="surface" (never "propose").
   *   Ambiguous/error: "surface" or "skip" (never "propose").
   *
   * Does NOT bypass Run #11's commit()/approve() gates — only creates proposals.
   */
  async reconcileDrift(env: Envelope, opts: ReconcileDriftOpts = {}): Promise<ReconcileDriftResult> {
    // dryRun defaults to TRUE — must be explicitly false to create proposals.
    const dryRun = opts.dryRun !== false;
    const { limit, offset } = clampPage({ limit: opts.limit, offset: opts.offset });
    // Yield every N resources so the full scan does not freeze concurrent MCP
    // calls and the per-tool deadline can fire mid-scan. Dedup uses an in-memory
    // Set + DB unique index, both unaffected by yielding, so results are
    // identical to the synchronous version (behavior-preserving).
    const YIELD_EVERY = 200;

    // Determine the resource scope: all resources or a single rid.
    const allResourceRows: Array<{ rid: string; current_version: string }> = opts.rid
      ? (() => {
          const r = this.sql.db.prepare(`SELECT rid, current_version FROM resources WHERE rid = ?`).get(opts.rid) as { rid: string; current_version: string } | undefined;
          return r ? [r] : [];
        })()
      : this.sql.db.prepare(`SELECT rid, current_version FROM resources ORDER BY rid`).all() as Array<{ rid: string; current_version: string }>;

    const total_resources = allResourceRows.length;

    // Enumerate pending proposals once for fast dedup (pre-check; unique index is the authoritative guard).
    const pendingRids = new Set<string>(
      (this.sql.db.prepare(`SELECT resource_rid FROM proposals WHERE status IN ('pending','evaluating')`).all() as Array<{ resource_rid: string }>)
        .map((r) => r.resource_rid),
    );

    // ---------- Phase 1: Single-pass scan — materialize AT MOST `limit` entries ----------
    // Entries inside the page window [offset, offset+limit) are kept in full
    // (with _sourceContent/_sourcePath for Phase 2 proposal creation).
    // Entries outside the window are counted only — never pushed into any array.
    // Memory is O(limit), not O(total_drift_entries).
    type PlanEntry = ReconcilePlanEntry & { _sourceContent?: string; _sourcePath?: string };
    const pageEntries: PlanEntry[] = []; // at most `limit` full entries
    let planIndex = 0; // monotonic counter over ALL plan entries in iteration order

    const planMaybeKeep = (entry: PlanEntry): void => {
      if (planIndex >= offset && planIndex < offset + limit) {
        pageEntries.push(entry);
      }
      planIndex++;
    };

    let scanned = 0;
    for (const r of allResourceRows) {
      if (++scanned % YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const resource = this.getResource(r.rid);
      if (!resource) continue; // defensive

      // FIX 6: Check frozen/critical FIRST — before any source or registry handling.
      // Frozen/critical resources skip unconditionally, regardless of drift kind.
      const isFrozenOrCritical =
        resource.evolution_policy === "frozen" || resource.risk_class === "critical";
      if (isFrozenOrCritical) {
        // Still report IF there is actual drift, for operator visibility — always action="skip".
        const hasRegistryDrift = (() => {
          const c = this.readVersion(r.rid, r.current_version);
          if (c === null) return true;
          return contentHash(c) !== r.current_version;
        })();
        if (hasRegistryDrift) {
          planMaybeKeep({ rid: r.rid, drift_kind: "registry", action: "skip", reason: "frozen/critical — reconciliation requires explicit operator action" });
          continue; // FIX 2: skip source processing when registry drift detected
        }
        const sourceRows2 = this.sql.db.prepare(`SELECT source_path FROM resource_sources WHERE rid = ?`).all(r.rid) as Array<{ source_path: string }>;
        for (const s of sourceRows2) {
          let sourceDrifted = false;
          try {
            if (!existsSync(s.source_path)) { sourceDrifted = true; }
            else { sourceDrifted = contentHash(readFileSync(s.source_path, "utf8")) !== r.current_version; }
          } catch { sourceDrifted = true; }
          if (sourceDrifted) {
            planMaybeKeep({ rid: r.rid, drift_kind: "source", action: "skip", reason: "frozen/critical — reconciliation requires explicit operator action" });
          }
        }
        continue; // skip the normal registry+source block below
      }

      // --- Registry drift (FIX 2: continue to next resource if registry is corrupt) ---
      const content = this.readVersion(r.rid, r.current_version);
      if (content === null) {
        planMaybeKeep({ rid: r.rid, drift_kind: "registry", action: "surface", reason: "stored version content missing — manual review required" });
        continue; // FIX 2: do NOT process source drift for a registry-corrupt resource
      }
      const actual = contentHash(content);
      if (actual !== r.current_version) {
        planMaybeKeep({ rid: r.rid, drift_kind: "registry", action: "surface", reason: `registry hash mismatch — possible tamper/corruption; manual review (on_disk: ${actual}, recorded: ${r.current_version})` });
        continue; // FIX 2: do NOT process source drift when registry hash is wrong
      }

      // --- Source drift (only reached when registry is clean) ---
      const sourceRows = this.sql.db.prepare(`SELECT source_path FROM resource_sources WHERE rid = ?`).all(r.rid) as Array<{ source_path: string }>;
      for (const s of sourceRows) {
        if (!existsSync(s.source_path)) {
          planMaybeKeep({ rid: r.rid, drift_kind: "source", action: "surface", reason: `source file missing at ${s.source_path}; manual review required` });
          continue;
        }

        let sourceContent: string;
        let sourceHash: string;
        try {
          sourceContent = readFileSync(s.source_path, "utf8");
          sourceHash = contentHash(sourceContent);
        } catch (err) {
          planMaybeKeep({ rid: r.rid, drift_kind: "source", action: "surface", reason: `source read error at ${s.source_path}: ${(err as Error).message}` });
          continue;
        }

        if (sourceHash === r.current_version) continue; // no drift

        // Fast-path dedup check (proposal already pending for this rid).
        if (pendingRids.has(r.rid)) {
          planMaybeKeep({ rid: r.rid, drift_kind: "source", action: "skip", reason: "proposal already pending — skipping to avoid duplicate" });
          continue;
        }

        // Record as "propose" candidate — only entries in the page window carry
        // _sourceContent/_sourcePath (needed by Phase 2). Out-of-window entries
        // are counted via planMaybeKeep without being retained.
        // Mark rid as pendingRids so multiple drifted sources on the same rid
        // only emit one "propose" entry (others become "skip").
        pendingRids.add(r.rid);
        planMaybeKeep({
          rid: r.rid,
          drift_kind: "source",
          action: "propose",
          reason: `source file ${s.source_path} diverged from recorded version`,
          _sourceContent: sourceContent,
          _sourcePath: s.source_path,
        });
      }
    }

    // total_drifts is the TRUE total — planIndex after the full scan.
    const total_drifts_all = planIndex;

    // ---------- Phase 2: Apply proposals only for entries in the page ----------
    const planned: ReconcilePlanEntry[] = [];
    for (const entry of pageEntries) {
      if (!dryRun && entry.action === "propose" && entry._sourceContent !== undefined) {
        let proposalId: string | undefined;
        try {
          const proposal = this.propose(env, {
            rid: entry.rid,
            candidate_content: entry._sourceContent,
            justification: `reconcileDrift: source file ${entry._sourcePath ?? "unknown"} diverged from recorded version`,
          });
          proposalId = proposal.proposal_id;
        } catch (err) {
          // FIX 5: unique-index conflict → treat as "already pending" skip.
          if (err instanceof Error && (err as NodeJS.ErrnoException & { code?: string }).code === "PROPOSAL_ALREADY_PENDING") {
            planned.push({ rid: entry.rid, drift_kind: "source", action: "skip", reason: "proposal already pending (unique-index conflict)" });
            continue;
          }
          // Other errors: surface fail-closed (don't rethrow from reconcile loop).
          planned.push({ rid: entry.rid, drift_kind: "source", action: "surface", reason: `propose failed: ${err instanceof Error ? err.message : String(err)}` });
          continue;
        }
        // Strip internal _source* fields from the public entry.
        planned.push({ rid: entry.rid, drift_kind: "source", action: "propose", reason: entry.reason, ...(proposalId ? { proposal_id: proposalId } : {}) });
      } else {
        // dryRun, or non-propose entries (surface/skip/registry): emit as-is without _source* fields.
        const { _sourceContent: _c, _sourcePath: _p, ...publicEntry } = entry;
        void _c; void _p;
        planned.push(publicEntry);
      }
    }

    this.audit.record("evolution.reconcile_drift", env, {
      dryRun, limit, offset, total_resources, total_drifts: total_drifts_all, applied: !dryRun,
    });

    return {
      planned,
      total_drifts: total_drifts_all, // total drift entries (all pages)
      total_resources,
      applied: !dryRun,
      limit,
      offset,
      has_more: offset + pageEntries.length < total_drifts_all,
    };
  }

  // ---------- Seeds ----------

  seedCriticalResources(): void {
    const env: Envelope = {
      tenant_id: "local", actor_id: "eights.system",
      project_id: "TheEights", domain: "infra",
      scope: [], trace_id: "seed",
    };
    this.register(env, {
      rid: "resource:eights.policy.evolution-defaults", kind: "policy", risk_class: "critical",
      initial_content: JSON.stringify(DEFAULT_EVOLUTION_POLICY, null, 2), audit_url: CRITICAL_AUDIT_URL,
    });
    this.register(env, {
      rid: "resource:eights.policy.default", kind: "policy", risk_class: "critical",
      initial_content: "# Default policy bundle (v1)\n# See ADR-0005 and engines/policy.ts for the active rule set.\n",
      audit_url: CRITICAL_AUDIT_URL,
    });
    this.register(env, {
      rid: "resource:eights.template.docs-prompt", kind: "prompt", risk_class: "low",
      initial_content: "You are a documentation author. Produce concise, technically accurate prose suitable for a senior engineering audience.",
    });
  }

  // ---------- Internals ----------

  private async performCommit(env: Envelope, proposal_id: string): Promise<{ committed: boolean; reason: string; version: string; writeback: WriteResult[] }> {
    const proposal = this.getProposal(proposal_id);
    if (!proposal) throw new Error("missing proposal");
    const resource = this.getResource(proposal.resource_rid);
    if (!resource) throw new Error("missing resource");

    // 1. Canonical write to ~/.eights/resources/<rid>/<version>.content
    this.writeVersion(proposal.resource_rid, proposal.candidate_version, proposal.candidate_content, env.actor_id, proposal.justification);
    this.sql.db.prepare(`UPDATE resources SET current_version = ?, updated_at = datetime('now') WHERE rid = ?`)
      .run(proposal.candidate_version, proposal.resource_rid);
    this.setStatus(proposal_id, "committed", env.actor_id);
    this.audit.record("evolution.commit", env, { proposal_id, rid: proposal.resource_rid, version: proposal.candidate_version });

    // 2. Writeback to each registered source.
    const writeback: WriteResult[] = [];
    if (this.writeRouter && resource.sources.length) {
      for (const s of resource.sources) {
        if (s.writeback_mode === "none") continue;
        const result = await this.writeRouter.write({
          rid: proposal.resource_rid,
          version: proposal.candidate_version,
          content: proposal.candidate_content,
          source_path: s.source_path,
          writeback_mode: s.writeback_mode,
          proposal_id,
          justification: proposal.justification,
        });
        writeback.push(result);
        if (result.ok) {
          this.sql.db.prepare(
            `UPDATE resource_sources SET last_written_version = ?, last_written_at = ? WHERE rid = ? AND source_path = ?`,
          ).run(proposal.candidate_version, new Date().toISOString(), proposal.resource_rid, s.source_path);
          this.audit.record("evolution.writeback", env, { rid: proposal.resource_rid, source_path: s.source_path, version: proposal.candidate_version, mode: result.mode_used, git_commit: result.git_commit });
        } else {
          this.audit.record("evolution.writeback.failed", env, { rid: proposal.resource_rid, source_path: s.source_path, error: result.error });
        }
      }
    }

    return { committed: true, reason: "ok", version: proposal.candidate_version, writeback };
  }

  /**
   * Used by registrars when a source file is updated outside the evolution flow.
   *
   * register_now bypass fix: this method MUST respect the resource's evolution
   * policy — it cannot directly mutate frozen or hitl-only resources, which would
   * bypass the proposal/eval/HITL flow and violate the governance invariants.
   *
   * Policy routing:
   *   frozen         → throws (no mutation ever)
   *   hitl-only      → creates a pending proposal (propose), does NOT commit;
   *   high / medium  → same as hitl-only (DEFAULT_EVOLUTION_POLICY maps both to hitl-only)
   *   auto / auto-low-risk on low → imports directly (original behaviour)
   *
   * Returns the version hash. For hitl-only resources returns the existing
   * current_version (unchanged) and surfaces the proposal_id in the audit log
   * so the operator can find and approve it.
   */
  importFromSource(env: Envelope, rid: string, content: string, justification: string): string {
    const resource = this.getResource(rid);
    if (!resource) throw new Error(`unknown resource ${rid}`);

    const policy = resource.evolution_policy;

    // Frozen: never mutate.
    if (policy === "frozen") {
      this.audit.record("evolution.import_from_source.blocked", env, { rid, justification, reason: "frozen" });
      throw new Error(`importFromSource: resource '${rid}' is frozen — direct import blocked; use propose()+approve() after operator unfreeze`);
    }

    // hitl-only (or any non-auto policy): route through the proposal path instead
    // of directly mutating current_version. The registrar's diff signal is
    // preserved via the proposal, and the operator approves via the normal flow.
    if (policy === "hitl-only" || (policy !== "auto" && policy !== "auto-low-risk")) {
      const version = contentHash(content);
      if (version === resource.current_version) return version; // already current
      // Create a proposal so the change goes through HITL.
      const proposal = this.propose(env, { rid, candidate_content: content, justification });
      this.audit.record("evolution.import_from_source.queued", env, {
        rid, version, justification,
        proposal_id: proposal.proposal_id,
        reason: `policy=${policy} — routed to proposal; approve to commit`,
      });
      // Return current (unchanged) version — the import has not been committed.
      return resource.current_version;
    }

    // FIX 2 (importFromSource): mirror commit()'s risk gate — auto/auto-low-risk may
    // only auto-apply when risk_class === "low". A resource planted (or upgraded) to
    // a higher risk class with an auto policy bypassed commit() here before this fix.
    if (policy === "auto" && resource.risk_class !== "low") {
      // Route to HITL instead of direct write (same outcome as hitl-only branch above).
      const version = contentHash(content);
      if (version === resource.current_version) return version;
      const proposal = this.propose(env, { rid, candidate_content: content, justification });
      this.audit.record("evolution.import_from_source.queued", env, {
        rid, version, justification,
        proposal_id: proposal.proposal_id,
        reason: `auto policy requires risk_class=low (got ${resource.risk_class}) — routed to proposal; approve to commit`,
      });
      return resource.current_version;
    }
    if (policy === "auto-low-risk" && resource.risk_class !== "low") {
      const version = contentHash(content);
      if (version === resource.current_version) return version;
      const proposal = this.propose(env, { rid, candidate_content: content, justification });
      this.audit.record("evolution.import_from_source.queued", env, {
        rid, version, justification,
        proposal_id: proposal.proposal_id,
        reason: `auto-low-risk policy requires risk_class=low (got ${resource.risk_class}) — routed to proposal; approve to commit`,
      });
      return resource.current_version;
    }
    if (policy !== "auto" && policy !== "auto-low-risk") {
      // Unknown policy: fail closed — queue HITL so a human can inspect.
      const version = contentHash(content);
      if (version === resource.current_version) return version;
      const proposal = this.propose(env, { rid, candidate_content: content, justification });
      this.audit.record("evolution.import_from_source.queued", env, {
        rid, version, justification,
        proposal_id: proposal.proposal_id,
        reason: `unknown policy '${policy}' — fail-closed; routed to proposal`,
      });
      return resource.current_version;
    }
    // policy === "auto" or "auto-low-risk", and risk_class === "low": direct import.
    const version = contentHash(content);
    if (version === resource.current_version) return version;
    this.writeVersion(rid, version, content, env.actor_id, justification);
    this.sql.db.prepare(`UPDATE resources SET current_version = ?, updated_at = datetime('now') WHERE rid = ?`).run(version, rid);
    this.audit.record("evolution.import_from_source", env, { rid, version, justification });
    return version;
  }

  private setStatus(proposal_id: string, status: ProposalStatus, decided_by?: string): void {
    if (decided_by) {
      this.sql.db.prepare(`UPDATE proposals SET status = ?, decided_at = datetime('now'), decided_by = ? WHERE proposal_id = ?`).run(status, decided_by, proposal_id);
    } else {
      this.sql.db.prepare(`UPDATE proposals SET status = ? WHERE proposal_id = ?`).run(status, proposal_id);
    }
  }

  private writeVersion(rid: string, version: string, content: string, created_by: string, justification: string | null): void {
    const dir = join(this.resourcesDir, sanitizeRid(rid));
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${version}.content`);
    writeFileSync(filePath, content, "utf8");
    const sig = signature(content);
    writeFileSync(join(dir, `${version}.sig`), sig, "utf8");
    const now = new Date().toISOString();
    this.sql.db.prepare(
      `INSERT OR IGNORE INTO resource_versions(rid, version, content, signature, created_at, created_by, justification, evidence_memory_ids_json)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(rid, version, content, sig, now, created_by, justification, "[]");
  }

  private versionPath(rid: string, version: string): string {
    return join(this.resourcesDir, sanitizeRid(rid), `${version}.content`);
  }
}

// ---------- WS10: Pagination helper ----------

const MCP_PAGE_CAP = 200;
const MCP_PAGE_DEFAULT = 50;

/**
 * Clamp pagination opts for the MCP boundary.
 * limit  → clamped to [1, 200], default 50 when absent or 0
 * offset → default 0, clamped to >= 0
 */
export function clampPage(opts: PaginationOpts): { limit: number; offset: number } {
  const rawLimit = opts.limit ?? MCP_PAGE_DEFAULT;
  const limit = Math.min(Math.max(rawLimit < 1 ? MCP_PAGE_DEFAULT : rawLimit, 1), MCP_PAGE_CAP);
  const offset = Math.max(opts.offset ?? 0, 0);
  return { limit, offset };
}

/**
 * isCommittableDelta — shared finite-delta gate for commit() and approve().
 *
 * A persisted/legacy/malformed EvaluationReport may carry eval_delta=null,
 * eval_delta=NaN, or eval_delta=Infinity because getProposal() blindly
 * JSON.parse()s the stored blob. In JavaScript:
 *   null < 0  → false  (null coerces to 0)
 *   NaN  < 0  → false  (any NaN comparison is false)
 * so a bare `eval_delta < 0` check silently passes these values and allows
 * auto-commit on a broken/tampered report.
 *
 * This helper enforces BOTH invariants atomically:
 *   1. evaluator_missing === false  (explicit flag, not merely falsy)
 *   2. eval_delta is a finite number >= 0
 *
 * Return true only when the report is safe to commit. False on any
 * missing/malformed/non-finite/negative delta, or any evaluator_missing
 * value other than literal false.
 */
export function isCommittableDelta(report: EvaluationReport): boolean {
  if (report.evaluator_missing !== false) return false;
  const d = report.eval_delta;
  return typeof d === "number" && Number.isFinite(d) && d >= 0;
}

/**
 * TE-EV-3: risk / policy compatibility gate (full enumeration).
 *
 * Rules (ADR-0006 extension):
 *   critical  → MUST be frozen
 *   high      → at most hitl-only  (auto / auto-low-risk forbidden)
 *   medium    → at most hitl-only  (auto / auto-low-risk forbidden)
 *   low       → any policy allowed
 *
 * Every known EvolutionPolicy value is checked explicitly so new values
 * added to the enum surface a type error or a clear runtime rejection.
 * Throws a descriptive Error on violation. Called in register() on BOTH
 * the new-resource path and the existing-resource update path (#3b).
 */
export function validateRiskPolicyCompat(risk_class: string, evolution_policy: string): void {
  if (risk_class === "critical" && evolution_policy !== "frozen") {
    throw new Error(
      `risk/policy conflict: critical resources must have evolution_policy=frozen, got '${evolution_policy}'`,
    );
  }
  // auto and auto-low-risk are both "auto-commit" policies — neither may be
  // used on high/medium risk resources.
  if (
    (risk_class === "high" || risk_class === "medium") &&
    (evolution_policy === "auto" || evolution_policy === "auto-low-risk")
  ) {
    throw new Error(
      `risk/policy conflict: ${risk_class} resources may not use evolution_policy=${evolution_policy} (max: hitl-only)`,
    );
  }
}

export function contentHash(s: string): string {
  return "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");
}

function signature(s: string): string {
  return "v1:" + createHash("sha256").update("eights/v1/" + s, "utf8").digest("hex").slice(0, 40);
}

function sanitizeRid(rid: string): string {
  return rid.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function hashFileContent(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    statSync(path); // stat to surface permission errors
    return contentHash(readFileSync(path, "utf8"));
  } catch { return null; }
}
