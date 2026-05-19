import { z } from "zod";

export const ResourceKind = z.enum([
  "prompt",
  "team",
  "rubric",
  "tool",
  "workflow",
  "schema",
  "policy",
]);
export type ResourceKind = z.infer<typeof ResourceKind>;

export const RiskClass = z.enum(["low", "medium", "high", "critical"]);
export type RiskClass = z.infer<typeof RiskClass>;

export const EvolutionPolicy = z.enum([
  "auto",
  "auto-low-risk",
  "hitl-only",
  "frozen",
]);
export type EvolutionPolicy = z.infer<typeof EvolutionPolicy>;

/** ADR-0006 — default mapping; can be overridden per-resource. */
export const DEFAULT_EVOLUTION_POLICY: Record<RiskClass, EvolutionPolicy> = {
  low: "auto",
  medium: "hitl-only",
  high: "hitl-only",
  critical: "frozen",
};

export const ResourceVersion = z.object({
  version: z.string(),               // content hash
  content: z.string(),
  signature: z.string(),
  created_at: z.string(),
  created_by: z.string(),
  justification: z.string().optional(),
  evidence_memory_ids: z.array(z.string()).default([]),
});
export type ResourceVersion = z.infer<typeof ResourceVersion>;

export const Resource = z.object({
  rid: z.string(),
  kind: ResourceKind,
  risk_class: RiskClass,
  current_version: z.string(),
  evolution_policy: EvolutionPolicy,
  versions: z.array(ResourceVersion),
  audit_url: z.string(),
});
export type Resource = z.infer<typeof Resource>;
