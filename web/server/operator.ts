/**
 * Operator identity + CSRF for the Atlas governed write path.
 *
 * Two concerns, both SEPARATE from the read path:
 *
 *  1. The OPERATOR ENVELOPE — a distinct envelope used ONLY on the write POST
 *     endpoints. It is NOT the read-only `eights-atlas` envelope. It names the
 *     human operator (EIGHTS_OPERATOR_ACTOR_ID), domain `governance`, with a MINIMAL scope
 *     that grants exactly the governed evolution actions and nothing more. We do NOT
 *     broaden scope (Invariant #1): the scope is hard-coded here, server-side, and
 *     no request path can widen it.
 *
 *     When HYDRA_OPERATOR_KEY is configured on the server, the envelope is extended
 *     with a signed operator capability token (capability_token field). The token is
 *     minted SERVER-SIDE — the key NEVER touches the browser. The token's actor_id
 *     matches the operator's env.actor_id, actor_kind="human", short TTL (5 min).
 *     The token is bound to the specific action+resource being performed so it can
 *     only be used for that exact operation. Per Fix #5 (WS-AUTH).
 *
 *     If HYDRA_OPERATOR_KEY is not set, capability_token is omitted. The daemon will
 *     then fail-closed on any operator-only op that requires it. Document the
 *     HYDRA_OPERATOR_KEY env var as required in production.
 *
 *  2. The PER-SESSION CSRF TOKEN — a random token minted once at bridge startup.
 *     It is exposed ONLY to a same-origin caller via `GET /api/session` and MUST
 *     be presented as an `X-Atlas-Token` header on every write POST. A write
 *     without a valid token is refused 403 before any daemon call.
 */
import { randomBytes, randomUUID, timingSafeEqual, createHmac } from "node:crypto";

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
  /** Signed operator capability token. Present when HYDRA_OPERATOR_KEY is configured. */
  capability_token?: unknown;
}

// Single configured operator actor id — MUST match what daemon startup registers as kind='human'.
// EIGHTS_OPERATOR_ACTOR_ID defaults to "eights.operator" everywhere (daemon, CLI, web).
const OPERATOR_ACTOR_ID = process.env["EIGHTS_OPERATOR_ACTOR_ID"] ?? "eights.operator";

/**
 * Capability string for a given write tool name.
 * Maps Atlas write tools → the capability string the daemon verifies.
 */
function capabilityForTool(tool: string): string {
  switch (tool) {
    case "evolution.approve": return "evolution.approve";
    case "evolution.reject":  return "evolution.reject";
    case "evolution.rollback": return "evolution.rollback";
    case "evolution.unfreeze": return "evolution.unfreeze";
    // governance.hitl.resolve: the daemon verifies capability="hitl.resolve" (not the MCP tool name).
    // This mapping keeps the caller API ergonomic (pass the MCP tool name) while producing
    // the short capability string the daemon's requireOperatorCapability expects.
    case "governance.hitl.resolve": return "hitl.resolve";
    default: return tool;
  }
}

/**
 * Derive a resource_id binding for a given tool + args.
 *
 * - approve/reject: resource_id = proposal_id (token authorises this specific proposal)
 * - rollback: resource_id = rid@to_version (token authorises exactly that rollback target, Fix #6)
 * - unfreeze: resource_id = rid
 * - fallback: empty string (token will fail sig check if daemon expects something)
 */
function resourceIdForArgs(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "evolution.approve":
    case "evolution.reject":
      return typeof args["proposal_id"] === "string" ? args["proposal_id"] : "";
    case "evolution.rollback": {
      const rid = typeof args["rid"] === "string" ? args["rid"] : "";
      const to_version = typeof args["to_version"] === "string" ? args["to_version"] : "";
      return rid && to_version ? `${rid}@${to_version}` : rid;
    }
    case "evolution.unfreeze":
      return typeof args["rid"] === "string" ? args["rid"] : "";
    // governance.hitl.resolve: resource_id = request_id (the exact HITL row being resolved).
    case "governance.hitl.resolve":
      return typeof args["request_id"] === "string" ? args["request_id"] : "";
    default:
      return "";
  }
}

/**
 * workflow_id binding for a given tool + args.
 * hitlResolve uses run_id from the HITL row (not available server-side here), so we
 * fall back to request_id for hitl ops. For evolution ops the workflow_id equals the rid.
 */
function workflowIdForArgs(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "evolution.approve":
    case "evolution.reject":
      return typeof args["proposal_id"] === "string" ? args["proposal_id"] : "";
    case "evolution.rollback":
    case "evolution.unfreeze":
      return typeof args["rid"] === "string" ? args["rid"] : "";
    // governance.hitl.resolve: workflow_id = request_id (no run_id available server-side;
    // the daemon's GovernanceStateEngine.hitlResolve resolves run_id from the DB row,
    // which then becomes the actual workflowId in the requireOperatorCapability check).
    case "governance.hitl.resolve":
      return typeof args["request_id"] === "string" ? args["request_id"] : "";
    default:
      return "";
  }
}

/**
 * Attempt to mint a server-side capability token for the given tool + args.
 *
 * Returns the token object if HYDRA_OPERATOR_KEY is configured, or null if the key
 * is not set (non-fatal — the daemon will fail-closed for ops that require it).
 *
 * The key is read from the server environment ONLY — never from the request.
 * The token is bound to: actor_id=EIGHTS_OPERATOR_ACTOR_ID, actor_kind=human,
 * capability=<tool-specific>, resource_id=<derived from args>, workflow_id=<derived>,
 * short TTL (5 min).
 */
