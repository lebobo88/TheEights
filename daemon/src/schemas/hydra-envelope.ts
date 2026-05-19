/**
 * Lightweight Zod port of hydra_core/schemas.py — enough to validate the
 * envelope shell (discriminator, IDs, refs, constraints) while keeping the
 * type-specific bodies as passthrough JSON.
 *
 * This is intentionally permissive: TheEights stores envelopes; it does not
 * re-type the manifesto. Hydra remains the source of truth for the union.
 */
import { z } from "zod";
import { MemoryHandle } from "./memory-handle.js";

export const HydraEnvelopeType = z.enum([
  "C_SUITE_DECISION_PACKET",
  "PRD",
  "ArchRFC",
  "DevTask",
  "CreativeBrief",
  "ShotList",
  "AssetJob",
  "DecisionRecord",
  "HITLRequest",
  "Handoff",
]);
export type HydraEnvelopeType = z.infer<typeof HydraEnvelopeType>;

export const HydraConstraints = z.object({
  budget_usd: z.number().nullable().optional(),
  token_limit: z.number().int().nullable().optional(),
  deadline_ts: z.string().nullable().optional(),
  risk_tolerance: z.enum(["low", "medium", "high"]).default("medium"),
  priority: z.enum(["P0", "P1", "P2", "P3"]).default("P2"),
  industries: z.array(z.string()).default([]),
}).partial().passthrough();

export const HydraContextRef = z.union([
  z.string(), // raw handle URI
  z.object({
    tier: z.enum(["ephemeral", "episodic", "semantic", "profile"]).optional(),
    key: z.string(),
    summary: z.string().nullable().optional(),
    cells: z.array(z.string()).default([]),
    handle: MemoryHandle.optional(),
  }).passthrough(),
]);

export const HydraEnvelope = z.object({
  id: z.string(),
  type: HydraEnvelopeType,
  origin_squad: z.string(),
  target_squad: z.string().nullable().optional(),
  workflow_id: z.string(),
  parent_id: z.string().nullable().optional(),
  context_refs: z.array(HydraContextRef).default([]),
  constraints: HydraConstraints.optional(),
  created_at: z.string().optional(),
}).passthrough();
export type HydraEnvelope = z.infer<typeof HydraEnvelope>;
