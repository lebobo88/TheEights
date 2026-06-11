/**
 * Operator capability token verifier — TheEights daemon.
 *
 * Canonical format is BYTE-IDENTICAL to Hydra hydra_core/auth/capability.py and
 * Xenia sign.py. The golden vectors in the tests prove interop.
 *
 * Token wire shape (EXACT — extra fields rejected):
 *   {
 *     v: 1,
 *     actor_id: string,
 *     actor_kind: "human",
 *     capability: string,
 *     resource_id: string,
 *     workflow_id: string,
 *     issued_at: integer (safe int, seconds),
 *     exp: integer (safe int, seconds),
 *     jti: string,   ← random UUID / 32-hex nonce; SIGNED; consumed for single-use replay prevention
 *     sig: { alg: "HMAC-SHA256", key_id: string, value: string }
 *          NOTE: degraded field MUST be absent when token is not degraded.
 *          A present `degraded:false` is rejected (degraded is only legitimately
 *          true on a degraded/null-sig token, which is itself always rejected).
 *   }
 *
 * Security hardening (fail-closed from the start):
 *   - Entire function body wrapped in try/catch → never throws, returns {valid:false, reason:"verification error"}.
 *   - token normalised via JSON.parse(JSON.stringify(token)) to kill hostile-object injection.
 *   - EXACT schema check BEFORE HMAC: extra payload fields rejected; v/actor_id/actor_kind/
 *     capability/workflow_id/resource_id/jti must be strings; issued_at/exp must be safe integers;
 *     sig fields exact; sig must be exactly {alg,key_id,value} — degraded field MUST be absent.
 *   - Bounded TTL: exp - issued_at <= MAX_TTL_SECONDS (86400).
 *   - issued_at <= now (no future-dated tokens; no skew allowance).
 *   - HMAC compared via crypto.timingSafeEqual on equal-length buffers.
 *   - Reason strings are static text — never interpolate token values.
 *   - Degraded (value:null) tokens always invalid — fail closed.
 *   - Missing HYDRA_OPERATOR_KEY → fail closed.
 *   - token.actor_id MUST equal env.actor_id (enforced by callers in requireOperatorCapability).
 *   - jti must be a non-empty string in the payload; single-use enforced by callers via
 *     consumed_capabilities table keyed by jti (not sig.value).
 *
 * canonicalJson key sort uses raw Unicode code-point order (matching Python's default str sort).
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// ---------- Constants ----------

/** Maximum token lifetime in seconds (24 h). Tokens with exp - issued_at > this are rejected. */
export const MAX_TTL_SECONDS = 86400;

// ---------- Allowed payload field sets ----------

const ALLOWED_PAYLOAD_KEYS = new Set([
  "v", "actor_id", "actor_kind", "capability",
  "resource_id", "workflow_id", "issued_at", "exp", "jti",
]);

// sig must be exactly these three fields when not degraded; degraded field must be absent.
const REQUIRED_SIG_KEYS = new Set(["alg", "key_id", "value"]);

// ---------- Canonical JSON (byte-identical to Python json.dumps sort_keys=True separators=(",",":") ensure_ascii=True) ----------

/** Escape a single JS string value using Python's ensure_ascii=True semantics. */
function ensureAsciiString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!;
    if (cp > 0xffff) {
      // Surrogate pair — encode as two \uXXXX escapes matching Python's behaviour.
      const hi = Math.floor((cp - 0x10000) / 0x400) + 0xd800;
      const lo = ((cp - 0x10000) % 0x400) + 0xdc00;
      out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
      i++; // skip the low surrogate
    } else if (cp > 0x7f) {
      out += `\\u${cp.toString(16).padStart(4, "0")}`;
    } else if (cp === 0x22) {
      out += '\\"';
    } else if (cp === 0x5c) {
      out += "\\\\";
    } else if (cp === 0x08) {
      out += "\\b";
    } else if (cp === 0x0c) {
      out += "\\f";
    } else if (cp === 0x0a) {
      out += "\\n";
    } else if (cp === 0x0d) {
      out += "\\r";
    } else if (cp === 0x09) {
      out += "\\t";
    } else if (cp < 0x20) {
      out += `\\u${cp.toString(16).padStart(4, "0")}`;
    } else {
      out += s[i];
    }
  }
  out += '"';
  return out;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/**
 * Produce canonical JSON: keys sorted by Unicode code-point order (matching
 * Python's default str sort — NOT locale-aware collation), compact separators,
 * ensure_ascii=True semantics. Numbers that are not safe integers are rejected
 * by callers before canonicalization; this function emits them as-is via JSON.stringify.
 */
