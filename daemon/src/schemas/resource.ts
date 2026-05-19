import { z } from "zod";

export const ResourceKind = z.enum([
  "prompt",
  "team",
  "rubric",
  "tool",
  "workflow",
  "schema",
  "policy",
  "agent",       // agent persona (.md)
  "skill",       // skill SKILL.md
  "command",     // slash command (.md)
  "hook",        // lifecycle hook script
  "contract",    // AGENTS.md / CLAUDE.md class
  "constitution",// user-covenant Immortal Head (Hydra manifesto)
  "squad",       // Hydra squad (routing + budget + risk_tolerance bundle)
  "redaction_policy", // per-squad redaction matrix
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

export const Consumer = z.enum(["eights", "pp", "hydra", "execsuite", "rlm"]);
export type Consumer = z.infer<typeof Consumer>;

export const WritebackMode = z.enum([
  "in-place+branch",   // default: write file + commit on theeights/auto side-branch
  "in-place",          // write file only; no git
  "pr",                // open a real PR (heavyweight)
  "none",              // record only; consumer reads from ~/.eights/resources/
]);
export type WritebackMode = z.infer<typeof WritebackMode>;

/** ADR-0006 — default mapping; can be overridden per-resource. */
export const DEFAULT_EVOLUTION_POLICY: Record<RiskClass, EvolutionPolicy> = {
  low: "auto",
  medium: "hitl-only",
  high: "hitl-only",
  critical: "frozen",
};

export const ResourceVersion = z.object({
  version: z.string(),
  content: z.string(),
  signature: z.string(),
  created_at: z.string(),
  created_by: z.string(),
  justification: z.string().optional(),
  evidence_memory_ids: z.array(z.string()).default([]),
});
export type ResourceVersion = z.infer<typeof ResourceVersion>;

export const ResourceSource = z.object({
  source_path: z.string(),
  consumer: Consumer,
  writeback_mode: WritebackMode,
  last_written_version: z.string().optional(),
  last_written_at: z.string().optional(),
});
export type ResourceSource = z.infer<typeof ResourceSource>;

export const Resource = z.object({
  rid: z.string(),
  kind: ResourceKind,
  risk_class: RiskClass,
  current_version: z.string(),
  evolution_policy: EvolutionPolicy,
  versions: z.array(ResourceVersion),
  audit_url: z.string(),
  /** Consumer that owns this resource (eights for internal seeds). */
  consumer: Consumer.default("eights"),
  /** Absolute filesystem paths in the consumer's repo that mirror this resource. */
  sources: z.array(ResourceSource).default([]),
});
export type Resource = z.infer<typeof Resource>;
