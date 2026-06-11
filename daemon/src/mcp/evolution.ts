import { z } from "zod";
import { Envelope } from "../schemas/envelope.js";
import { ResourceKind, RiskClass, EvolutionPolicy, Consumer, WritebackMode, DEFAULT_EVOLUTION_POLICY } from "../schemas/resource.js";
import type { EvolutionEngine } from "../engines/evolution.js";
import { clampPage } from "../engines/evolution.js";

/** TE-EV-3: risk/policy compatibility predicate — mirrors validateRiskPolicyCompat in the engine.
 *  Must stay in sync with engines/evolution.ts:validateRiskPolicyCompat. */
function riskPolicyCompatible(risk_class: string, evolution_policy: string | undefined): { ok: boolean; message: string } {
  const policy = evolution_policy ?? DEFAULT_EVOLUTION_POLICY[risk_class as keyof typeof DEFAULT_EVOLUTION_POLICY];
  if (risk_class === "critical" && policy !== "frozen") {
    return { ok: false, message: `risk/policy conflict: critical resources must have evolution_policy=frozen, got '${policy}'` };
  }
  // Both "auto" and "auto-low-risk" are auto-commit policies — forbidden on high/medium.
  if (
    (risk_class === "high" || risk_class === "medium") &&
    (policy === "auto" || policy === "auto-low-risk")
  ) {
    return { ok: false, message: `risk/policy conflict: ${risk_class} resources may not use evolution_policy=${policy} (max: hitl-only)` };
  }
  return { ok: true, message: "ok" };
}

export const RegisterArgs = z.object({
  envelope: Envelope,
  rid: z.string(),
  kind: ResourceKind,
  risk_class: RiskClass,
  evolution_policy: EvolutionPolicy.optional(),
  initial_content: z.string(),
  consumer: Consumer.optional(),
  source_paths: z.array(z.string()).optional(),
  writeback_mode: WritebackMode.optional(),
}).refine(
  (d) => riskPolicyCompatible(d.risk_class, d.evolution_policy).ok,
  (d) => ({ message: riskPolicyCompatible(d.risk_class, d.evolution_policy).message }),
);

export const ProposeArgs = z.object({
  envelope: Envelope,
  rid: z.string(),
  candidate_content: z.string(),
  justification: z.string(),
  evidence_memory_ids: z.array(z.string()).default([]),
});

export const EvalArgs = z.object({ envelope: Envelope, proposal_id: z.string() });
export const CommitArgs = z.object({ envelope: Envelope, proposal_id: z.string() });
export const ApproveArgs = z.object({ envelope: Envelope, proposal_id: z.string() });
export const RejectArgs = z.object({ envelope: Envelope, proposal_id: z.string(), reason: z.string() });
export const RollbackArgs = z.object({ envelope: Envelope, rid: z.string(), to_version: z.string() });
export const UnfreezeArgs = z.object({ envelope: Envelope, rid: z.string() });
/** FIX (Round 3+): envelope required — every get_resource read is audited. */
export const GetResourceArgs = z.object({ envelope: Envelope, rid: z.string() });

/**
 * WS10: Pagination fields added to list tools at the MCP boundary.
 * FIX 7: Accept any integer at the schema layer; clampPage() does the [1,200] / default-50
 * clamping in the handler so limit=500 returns 200 items (not a validation error).
 */
export const PaginationFields = {
  limit: z.number().int().optional().describe("Page size (clamped to [1,200]; default 50)"),
  offset: z.number().int().optional().describe("Page start offset (default 0, clamped to >=0)"),
};

export const ListResourcesArgs = z.object({
  /** FIX 1b (Round 3): envelope is REQUIRED — every read is audited at the MCP boundary. */
  envelope: Envelope,
  consumer: Consumer.optional(),
  kind: ResourceKind.optional(),
  risk: RiskClass.optional(),
  ...PaginationFields,
});

/**
 * WS10: list_pending args — includes pagination.
 * Returns Page<Proposal> with total + has_more so consumers can page through
 * the full pending queue (currently ~530 rows) without loading it all at once.
 * FIX 1b (Round 3): envelope is REQUIRED — every read is audited at the MCP boundary.
 */
export const ListPendingArgs = z.object({
  envelope: Envelope,
  ...PaginationFields,
});

/**
 * WS10: detect_drift args — includes pagination over DRIFT ENTRIES (FIX 3).
 * total = total drift entries across all resources; total_resources = COUNT(resources).
 * has_more reflects whether more DRIFT ENTRIES remain.
 * FIX 1b (Round 3): envelope is REQUIRED — every read is audited at the MCP boundary.
 */
export const DetectDriftArgs = z.object({
  envelope: Envelope,
  ...PaginationFields,
});

/**
 * WS10: reconcile_drift args.
 * dryRun defaults true — only returns planned actions without creating proposals.
 * Set dryRun:false to create proposals (never commits; goes through propose() only).
 */
export const ReconcileDriftArgs = z.object({
  envelope: Envelope,
  rid: z.string().optional().describe("Scope to a single resource id; omit for all resources"),
  dryRun: z.boolean().optional().describe("Default true. Set false to create proposals (never commits)."),
  ...PaginationFields,
});

export const Empty = z.object({});

