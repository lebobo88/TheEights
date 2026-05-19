import { z } from "zod";
import { Envelope } from "../schemas/envelope.js";
import { Consumer } from "../schemas/resource.js";
import type { ConstitutionEngine } from "../engines/constitution.js";

export const GetArgs = z.object({
  envelope: Envelope,
  consumer: Consumer,
});

export const AttestArgs = z.object({
  envelope: Envelope,
  consumer: Consumer,
});

export const ProposeAmendmentArgs = z.object({
  envelope: Envelope,
  consumer: Consumer,
  draft: z.string().min(1),
  rationale: z.string().min(1),
  evidence_memory_ids: z.array(z.string()).optional(),
});

export function registerConstitutionTools(engine: ConstitutionEngine) {
  return {
    "eights.constitution.get": {
      description: "Read a consumer's constitution (Immortal Head). Returns text, version, content hash, and frozen flag.",
      schema: GetArgs,
      handler: async (a: z.infer<typeof GetArgs>) => engine.get(a.envelope, a.consumer),
    },
    "eights.constitution.attest": {
      description: "Bind a workflow run to the current constitution. Returns a hash-chained receipt; refuses if the resource is missing or drifted.",
      schema: AttestArgs,
      handler: async (a: z.infer<typeof AttestArgs>) => engine.attest(a.envelope, a.consumer),
    },
    "eights.constitution.propose_amendment": {
      description: "Queue an amendment to a consumer's constitution. Always HITL — never auto-commits. Requires operator unfreeze before approve().",
      schema: ProposeAmendmentArgs,
      handler: async (a: z.infer<typeof ProposeAmendmentArgs>) =>
        engine.proposeAmendment(a.envelope, a.consumer, a.draft, a.rationale, a.evidence_memory_ids),
    },
  } as const;
}
