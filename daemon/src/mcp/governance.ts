import { z } from "zod";
import { Envelope } from "../schemas/envelope.js";
import type { PolicyEngine } from "../engines/policy.js";

export const PolicyEvaluateArgs = z.object({
  envelope: Envelope,
  action: z.string(),
});
export const ConsistencyCheckArgs = z.object({
  envelope: Envelope,
  candidate: z.object({
    content: z.string(),
    type: z.string(),
    scopes: z.array(z.string()).default([]),
    supersedes: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(0.5),
  }),
});
export const AccessCheckArgs = z.object({
  envelope: Envelope,
  target_scopes: z.array(z.string()),
});
export const RedactArgs = z.object({
  text: z.string(),
});

export function registerGovernanceTools(policy: PolicyEngine) {
  return {
    "eights.governance.policy.evaluate": {
      description: "Evaluate a proposed action against the active policy set.",
      schema: PolicyEvaluateArgs,
      handler: async (a: z.infer<typeof PolicyEvaluateArgs>) => policy.policyEvaluate(a.action, a.envelope),
    },
    "eights.governance.consistency_check": {
      description: "SSGM Gate 1 — check candidate memory for contradiction with existing high-confidence memories.",
      schema: ConsistencyCheckArgs,
      handler: async (a: z.infer<typeof ConsistencyCheckArgs>) =>
        policy.consistencyCheck(a.envelope, a.candidate),
    },
    "eights.governance.access.check": {
      description: "SSGM Gate 3 / LASM — verify actor scope set covers required target scopes.",
      schema: AccessCheckArgs,
      handler: async (a: z.infer<typeof AccessCheckArgs>) =>
        policy.accessCheck(a.envelope, a.target_scopes),
    },
    "eights.governance.redact": {
      description: "Run redaction patterns over arbitrary text. Use at the MCP boundary on retrieved content destined for low-trust actors.",
      schema: RedactArgs,
      handler: async (a: z.infer<typeof RedactArgs>) => policy.redact(a.text),
    },
  } as const;
}
