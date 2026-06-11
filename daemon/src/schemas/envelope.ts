import { z } from "zod";

/**
 * Envelope — accompanies every MCP call. Enforced at the handler boundary.
 * See ARCHITECTURE.md §4.1.
 */
export const Envelope = z.object({
  tenant_id: z.string().min(1).default("local"),
  actor_id: z.string().min(1),
  project_id: z.string().min(1),
  domain: z.string().min(1),
  scope: z.array(z.string()).default([]),
  trace_id: z.string().min(1),
  parent_trace_id: z.string().optional(),
  /**
   * Operator capability token — required for operator-only governance ops
   * (hitl.resolve, evolution.approve/unfreeze/rollback, breaker.reset).
   * Verified via auth/capability.ts:verifyOperatorCapability.
   * Most envelopes do not carry one; the operator-only ops enforce its presence.
   */
  capability_token: z.unknown().optional(),
});

export type Envelope = z.infer<typeof Envelope>;
