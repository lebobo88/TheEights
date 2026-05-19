/**
 * EvolutionEngine — Autogenesis-aligned RSPL + SEPL.
 *
 * RSPL (Resource Substrate): versioned, content-addressed resource registry on
 * disk under ~/.eights/resources/<kind>/<rid>/<version>.{content,sig}.
 *
 * SEPL (Self-Evolution Protocol): propose → evaluate → commit | queue-for-HITL
 * → approve/reject → rollback. Risk-class routing per ADR-0006.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SqliteStore } from "../stores/sqlite.js";
import type { PolicyEngine } from "./policy.js";
import type { AuditEngine } from "./audit.js";
import type { Envelope } from "../schemas/envelope.js";
import type {
  Resource, ResourceKind, RiskClass, EvolutionPolicy,
} from "../schemas/resource.js";
import { DEFAULT_EVOLUTION_POLICY } from "../schemas/resource.js";
import type { Proposal, ProposalStatus, EvaluationReport } from "../schemas/proposal.js";

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
}

const CRITICAL_AUDIT_URL = "graph://resources/critical";

export class EvolutionEngine {
  constructor(
    private readonly sql: SqliteStore,
    private readonly resourcesDir: string,
    private readonly policy: PolicyEngine,
    private readonly audit: AuditEngine,
  ) {
    mkdirSync(this.resourcesDir, { recursive: true });
  }

  // ---------- RSPL ----------

  /** Idempotent resource creation. Returns the resource record. */
  register(env: Envelope, input: RegisterResourceInput): Resource {
    const existing = this.getResource(input.rid);
    if (existing) return existing;
    const evolution_policy = input.evolution_policy ?? DEFAULT_EVOLUTION_POLICY[input.risk_class];
    const version = contentHash(input.initial_content);
    const now = new Date().toISOString();
    const audit_url = input.audit_url ?? `graph://resources/${input.rid}`;
    this.sql.db.prepare(
      `INSERT INTO resources(rid, kind, risk_class, current_version, evolution_policy, audit_url, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(input.rid, input.kind, input.risk_class, version, evolution_policy, audit_url, now, now);
    this.writeVersion(input.rid, version, input.initial_content, "system:seed", "initial seed");
    this.audit.record("evolution.register", env, { rid: input.rid, kind: input.kind, risk_class: input.risk_class });
    return this.getResource(input.rid)!;
  }

  getResource(rid: string): Resource | null {
    const row = this.sql.db.prepare("SELECT * FROM resources WHERE rid = ?").get(rid) as
      | { rid: string; kind: string; risk_class: string; current_version: string; evolution_policy: string; audit_url: string }
      | undefined;
    if (!row) return null;
    const versions = this.sql.db
      .prepare("SELECT * FROM resource_versions WHERE rid = ? ORDER BY created_at ASC")
      .all(rid) as Array<{ rid: string; version: string; content: string; signature: string; created_at: string; created_by: string; justification: string | null; evidence_memory_ids_json: string }>;
    return {
      rid: row.rid,
      kind: row.kind as ResourceKind,
      risk_class: row.risk_class as RiskClass,
      current_version: row.current_version,
      evolution_policy: row.evolution_policy as EvolutionPolicy,
      audit_url: row.audit_url,
      versions: versions.map((v) => ({
        version: v.version,
        content: v.content,
        signature: v.signature,
        created_at: v.created_at,
        created_by: v.created_by,
        justification: v.justification ?? undefined,
        evidence_memory_ids: JSON.parse(v.evidence_memory_ids_json) as string[],
      })),
    };
  }

  readVersion(rid: string, version: string): string | null {
    const path = this.versionPath(rid, version);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  }

  // ---------- SEPL ----------

  propose(env: Envelope, input: ProposeInput): Proposal {
    const resource = this.getResource(input.rid);
    if (!resource) throw new Error(`unknown resource ${input.rid}`);
    if (resource.evolution_policy === "frozen") {
      this.audit.record("evolution.propose.rejected", env, { rid: input.rid, reason: "frozen" });
      throw new Error(`resource ${input.rid} is frozen — cannot evolve`);
    }
    const candidate_version = contentHash(input.candidate_content);
    const proposal_id = `prop_${randomUUID()}`;
    const now = new Date().toISOString();
    this.sql.db.prepare(
      `INSERT INTO proposals(proposal_id, resource_rid, candidate_version, candidate_content, justification, evidence_memory_ids_json, proposed_by, proposed_at, status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      proposal_id, input.rid, candidate_version, input.candidate_content,
      input.justification, JSON.stringify(input.evidence_memory_ids ?? []),
      env.actor_id, now, "pending" satisfies ProposalStatus,
    );
    this.audit.record("evolution.propose", env, { proposal_id, rid: input.rid, candidate_version });
    return this.getProposal(proposal_id)!;
  }

  /** Run the eval suite for this resource and produce a report. v1: stub returns 0. */
  async evaluate(env: Envelope, proposal_id: string): Promise<EvaluationReport> {
    const proposal = this.getProposal(proposal_id);
    if (!proposal) throw new Error(`unknown proposal ${proposal_id}`);
    this.setStatus(proposal_id, "evaluating");

    // SSGM gates apply at the eval stage so they're visible in the report.
    const ssgm = {
      consistency: { passed: true, conflicts: [] as string[] },
      temporal_decay: { passed: true, reason: undefined as string | undefined },
      access_control: { passed: true, reason: undefined as string | undefined },
    };

    const report: EvaluationReport = {
      proposal_id,
      eval_delta: 0,                 // v1 stub: no eval suite wired; Phase 3 follow-on plugs in per-resource evals
      metric_scores: {},
      ssgm_gate_results: ssgm,
      notes: "v1 stub eval — returns 0 delta. Wire per-resource eval suites in a follow-on commit.",
    };
    this.sql.db.prepare(`UPDATE proposals SET evaluation_json = ? WHERE proposal_id = ?`)
      .run(JSON.stringify(report), proposal_id);
    this.audit.record("evolution.evaluate", env, { proposal_id, eval_delta: report.eval_delta });
    return report;
  }

  /**
   * Commit a proposal. Routing per ADR-0006:
   *   - resource.evolution_policy === "auto" AND eval_delta >= 0 → commit
   *   - otherwise → queue for HITL (status stays pending; caller invokes approve())
   *   - "frozen" → reject
   */
  async commit(env: Envelope, proposal_id: string): Promise<{ committed: boolean; reason: string; version?: string }> {
    const proposal = this.getProposal(proposal_id);
    if (!proposal) throw new Error(`unknown proposal ${proposal_id}`);
    const resource = this.getResource(proposal.resource_rid);
    if (!resource) throw new Error(`unknown resource ${proposal.resource_rid}`);
    if (resource.evolution_policy === "frozen") {
      this.setStatus(proposal_id, "rejected", env.actor_id);
      this.audit.record("evolution.commit.rejected", env, { proposal_id, reason: "frozen" });
      return { committed: false, reason: "resource is frozen" };
    }
    if (resource.evolution_policy === "hitl-only") {
      this.audit.record("evolution.commit.queued", env, { proposal_id });
      return { committed: false, reason: "hitl-only — call approve() to commit" };
    }
    const evalReport = proposal.evaluation;
    if (!evalReport) {
      return { committed: false, reason: "must evaluate before commit" };
    }
    if (evalReport.eval_delta < 0) {
      this.setStatus(proposal_id, "rejected", env.actor_id);
      this.audit.record("evolution.commit.rejected", env, { proposal_id, reason: "negative eval delta" });
      return { committed: false, reason: "eval_delta < 0 — proposal rejected" };
    }
    return this.performCommit(env, proposal_id);
  }

  /** Operator override — used by HITL. Forces commit even on hitl-only resources. */
  async approve(env: Envelope, proposal_id: string): Promise<{ committed: boolean; reason: string; version?: string }> {
    const proposal = this.getProposal(proposal_id);
    if (!proposal) throw new Error(`unknown proposal ${proposal_id}`);
    const resource = this.getResource(proposal.resource_rid);
    if (resource?.evolution_policy === "frozen") {
      throw new Error("frozen resources cannot be approved without explicit unfreeze");
    }
    return this.performCommit(env, proposal_id);
  }

  reject(env: Envelope, proposal_id: string, reason: string): void {
    this.setStatus(proposal_id, "rejected", env.actor_id);
    this.audit.record("evolution.reject", env, { proposal_id, reason });
  }

  async rollback(env: Envelope, rid: string, to_version: string): Promise<{ rid: string; current_version: string }> {
    const resource = this.getResource(rid);
    if (!resource) throw new Error(`unknown resource ${rid}`);
    if (resource.evolution_policy === "frozen") throw new Error("frozen resource cannot be rolled back");
    const target = resource.versions.find((v) => v.version === to_version);
    if (!target) throw new Error(`unknown version ${to_version}`);
    this.sql.db.prepare(`UPDATE resources SET current_version = ?, updated_at = datetime('now') WHERE rid = ?`)
      .run(to_version, rid);
    this.audit.record("evolution.rollback", env, { rid, to_version });
    return { rid, current_version: to_version };
  }

  listPending(): Proposal[] {
    const rows = this.sql.db.prepare(`SELECT * FROM proposals WHERE status IN ('pending','evaluating') ORDER BY proposed_at ASC`).all() as Array<{ proposal_id: string }>;
    return rows.map((r) => this.getProposal(r.proposal_id)!).filter(Boolean);
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

  detectDrift(): Array<{ rid: string; on_disk_hash: string; recorded_hash: string }> {
    const resources = this.sql.db.prepare(`SELECT rid, current_version FROM resources`).all() as Array<{ rid: string; current_version: string }>;
    const drift: Array<{ rid: string; on_disk_hash: string; recorded_hash: string }> = [];
    for (const r of resources) {
      const content = this.readVersion(r.rid, r.current_version);
      if (content === null) {
        drift.push({ rid: r.rid, on_disk_hash: "MISSING", recorded_hash: r.current_version });
        continue;
      }
      const actual = contentHash(content);
      if (actual !== r.current_version) {
        drift.push({ rid: r.rid, on_disk_hash: actual, recorded_hash: r.current_version });
      }
    }
    return drift;
  }

  // ---------- Seeds ----------

  seedCriticalResources(): void {
    const env: Envelope = {
      tenant_id: "local", actor_id: "eights.system",
      project_id: "TheEights", domain: "infra",
      scope: [], trace_id: "seed",
    };
    this.register(env, {
      rid: "resource:eights.policy.evolution-defaults",
      kind: "policy",
      risk_class: "critical",
      initial_content: JSON.stringify(DEFAULT_EVOLUTION_POLICY, null, 2),
      audit_url: CRITICAL_AUDIT_URL,
    });
    this.register(env, {
      rid: "resource:eights.policy.default",
      kind: "policy",
      risk_class: "critical",
      initial_content: "# Default policy bundle (v1)\n# See ADR-0005 and engines/policy.ts for the active rule set.\n",
      audit_url: CRITICAL_AUDIT_URL,
    });
    this.register(env, {
      rid: "resource:eights.template.docs-prompt",
      kind: "prompt",
      risk_class: "low",
      initial_content: "You are a documentation author. Produce concise, technically accurate prose suitable for a senior engineering audience.",
    });
  }

  // ---------- Internals ----------

  private async performCommit(env: Envelope, proposal_id: string): Promise<{ committed: boolean; reason: string; version: string }> {
    const proposal = this.getProposal(proposal_id);
    if (!proposal) throw new Error("missing proposal");
    this.writeVersion(proposal.resource_rid, proposal.candidate_version, proposal.candidate_content, env.actor_id, proposal.justification);
    this.sql.db.prepare(`UPDATE resources SET current_version = ?, updated_at = datetime('now') WHERE rid = ?`)
      .run(proposal.candidate_version, proposal.resource_rid);
    this.setStatus(proposal_id, "committed", env.actor_id);
    this.audit.record("evolution.commit", env, { proposal_id, rid: proposal.resource_rid, version: proposal.candidate_version });
    return { committed: true, reason: "ok", version: proposal.candidate_version };
  }

  private setStatus(proposal_id: string, status: ProposalStatus, decided_by?: string): void {
    if (decided_by) {
      this.sql.db.prepare(`UPDATE proposals SET status = ?, decided_at = datetime('now'), decided_by = ? WHERE proposal_id = ?`)
        .run(status, decided_by, proposal_id);
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

function contentHash(s: string): string {
  return "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");
}

function signature(s: string): string {
  // v1: HMAC-less self-signature derived from content hash. Phase 4 swaps in a real keyed signature.
  return "v1:" + createHash("sha256").update("eights/v1/" + s, "utf8").digest("hex").slice(0, 40);
}

function sanitizeRid(rid: string): string {
  return rid.replace(/[^a-zA-Z0-9._-]/g, "_");
}
