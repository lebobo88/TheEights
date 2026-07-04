import { z } from "zod";
import { Envelope } from "../schemas/envelope.js";
import { HydraEnvelope, normalizeHydraEnvelopeType } from "../schemas/hydra-envelope.js";
import type { HydraEngine } from "../engines/hydra.js";

export const RecordArgs = z.object({
  envelope: Envelope,
  hydra_envelope: HydraEnvelope,
});

export const QueryArgs = z.object({
  envelope: Envelope,
  workflow_id: z.string().optional(),
  // z.preprocess mirrors the record seam: legacy CamelCase query params
  // (e.g. type='DevTask') are promoted to UPPER_SNAKE before hitting SQL so
  // queries issued during the Phase 3b migration window match normalised rows.
  type: z.preprocess(normalizeHydraEnvelopeType, z.string().optional()),
  target_squad: z.string().optional(),
  origin_squad: z.string().optional(),
  since: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export const HandoffArgs = z.object({
  envelope: Envelope,
  workflow_id: z.string(),
});

export function registerHydraTools(engine: HydraEngine) {
  return {
    "eights.hydra.envelope.record": {
      description: "Durable, audited, semantically-indexed record of a HydraEnvelope (C_SUITE_DECISION_PACKET | PRD | ARCH_RFC | DEV_TASK | CREATIVE_BRIEF | SHOT_LIST | ASSET_JOB | HITL_REQUEST | DECISION_RECORD | HANDOFF | COCKPIT_WRITE). Legacy CamelCase types are accepted with a deprecation warning (Phase 3b migration window).",
      schema: RecordArgs,
      handler: async (a: z.infer<typeof RecordArgs>) => engine.record(a.envelope, a.hydra_envelope),
    },
    "eights.hydra.envelope.query": {
      description: "Query past Hydra envelopes by workflow / type / squad / time. Used by supervisors to retrieve precedent at synthesis phase.",
      schema: QueryArgs,
      handler: async (a: z.infer<typeof QueryArgs>) => engine.query(a.envelope, {
        workflow_id: a.workflow_id, type: a.type,
        target_squad: a.target_squad, origin_squad: a.origin_squad,
        since: a.since, limit: a.limit,
      }),
    },
    "eights.hydra.handoff.list": {
      description: "Every cross-squad HANDOFF envelope in a workflow, oldest first.",
      schema: HandoffArgs,
      handler: async (a: z.infer<typeof HandoffArgs>) => engine.listHandoffs(a.envelope, a.workflow_id),
    },
  } as const;
}
