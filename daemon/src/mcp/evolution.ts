import { z } from "zod";
import { Envelope } from "../schemas/envelope.js";
import { ResourceKind, RiskClass, EvolutionPolicy, Consumer, WritebackMode } from "../schemas/resource.js";
import type { EvolutionEngine } from "../engines/evolution.js";

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
});

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
export const GetResourceArgs = z.object({ rid: z.string() });
export const ListResourcesArgs = z.object({
  consumer: Consumer.optional(),
  kind: ResourceKind.optional(),
  risk: RiskClass.optional(),
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
      description: "Get a resource by rid.",
      schema: GetResourceArgs,
      handler: async (a: z.infer<typeof GetResourceArgs>) => engine.getResource(a.rid),
    },
    "eights.evolution.list_resources": {
      description: "List resources, optionally filtered by consumer / kind / risk.",
      schema: ListResourcesArgs,
      handler: async (a: z.infer<typeof ListResourcesArgs>) => engine.listResources(a),
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
      description: "List proposals awaiting evaluation or HITL approval.",
      schema: Empty,
      handler: async () => engine.listPending(),
    },
    "eights.evolution.detect_drift": {
      description: "Drift scan over both ~/.eights/resources and registered consumer source_paths.",
      schema: Empty,
      handler: async () => engine.detectDrift(),
    },
  } as const;
}