export function registerEvolutionTools(engine: EvolutionEngine) {
  return {
    "eights.evolution.register": {
      description: "Register (or attach a new source_path to) an RSPL resource.",
      schema: RegisterArgs,
      handler: async (a: z.infer<typeof RegisterArgs>) =>
        engine.register(a.envelope, {
          rid: a.rid, kind: a.kind, risk_class: a.risk_class, evolution_policy: a.evolution_policy,
          initial_content: a.initial_content, consumer: a.consumer,
          source_paths: a.source_paths, writeback_mode: a.writeback_mode,
        }),
    },
    "eights.evolution.get_resource": {
      description: "Get a resource by rid. Envelope required — every read is audited.",
      schema: GetResourceArgs,
      handler: async (a: z.infer<typeof GetResourceArgs>) => engine.getResource(a.rid, a.envelope),
    },
    "eights.evolution.list_resources": {
      description: "List resources (paginated). Returns Page<Resource> with total + has_more. limit default 50, max 200 (clamped). Use offset to page. Envelope required — every read is audited.",
      schema: ListResourcesArgs,
      handler: async (a: z.infer<typeof ListResourcesArgs>) => {
        const { limit, offset } = clampPage({ limit: a.limit, offset: a.offset });
        return engine.listResourcesPage({ consumer: a.consumer, kind: a.kind, risk: a.risk }, { limit, offset }, a.envelope);
      },
    },
    "eights.evolution.propose": {
      description: "Propose a new version of a resource.",
      schema: ProposeArgs,
      handler: async (a: z.infer<typeof ProposeArgs>) => engine.propose(a.envelope, a),
    },
    "eights.evolution.evaluate": {
      description: "Run the eval adapter against a pending proposal.",
      schema: EvalArgs,
      handler: async (a: z.infer<typeof EvalArgs>) => engine.evaluate(a.envelope, a.proposal_id),
    },
    "eights.evolution.commit": {
      description: "Attempt commit. Auto-commits when policy=auto and eval_delta>=0; otherwise queues for HITL. Writes back to source_paths on success.",
      schema: CommitArgs,
      handler: async (a: z.infer<typeof CommitArgs>) => engine.commit(a.envelope, a.proposal_id),
    },
    "eights.evolution.approve": {
      description: "Operator approval — forces commit on hitl-only resources. Writes back.",
      schema: ApproveArgs,
      handler: async (a: z.infer<typeof ApproveArgs>) => engine.approve(a.envelope, a.proposal_id),
    },
    "eights.evolution.reject": {
      description: "Reject a pending proposal with reason.",
      schema: RejectArgs,
      handler: async (a: z.infer<typeof RejectArgs>) => { engine.reject(a.envelope, a.proposal_id, a.reason); return { ok: true }; },
    },
    "eights.evolution.rollback": {
      description: "Roll a resource back to a prior version.",
      schema: RollbackArgs,
      handler: async (a: z.infer<typeof RollbackArgs>) => engine.rollback(a.envelope, a.rid, a.to_version),
    },
    "eights.evolution.unfreeze": {
      description: "Operator-signed unfreeze. Frozen → hitl-only. Audited as a separate event.",
      schema: UnfreezeArgs,
      handler: async (a: z.infer<typeof UnfreezeArgs>) => { engine.unfreeze(a.envelope, a.rid); return { ok: true, rid: a.rid }; },
    },
    "eights.evolution.list_pending": {
      description: "List proposals awaiting evaluation or HITL approval (paginated). Returns Page<Proposal> with total + has_more. limit default 50, max 200 (clamped). Envelope required — every read is audited.",
      schema: ListPendingArgs,
      handler: async (a: z.infer<typeof ListPendingArgs>) => {
        const { limit, offset } = clampPage({ limit: a.limit, offset: a.offset });
        return engine.listPendingPage({ limit, offset }, a.envelope);
      },
    },
    "eights.evolution.detect_drift": {
      description: "Drift scan (FIX 3: paginated over DRIFT ENTRIES). Returns Page<DriftEntry> with total=total drift entries, total_resources=COUNT(resources), has_more over entries. limit default 50, max 200 (clamped). Envelope required — every read is audited.",
      schema: DetectDriftArgs,
      handler: async (a: z.infer<typeof DetectDriftArgs>) => {
        const { limit, offset } = clampPage({ limit: a.limit, offset: a.offset });
        return engine.detectDriftPage({ limit, offset }, a.envelope);
      },
    },
    "eights.evolution.reconcile_drift": {
      description: [
        "Drift reconciliation (WS10). Scans drifted resources and plans or applies remediation.",
        "dryRun defaults TRUE — returns planned actions without creating proposals.",
        "Set dryRun:false to create proposals (uses propose() only — NEVER commits; Run #11 commit gates still apply).",
        "SOURCE DRIFT → action=propose (or skip if proposal already pending).",
        "REGISTRY DRIFT (hash mismatch/missing) → action=surface (never mutated; possible tamper).",
        "CRITICAL/FROZEN resources → action=skip (no mutation ever).",
        "Returns { planned, total_drifts, applied, limit, offset, has_more }.",
      ].join(" "),
      schema: ReconcileDriftArgs,
      handler: async (a: z.infer<typeof ReconcileDriftArgs>) => {
        const { limit, offset } = clampPage({ limit: a.limit, offset: a.offset });
        return engine.reconcileDrift(a.envelope, { rid: a.rid, dryRun: a.dryRun, limit, offset });
      },
    },
  } as const;
}
