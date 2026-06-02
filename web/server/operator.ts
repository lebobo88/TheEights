/**
 * Operator identity + CSRF for the Atlas governed write path.
 *
 * Two concerns, both SEPARATE from the read path:
 *
 *  1. The OPERATOR ENVELOPE — a distinct envelope used ONLY on the write POST
 *     endpoints. It is NOT the read-only `eights-atlas` envelope. It names the
 *     human operator (`operator-rob`), domain `governance`, with a MINIMAL scope
 *     that grants exactly the three evolution actions and nothing more. We do NOT
 *     broaden scope (Invariant #1): the scope is hard-coded here, server-side, and
 *     no request path can widen it. The operator action IS the operator-signed
 *     override that Invariant #5 requires for non-`low` risk classes — and the
 *     CSRF token below is what proves the action came from the same-origin,
 *     in-browser operator and not a cross-origin/unauthenticated caller.
 *
 *  2. The PER-SESSION CSRF TOKEN — a random token minted once at bridge startup.
 *     It is exposed ONLY to a same-origin caller via `GET /api/session` and MUST
 *     be presented as an `X-Atlas-Token` header on every write POST. A write
 *     without a valid token is refused 403 before any daemon call.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

/* ---- per-session CSRF token ---- */

// Minted once, at module load (bridge startup). A new token every process start
// means a stale tab cannot replay a write against a freshly-restarted bridge.
const SESSION_TOKEN = randomBytes(32).toString("hex");

/** The current session's CSRF token (exposed to same-origin via /api/session). */
export function sessionToken(): string {
  return SESSION_TOKEN;
}

/**
 * Constant-time compare of a presented token against the session token. Returns
 * false for any missing/mismatched/wrong-length input without leaking timing.
 */
export function verifyToken(presented: string | undefined | null): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(SESSION_TOKEN, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ---- operator envelope ---- */

export interface OperatorEnvelope {
  tenant_id: string;
  actor_id: string;
  project_id: string;
  domain: string;
  scope: string[];
  trace_id: string;
}

/**
 * The distinct OPERATOR envelope for the write path. MINIMAL scope — exactly the
 * three governed evolution actions. Hard-coded here; no request path widens it
 * (Invariant #1). `trace_id` is fresh per action so each write is independently
 * traceable in the audit ledger under actor `operator-rob`.
 */
export function operatorEnvelope(): OperatorEnvelope {
  return {
    tenant_id: "local",
    actor_id: "operator-rob",
    project_id: "TheEights",
    domain: "governance",
    scope: ["evolution.approve", "evolution.reject", "evolution.rollback"],
    trace_id: `atlas_op_${Date.now()}_${randomBytes(4).toString("hex")}`,
  };
}
