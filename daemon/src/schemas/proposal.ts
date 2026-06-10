import { z } from "zod";

export const ProposalStatus = z.enum([
  "pending",
  "evaluating",
  "approved",
  "rejected",
  "committed",
  "rolled_back",
]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const EvaluationReport = z.object({
  proposal_id: z.string(),
  eval_delta: z.number(),                          // ≥ 0 required for auto-commit
  metric_scores: z.record(z.string(), z.number()),
  ssgm_gate_results: z.object({
    consistency: z.object({ passed: z.boolean(), conflicts: z.array(z.string()) }),
    temporal_decay: z.object({ passed: z.boolean(), reason: z.string().optional() }),
    access_control: z.object({ passed: z.boolean(), reason: z.string().optional() }),
  }),
  notes: z.string().optional(),
  /** True when the registry found no adapter for (kind, consumer). Callers
   *  (commit, approve) treat this as a hard block regardless of eval_delta
   *  (TE-EV-2). */
  evaluator_missing: z.boolean().optional(),
});
export type EvaluationReport = z.infer<typeof EvaluationReport>;

export const Proposal = z.object({
  proposal_id: z.string(),
  resource_rid: z.string(),
  candidate_version: z.string(),
  candidate_content: z.string(),
  justification: z.string(),
  evidence_memory_ids: z.array(z.string()).default([]),
  proposed_by: z.string(),
  proposed_at: z.string(),
  status: ProposalStatus,
  evaluation: EvaluationReport.optional(),
  decided_at: z.string().optional(),
  decided_by: z.string().optional(),
});
export type Proposal = z.infer<typeof Proposal>;
