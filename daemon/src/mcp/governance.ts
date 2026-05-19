import { z } from "zod";
import { Envelope } from "../schemas/envelope.js";
import type { PolicyEngine } from "../engines/policy.js";
import type { GovernanceStateEngine } from "../engines/governance-state.js";
import type { RedactionEngine } from "../engines/redaction.js";

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

export const BudgetChargeArgs = z.object({
  envelope: Envelope,
  run_id: z.string(),
  cost_usd: z.number().nonnegative(),
  tokens: z.number().int().nonnegative().optional(),
});
export const CeilingTickArgs = z.object({
  envelope: Envelope,
  run_id: z.string(),
  kind: z.enum(["iteration", "depth", "failure"]),
  delta: z.number().int().positive().default(1),
});
export const CapSetArgs = z.object({
  envelope: Envelope,
  run_id: z.string(),
  kind: z.enum(["budget", "iteration", "depth", "failure"]),
  cap: z.number().positive(),
});
export const HitlRequestArgs = z.object({
  envelope: Envelope,
  run_id: z.string().optional(),
  kind: z.string(),
  payload: z.unknown(),
});
export const HitlResolveArgs = z.object({
  envelope: Envelope,
  request_id: z.string(),
  decision: z.enum(["approved", "rejected"]),
  note: z.unknown().optional(),
});
export const HitlListArgs = z.object({
  envelope: Envelope,
  status: z.enum(["pending", "approved", "rejected", "expired"]).default("pending"),
});
export const BreakerArgs = z.object({
  envelope: Envelope,
  node_id: z.string(),
});
export const BreakerOutcomeArgs = z.object({
  envelope: Envelope,
  node_id: z.string(),
  outcome: z.enum(["success", "failure"]),
});
export const RedactForSquadArgs = z.object({
  envelope: Envelope,
  target_squad: z.string(),
  payload: z.unknown(),
});

export function registerGovernanceTools(
  policy: PolicyEngine,
  gov?: GovernanceStateEngine,
  redaction?: RedactionEngine,
) {
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
    ...(gov ? {
      "eights.governance.budget.charge": {
        description: "Charge USD against a run's budget. Returns proceed | downgrade (≥80%) | block (≥100%). Durable across daemon restart.",
        schema: BudgetChargeArgs,
        handler: async (a: z.infer<typeof BudgetChargeArgs>) => gov.budgetCharge(a.envelope, a.run_id, a.cost_usd, a.tokens),
      },
      "eights.governance.ceiling.tick": {
        description: "Tick a loop ceiling (iteration | depth | failure). Returns proceed | warn (≥80%) | block | trip.",
        schema: CeilingTickArgs,
        handler: async (a: z.infer<typeof CeilingTickArgs>) => gov.ceilingTick(a.envelope, a.run_id, a.kind, a.delta),
      },
      "eights.governance.cap.set": {
        description: "Set or update a per-run cap (budget USD, iteration count, depth, failure). Operators call at workflow intake.",
        schema: CapSetArgs,
        handler: async (a: z.infer<typeof CapSetArgs>) => gov.setCap(a.envelope, a.run_id, a.kind, a.cap),
      },
      "eights.governance.hitl.request": {
        description: "Open a durable HITL request. Survives daemon restart; surfaces to operator UI via hitl.list.",
        schema: HitlRequestArgs,
        handler: async (a: z.infer<typeof HitlRequestArgs>) => gov.hitlRequest(a.envelope, { run_id: a.run_id, kind: a.kind, payload: a.payload }),
      },
      "eights.governance.hitl.resolve": {
        description: "Resolve a pending HITL request (approved | rejected). Records resolver + note in audit chain.",
        schema: HitlResolveArgs,
        handler: async (a: z.infer<typeof HitlResolveArgs>) => gov.hitlResolve(a.envelope, a.request_id, a.decision, a.note),
      },
      "eights.governance.hitl.list": {
        description: "List HITL requests, default status=pending. Operator UI calls this on every tick.",
        schema: HitlListArgs,
        handler: async (a: z.infer<typeof HitlListArgs>) => gov.hitlList(a.envelope, a.status),
      },
      "eights.governance.breaker.status": {
        description: "Current consecutive-failure count + tripped flag for a supervisor node.",
        schema: BreakerArgs,
        handler: async (a: z.infer<typeof BreakerArgs>) => gov.breakerStatus(a.node_id),
      },
      "eights.governance.breaker.outcome": {
        description: "Record a success|failure outcome for a node. 3 consecutive failures → tripped (per Hydra manifesto).",
        schema: BreakerOutcomeArgs,
        handler: async (a: z.infer<typeof BreakerOutcomeArgs>) => gov.breakerOutcome(a.envelope, a.node_id, a.outcome),
      },
      "eights.governance.breaker.reset": {
        description: "Operator-signed reset of a tripped breaker. Audited.",
        schema: BreakerArgs,
        handler: async (a: z.infer<typeof BreakerArgs>) => gov.breakerReset(a.envelope, a.node_id),
      },
    } : {}),
    ...(redaction ? {
      "eights.governance.redact_for_squad": {
        description: "Apply the target squad's redaction policy to a cross-squad payload. Strips scoped fields, runs PII patterns, optionally blocks envelope types.",
        schema: RedactForSquadArgs,
        handler: async (a: z.infer<typeof RedactForSquadArgs>) => redaction.redactForSquad(a.envelope, a.target_squad, a.payload),
      },
    } : {}),
  } as const;
}
