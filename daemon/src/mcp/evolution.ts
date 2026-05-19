import { z } from "zod";
import { Envelope } from "../schemas/envelope.js";
import { ResourceKind, RiskClass, EvolutionPolicy } from "../schemas/resource.js";
import type { EvolutionEngine } from "../engines/evolution.js";

export const RegisterArgs = z.object({
  envelope: Envelope,
  rid: z.string(),
  kind: ResourceKind,
  risk_class: RiskClass,
  evolution_policy: EvolutionPolicy.optional(),
  initial_content: z.string(),
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
export const GetResourceArgs = z.object({ rid: z.string() });
export const ListPendingArgs = z.object({});
export const DetectDriftArgs = z.object({});

export function registerEvolutionTools(engine: EvolutionEngine) {
  return {
    "eights.evolution.register": {
      description: "Register a new resource (RSPL).",
      schema: RegisterArgs,
      handler: async (a: z.infer<typeof RegisterArgs>) =>
        engine.register(a.envelope, { rid: a.rid, kind: a.kind, risk_class: a.risk_class, evolution_policy: a.evolution_policy, initial_content: a.initial_content }),
    },
    "eights.evolution.get_resource": {
      description: "Get a resource by rid.",
      schema: GetResourceArgs,
      handler: async (a: z.infer<typeof GetResourceArgs>) => engine.getResource(a.rid),
    },
    "eights.evolution.propose": {
      description: "Propose a new version of a resource.",
      schema: ProposeArgs,
      handler: async (a: z.infer<typeof ProposeArgs>) =>
        engine.propose(a.envelope, { rid: a.rid, candidate_content: a.candidate_content, justification: a.justification, evidence_memory_ids: a.evidence_memory_ids }),
    },
    "eights.evolution.evaluate": {
      description: "Run the eval suite against a pending proposal; produces an EvaluationReport.",
      schema: EvalArgs,
      handler: async (a: z.infer<typeof EvalArgs>) => engine.evaluate(a.envelope, a.proposal_id),
    },
    "eights.evolution.commit": {
      description: "Attempt commit. Auto-commits if resource is 'auto' and eval_delta>=0; otherwise queues for HITL.",
      schema: CommitArgs,
      handler: async (a: z.infer<typeof CommitArgs>) => engine.commit(a.envelope, a.proposal_id),
    },
    "eights.evolution.approve": {
      description: "Operator approval — forces commit on hitl-only resources.",
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
    "eights.evolution.list_pending": {
      description: "List proposals awaiting evaluation or HITL approval.",
      schema: ListPendingArgs,
      handler: async () => engine.listPending(),
    },
    "eights.evolution.detect_drift": {
      description: "Scan resources for on-disk vs. recorded hash drift.",
      schema: DetectDriftArgs,
      handler: async () => engine.detectDrift(),
    },
  } as const;
}