export function mintCapabilityForTool(
  tool: string,
  args: Record<string, unknown>,
): unknown | null {
  const raw = process.env["HYDRA_OPERATOR_KEY"];
  if (!raw) return null;
  try {
    // Dynamic import would be async; use a synchronous inline mint that mirrors
    // mintOperatorCapability from daemon/src/auth/capability.ts to avoid a
    // circular dep across the web/daemon package boundary at runtime.
    // We replicate only what we need: HMAC-SHA256 over canonicalJson payload,
    // base64url, and the token shape. This is intentionally minimal.
    const keyBuf = hexDecode(raw) ?? Buffer.from(raw, "utf8");
    const keyId = process.env["HYDRA_OPERATOR_KEY_ID"] ?? "default";
    const nowSec = Math.floor(Date.now() / 1000);
    const TTL = 300; // 5 minutes — short-lived per-action token
    const payload = {
      v: 1,
      actor_id: OPERATOR_ACTOR_ID,
      actor_kind: "human",
      capability: capabilityForTool(tool),
      resource_id: resourceIdForArgs(tool, args),
      workflow_id: workflowIdForArgs(tool, args),
      issued_at: nowSec,
      exp: nowSec + TTL,
      jti: randomUUID(), // random nonce; signed; consumed for single-use replay prevention
    };
    const canonical = webCanonicalJson(payload);
    const raw_hmac = createHmac("sha256", keyBuf).update(canonical, "utf8").digest();
    const value = raw_hmac
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return { ...payload, sig: { alg: "HMAC-SHA256", key_id: keyId, value } };
  } catch {
    // If mint fails for any reason (key decode error, etc.), return null and let
    // the daemon fail-closed. Never surface the key or error to the caller.
    return null;
  }
}

// ---------- Inline helpers ----------

function hexDecode(s: string): Buffer | null {
  if (s.length % 2 !== 0) return null;
  try {
    const b = Buffer.from(s, "hex");
    if (b.toString("hex") !== s.toLowerCase()) return null;
    return b;
  } catch {
    return null;
  }
}

/** Minimal canonical JSON matching canonicalJson from daemon/src/auth/capability.ts. */
function webEnsureAsciiStr(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!;
    if (cp > 0xffff) {
      const hi = Math.floor((cp - 0x10000) / 0x400) + 0xd800;
      const lo = ((cp - 0x10000) % 0x400) + 0xdc00;
      out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
      i++;
    } else if (cp > 0x7f) {
      out += `\\u${cp.toString(16).padStart(4, "0")}`;
    } else if (cp === 0x22) { out += '\\"';
    } else if (cp === 0x5c) { out += "\\\\";
    } else if (cp === 0x08) { out += "\\b";
    } else if (cp === 0x0c) { out += "\\f";
    } else if (cp === 0x0a) { out += "\\n";
    } else if (cp === 0x0d) { out += "\\r";
    } else if (cp === 0x09) { out += "\\t";
    } else if (cp < 0x20) { out += `\\u${cp.toString(16).padStart(4, "0")}`;
    } else { out += s[i]; }
  }
  out += '"';
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WJV = string | number | boolean | null | any[] | Record<string, any>;
function webCanonicalJson(val: WJV): string {
  if (val === null) return "null";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return JSON.stringify(val);
  if (typeof val === "string") return webEnsureAsciiStr(val);
  if (Array.isArray(val)) return "[" + (val as WJV[]).map(webCanonicalJson).join(",") + "]";
  const keys = Object.keys(val).sort((a, b) => {
    const la = [...a]; const lb = [...b];
    const len = Math.min(la.length, lb.length);
    for (let i = 0; i < len; i++) {
      const ca = la[i]!.codePointAt(0)!; const cb = lb[i]!.codePointAt(0)!;
      if (ca !== cb) return ca - cb;
    }
    return la.length - lb.length;
  });
  return "{" + keys.map((k) => webEnsureAsciiStr(k) + ":" + webCanonicalJson(val[k] as WJV)).join(",") + "}";
}

/**
 * Mint a server-side capability token scoped to a single hitl.resolve action.
 *
 * For hitl-only proposals Atlas must resolve the pending evolution.approve HITL row
 * BEFORE calling evolution.approve. This function mints the token explicitly so the
 * binding (capability="hitl.resolve", resource_id=requestId, workflow_id=requestId)
 * is correct without going through the generic capabilityForTool/resourceIdForArgs
 * dispatch (which would return empty strings for unknown tool names).
 *
 * Returns null if HYDRA_OPERATOR_KEY is not configured.
 */
export function mintHitlResolveCapability(requestId: string): unknown | null {
  return mintCapabilityForTool("governance.hitl.resolve", { request_id: requestId });
}

/**
 * The distinct OPERATOR envelope for the write path. MINIMAL scope — exactly the
 * governed evolution actions. Hard-coded here; no request path widens it
 * (Invariant #1). `trace_id` is fresh per action so each write is independently
 * traceable in the audit ledger under actor EIGHTS_OPERATOR_ACTOR_ID.
 *
 * When HYDRA_OPERATOR_KEY is set, mints a capability token bound to the specific
 * action+resource and attaches it as capability_token (Fix #5 / WS-AUTH).
 */
export function operatorEnvelope(tool?: string, args?: Record<string, unknown>): OperatorEnvelope {
  const base: OperatorEnvelope = {
    tenant_id: "local",
    actor_id: OPERATOR_ACTOR_ID,
    project_id: "TheEights",
    domain: "governance",
    scope: ["evolution.approve", "evolution.reject", "evolution.rollback"],
    trace_id: `atlas_op_${Date.now()}_${randomBytes(4).toString("hex")}`,
  };
  if (tool && args) {
    const capToken = mintCapabilityForTool(tool, args);
    if (capToken !== null) {
      base.capability_token = capToken;
    }
  }
  return base;
}
