/**
 * Lightweight Zod port of hydra_core/schemas.py — enough to validate the
 * envelope shell (discriminator, IDs, refs, constraints) while keeping the
 * type-specific bodies as passthrough JSON.
 *
 * This is intentionally permissive: TheEights stores envelopes; it does not
 * re-type the manifesto. Hydra remains the source of truth for the union.
 *
 * Phase 3b: UPPER_SNAKE is the canonical vocabulary. CamelCase legacy values
 * are accepted via normalizeHydraEnvelopeType but emit a deprecation warning.
 */
import { z } from "zod";
import { MemoryHandle } from "./memory-handle.js";

/**
 * Map of legacy CamelCase envelope type values → canonical UPPER_SNAKE equivalents.
 * Pair-programmer still emits CamelCase until its Phase 3c change lands.
 */
export const CAMEL_TO_UPPER_SNAKE: Readonly<Record<string, string>> = {
  ArchRFC: "ARCH_RFC",
  DevTask: "DEV_TASK",
  CreativeBrief: "CREATIVE_BRIEF",
  ShotList: "SHOT_LIST",
  AssetJob: "ASSET_JOB",
  HITLRequest: "HITL_REQUEST",
  DecisionRecord: "DECISION_RECORD",
  Handoff: "HANDOFF",
};

/**
 * Normalize a raw HydraEnvelopeType value: CamelCase → UPPER_SNAKE.
 * Logs a pino-compatible deprecation warning to stderr when a legacy value is
 * encountered. Unknown values are passed through unchanged (Zod will reject them).
 *
 * Applied as a z.preprocess on the `type` field of HydraEnvelope so all intake
 * seams benefit automatically — no per-caller wrapping required.
 */
export function normalizeHydraEnvelopeType(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const mapped = CAMEL_TO_UPPER_SNAKE[raw];
  if (mapped !== undefined) {
    // Emit pino-compatible JSON to stderr; avoids log-file init and stays
    // usable in test environments without the daemon's log infrastructure.
    process.stderr.write(
      JSON.stringify({
        level: 40,
        time: Date.now(),
        msg: `[eights] HydraEnvelopeType "${raw}" is deprecated; use "${mapped}" (UPPER_SNAKE is canonical from Phase 3b)`,
      }) + "\n",
    );
    return mapped;
  }
  return raw;
}

/**
 * Canonical 11-member UPPER_SNAKE vocabulary (Phase 3b).
 * COCKPIT_WRITE is new — Hydra cockpit audit envelopes routed to TheEights.
 */
export const HydraEnvelopeType = z.enum([
  "C_SUITE_DECISION_PACKET",
  "PRD",
  "ARCH_RFC",
  "DEV_TASK",
  "CREATIVE_BRIEF",
  "SHOT_LIST",
  "ASSET_JOB",
  "HITL_REQUEST",
  "DECISION_RECORD",
  "HANDOFF",
  "COCKPIT_WRITE",
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
  // z.preprocess applies normalizeHydraEnvelopeType before the enum check so
  // legacy CamelCase values (emitted by pair-programmer pre-Phase-3c) are
  // silently promoted to UPPER_SNAKE at every intake seam.
  type: z.preprocess(normalizeHydraEnvelopeType, HydraEnvelopeType),
  origin_squad: z.string(),
  target_squad: z.string().nullable().optional(),
  workflow_id: z.string(),
  parent_id: z.string().nullable().optional(),
  context_refs: z.array(HydraContextRef).default([]),
  constraints: HydraConstraints.optional(),
  created_at: z.string().optional(),
}).passthrough();
export type HydraEnvelope = z.infer<typeof HydraEnvelope>;
