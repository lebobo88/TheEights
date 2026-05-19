/**
 * ConstitutionEngine — thin wrapper over EvolutionEngine that gives the
 * "Immortal Head" of each consumer a stable, audited home.
 *
 * One constitution per consumer (rid: `resource:<consumer>.constitution`).
 * risk_class = "critical" → evolution_policy = "frozen" by default. Mutation
 * requires `eights.constitution.propose_amendment` (always HITL) and an
 * explicit operator `unfreeze` first, both audit-logged.
 *
 * `attest` is the contract Hydra (and any other supervisor) calls at workflow
 * intake to bind a run to a specific constitution hash. The returned receipt
 * is hash-chained into the audit log so the run is provably bound.
 */
import { createHash } from "node:crypto";
import type { EvolutionEngine } from "./evolution.js";
import type { AuditEngine } from "./audit.js";
import type { Envelope } from "../schemas/envelope.js";
import type { Consumer } from "../schemas/resource.js";

export interface ConstitutionReceipt {
  consumer: Consumer;
  rid: string;
  version: string;
  content_hash: string;
  attested_at: string;
  trace_id: string;
  receipt_signature: string;
}

export interface ConstitutionView {
  consumer: Consumer;
  rid: string;
  version: string;
  text: string;
  hash: string;
  frozen: boolean;
}

const RID = (c: Consumer): string => `resource:${c}.constitution`;

export class ConstitutionEngine {
  constructor(
    private readonly evolution: EvolutionEngine,
    private readonly audit: AuditEngine,
  ) {}

  /** Idempotent seed of a consumer's constitution. */
  seed(env: Envelope, consumer: Consumer, initial_content: string, source_path?: string): ConstitutionView {
    this.evolution.register(env, {
      rid: RID(consumer),
      kind: "constitution",
      risk_class: "critical",
      initial_content,
      consumer,
      source_paths: source_path ? [source_path] : undefined,
      writeback_mode: source_path ? "in-place" : "none",
      audit_url: `graph://constitutions/${consumer}`,
    });
    return this.get(env, consumer);
  }

  get(env: Envelope, consumer: Consumer): ConstitutionView {
    const r = this.evolution.getResource(RID(consumer));
    if (!r) throw new Error(`no constitution registered for ${consumer}`);
    const text = this.evolution.readVersion(r.rid, r.current_version) ?? "";
    this.audit.record("constitution.get", env, { consumer, version: r.current_version });
    return {
      consumer,
      rid: r.rid,
      version: r.current_version,
      text,
      hash: r.current_version,
      frozen: r.evolution_policy === "frozen",
    };
  }

  /** Always queues HITL — never auto-commits, even after operator-driven unfreeze. */
  proposeAmendment(env: Envelope, consumer: Consumer, draft: string, rationale: string, evidence_memory_ids?: string[]) {
    const rid = RID(consumer);
    const proposal = this.evolution.propose(env, {
      rid,
      candidate_content: draft,
      justification: `constitution amendment: ${rationale}`,
      evidence_memory_ids,
    });
    this.audit.record("constitution.propose_amendment", env, {
      consumer, proposal_id: proposal.proposal_id, rationale,
    });
    return proposal;
  }

  /**
   * Bind a workflow run to the current constitution. Emits a hash-chained
   * audit event so future replay can prove which covenant the run was under.
   */
  attest(env: Envelope, consumer: Consumer): ConstitutionReceipt {
    const r = this.evolution.getResource(RID(consumer));
    if (!r) {
      this.audit.record("constitution.attest.refused", env, { consumer, reason: "missing" });
      throw new Error(`refusing attestation — no constitution registered for ${consumer}`);
    }
    const text = this.evolution.readVersion(r.rid, r.current_version) ?? "";
    const content_hash = "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
    if (content_hash !== r.current_version) {
      this.audit.record("constitution.attest.refused", env, {
        consumer, reason: "content_hash_drift",
        recorded: r.current_version, actual: content_hash,
      });
      throw new Error(`constitution content drift detected for ${consumer}`);
    }
    const attested_at = new Date().toISOString();
    const receipt_signature = createHash("sha256")
      .update(`eights/constitution/v1/${consumer}/${r.current_version}/${env.trace_id}/${attested_at}`, "utf8")
      .digest("hex");
    this.audit.record("constitution.attest", env, {
      consumer, rid: r.rid, version: r.current_version, attested_at, receipt_signature,
    });
    return {
      consumer,
      rid: r.rid,
      version: r.current_version,
      content_hash,
      attested_at,
      trace_id: env.trace_id,
      receipt_signature,
    };
  }
}