export function canonicalJson(val: JsonValue): string {
  if (val === null) return "null";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") {
    return JSON.stringify(val);
  }
  if (typeof val === "string") {
    return ensureAsciiString(val);
  }
  if (Array.isArray(val)) {
    return "[" + val.map((v) => canonicalJson(v as JsonValue)).join(",") + "]";
  }
  // Plain object — sort keys by raw Unicode code-point order (Python str sort).
  const keys = Object.keys(val).sort((a, b) => {
    const la = [...a];
    const lb = [...b];
    const len = Math.min(la.length, lb.length);
    for (let i = 0; i < len; i++) {
      const ca = la[i]!.codePointAt(0)!;
      const cb = lb[i]!.codePointAt(0)!;
      if (ca !== cb) return ca - cb;
    }
    return la.length - lb.length;
  });
  const parts = keys.map((k) => ensureAsciiString(k) + ":" + canonicalJson((val as Record<string, JsonValue>)[k] as JsonValue));
  return "{" + parts.join(",") + "}";
}

// ---------- HMAC helpers ----------

/** Hex-decode a string, returning null if invalid. */
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

/** Derive the signing key from HYDRA_OPERATOR_KEY env var. Returns null if unset/invalid. */
function getSigningKey(): Buffer | null {
  const raw = process.env["HYDRA_OPERATOR_KEY"];
  if (!raw) return null;
  const hex = hexDecode(raw);
  if (hex !== null) return hex;
  return Buffer.from(raw, "utf8");
}

/** Configured key_id: HYDRA_OPERATOR_KEY_ID env var or "default". */
function getKeyId(): string {
  return process.env["HYDRA_OPERATOR_KEY_ID"] ?? "default";
}

/** Compute HMAC-SHA256(key, message) and return as base64url without padding. */
export function hmacSha256Base64url(key: Buffer, message: string): string {
  const raw = createHmac("sha256", key).update(message, "utf8").digest();
  return raw
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ---------- Token mint ----------

export interface CapabilityTokenPayload {
  v: number;
  actor_id: string;
  actor_kind: string;
  capability: string;
  resource_id: string;
  workflow_id: string;
  issued_at: number;
  exp: number;
  /** Random unique nonce (UUID or 32-hex). Included in the signed payload.
   *  Single-use replay prevention keys off jti (not sig.value). */
  jti: string;
}

export interface CapabilityToken extends CapabilityTokenPayload {
  sig: {
    alg: string;
    key_id: string;
    value: string | null;
    degraded?: true;
  };
}

/**
 * Mint a signed capability token. Throws if HYDRA_OPERATOR_KEY is unset.
 * key_id defaults to HYDRA_OPERATOR_KEY_ID env var or "default".
 * jti is auto-generated (randomUUID) if not provided in the payload.
 */
export function mintOperatorCapability(
  payload: Omit<CapabilityTokenPayload, "jti"> & { jti?: string },
  overrideKeyId?: string,
): CapabilityToken {
  const key = getSigningKey();
  if (!key) throw new Error("HYDRA_OPERATOR_KEY is not set — cannot mint capability token");
  const key_id = overrideKeyId ?? getKeyId();
  const fullPayload: CapabilityTokenPayload = {
    ...payload,
    jti: payload.jti ?? randomUUID(),
  };
  // Canonical bytes: exactly the payload fields (no sig), sorted by code-point key order.
  const canonical = canonicalJson(fullPayload as unknown as JsonValue);
  const value = hmacSha256Base64url(key, canonical);
  return { ...fullPayload, sig: { alg: "HMAC-SHA256", key_id, value } };
}

// ---------- Verifier ----------

export interface VerifyOptions {
  expectedCapability: string;
  expectedWorkflowId: string;
  expectedResourceId: string;
  /** Override now (seconds). Defaults to Date.now()/1000. */
  now?: number;
}

export interface VerifyResult {
  valid: boolean;
  reason: string;
  actor_id?: string | null;
  /** The jti claim from the verified token (present only when valid=true). */
  jti?: string;
}

/**
 * Verify an operator capability token.
 *
 * Returns {valid:false, reason:"verification error"} on ANY unexpected throw —
 * reason strings NEVER include token values (use static text / field names only).
 */
export function verifyOperatorCapability(
  rawToken: unknown,
  opts: VerifyOptions,
): VerifyResult {
  try {
    // Step 1: normalise via JSON round-trip to kill hostile-object injection.
    let token: unknown;
    try {
      token = JSON.parse(JSON.stringify(rawToken));
    } catch {
      return { valid: false, reason: "token not serialisable" };
    }

    // Step 2: token must be a plain (non-null, non-array) object.
    if (token === null || typeof token !== "object" || Array.isArray(token)) {
      return { valid: false, reason: "token must be a plain object" };
    }
    const t = token as Record<string, unknown>;

    // Step 3: sig must be a plain object.
    const sig = t["sig"];
    if (sig === null || typeof sig !== "object" || Array.isArray(sig)) {
      return { valid: false, reason: "sig must be a plain object" };
    }
    const s = sig as Record<string, unknown>;

    // Step 4: EXACT schema — reject extra payload fields (not in ALLOWED_PAYLOAD_KEYS + sig).
    for (const k of Object.keys(t)) {
      if (k !== "sig" && !ALLOWED_PAYLOAD_KEYS.has(k)) {
        return { valid: false, reason: "token contains unexpected field" };
      }
    }

    // Step 5: EXACT sig schema — must be exactly {alg, key_id, value}; degraded field
    // MUST be absent on a non-degraded token. A present `degraded:false` is rejected
    // because degraded is only legitimately present as `true` (on a degraded/null-sig
    // token, which is itself always invalid). Any extra sig fields are also rejected.
    for (const k of Object.keys(s)) {
      if (!REQUIRED_SIG_KEYS.has(k)) {
        // "degraded" present at all → reject (whether true or false or any value).
        return { valid: false, reason: "sig contains unexpected field" };
      }
    }

    // Step 6: degraded check — degraded tokens (value:null) are always invalid.
    // This is a belt-and-suspenders check after the schema rejection above.
    if (s["value"] === null) {
      return { valid: false, reason: "degraded token is not accepted" };
    }

    // Step 7: sig.value must be a string.
    if (typeof s["value"] !== "string") {
      return { valid: false, reason: "sig.value must be a string" };
    }
    const sigValue: string = s["value"];

    // Step 8: alg must be HMAC-SHA256.
    if (s["alg"] !== "HMAC-SHA256") {
      return { valid: false, reason: "unsupported sig.alg" };
    }

    // Step 9: operator key must be configured — fail closed if absent.
    // Checked BEFORE key_id match so a missing key surfaces as "operator key not configured"
    // rather than the misleading "sig.key_id does not match configured key".
    const key = getSigningKey();
    if (!key) {
      return { valid: false, reason: "operator key not configured" };
    }

    // Step 10: sig.key_id must be a string and must match the configured key_id.
    if (typeof s["key_id"] !== "string") {
      return { valid: false, reason: "sig.key_id must be a string" };
    }
    const configuredKeyId = getKeyId();
    if (s["key_id"] !== configuredKeyId) {
      return { valid: false, reason: "sig.key_id does not match configured key" };
    }

    // Step 11: validate all payload string fields before canonicalization.
    if (typeof t["actor_id"] !== "string" || typeof t["actor_kind"] !== "string" ||
        typeof t["capability"] !== "string" || typeof t["resource_id"] !== "string" ||
        typeof t["workflow_id"] !== "string") {
      return { valid: false, reason: "token string fields invalid" };
    }

    // Step 11b: jti must be a non-empty string.
    if (typeof t["jti"] !== "string" || (t["jti"] as string).length === 0) {
      return { valid: false, reason: "jti must be a non-empty string" };
    }
    const jti = t["jti"] as string;

    // Step 12: validate numeric fields — must be safe integers (no floats/NaN/Infinity).
    const issued_at = t["issued_at"];
    const exp = t["exp"];
    if (typeof issued_at !== "number" || !Number.isSafeInteger(issued_at)) {
      return { valid: false, reason: "issued_at must be a safe integer" };
    }
    if (typeof exp !== "number" || !Number.isSafeInteger(exp)) {
      return { valid: false, reason: "exp must be a safe integer" };
    }

    // Step 13: version must be exactly 1.
    if (t["v"] !== 1) {
      return { valid: false, reason: "unsupported token version" };
    }

    // Step 14: rebuild canonical payload and compute HMAC.
    // Only include the ALLOWED_PAYLOAD_KEYS fields (canonicalJson sorts by code point).
    const payload: Record<string, unknown> = {};
    for (const k of ALLOWED_PAYLOAD_KEYS) {
      if (k in t) payload[k] = t[k];
    }
    const canonical = canonicalJson(payload as unknown as JsonValue);
    const expected = hmacSha256Base64url(key, canonical);

    // Step 15: constant-time compare on equal-length buffers.
    const expectedBuf = Buffer.from(expected, "utf8");
    const actualBuf = Buffer.from(sigValue, "utf8");
    if (expectedBuf.length !== actualBuf.length) {
      return { valid: false, reason: "sig mismatch" };
    }
    if (!timingSafeEqual(expectedBuf, actualBuf)) {
      return { valid: false, reason: "sig mismatch" };
    }

    // --- Post-HMAC checks (HMAC verified; now validate semantic constraints) ---

    // Step 16: actor_id denylist.
    const actor_id = t["actor_id"] as string;
    if (actor_id === "" || actor_id === "unknown") {
      return { valid: false, reason: "invalid actor_id" };
    }

    // Step 17: actor_kind must be "human".
    if (t["actor_kind"] !== "human") {
      return { valid: false, reason: "actor_kind must be human" };
    }

    // Step 18: capability, workflow_id, resource_id must match expectations.
    if (t["capability"] !== opts.expectedCapability) {
      return { valid: false, reason: "capability mismatch" };
    }
    if (t["workflow_id"] !== opts.expectedWorkflowId) {
      return { valid: false, reason: "workflow_id mismatch" };
    }
    if (t["resource_id"] !== opts.expectedResourceId) {
      return { valid: false, reason: "resource_id mismatch" };
    }

    // Step 19: temporal checks.
    const nowSec = opts.now ?? Math.floor(Date.now() / 1000);

    // issued_at must not be in the future — no clock-skew grace.
    // Future-dated tokens are rejected outright to prevent pre-minting attacks.
    if (issued_at > nowSec) {
      return { valid: false, reason: "issued_at is in the future" };
    }

    // issued_at <= exp (sanity).
    if (issued_at > exp) {
      return { valid: false, reason: "issued_at after exp" };
    }

    // TTL must not exceed MAX_TTL_SECONDS.
    if (exp - issued_at > MAX_TTL_SECONDS) {
      return { valid: false, reason: "token TTL exceeds maximum" };
    }

    // Must not be expired.
    if (nowSec >= exp) {
      return { valid: false, reason: "token expired" };
    }

    // All checks passed.
    return { valid: true, reason: "ok", actor_id, jti };
  } catch {
    // Outer catch: any unexpected error returns a constant-string result.
    return { valid: false, reason: "verification error" };
  }
}
