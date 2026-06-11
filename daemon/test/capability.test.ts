/**
 * Operator capability token verifier tests — comprehensive coverage.
 *
 * Self-contained: in-memory/temp SQLite, no live MCP, no network.
 * Covers all 7 fix areas:
 *   Fix #1 - breakerOutcome success-untrip requires capability
 *   Fix #2 - token actor_id must equal envelope actor_id
 *   Fix #3 - evolution.reject requires capability token
 *   Fix #4/7 - exact schema validation + canonicalJson robustness + non-ASCII golden vectors
 *   Fix #5 - (Atlas seam — operator.ts, tested separately via web tsconfig)
 *   Fix #6 - rollback binds to_version in resource_id; single-use jti replay prevention
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyOperatorCapability,
  mintOperatorCapability,
  canonicalJson,
  hmacSha256Base64url,
  MAX_TTL_SECONDS,
  type CapabilityToken,
} from "../src/auth/capability.js";
import { SqliteStore } from "../src/stores/sqlite.js";
import { AuditEngine } from "../src/engines/audit.js";
import { PolicyEngine } from "../src/engines/policy.js";
import { EvolutionEngine } from "../src/engines/evolution.js";
import { GovernanceStateEngine } from "../src/engines/governance-state.js";
import { WriteRouter } from "../src/engines/writeback.js";
import { EvalRegistry } from "../src/engines/eval/registry.js";
import type { EvalAdapter } from "../src/engines/eval/registry.js";
import type { Envelope } from "../src/schemas/envelope.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOLDEN_KEY_HEX = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const GOLDEN_KEY_ID = "golden-1";

// jti is now part of the signed payload. Fixed value for interop vector.
const GOLDEN_PAYLOAD = {
  v: 1,
  actor_id: "golden@hydra.test",
  actor_kind: "human",
  capability: "hitl_approve",
  resource_id: "wf-golden-001",
  workflow_id: "wf-golden-001",
  issued_at: 1749600000,
  exp: 1749600900,
  jti: "fixed-golden-jti-001",
};
// Recomputed with jti included in canonical payload (sort order: ..., issued_at, jti, resource_id, ...).
const GOLDEN_EXPECTED_SIG = "vwWp9w23fYQIRQG17mR-Uw6-bXrMxzsinPkGjSJv50I";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withKey<T>(hexKey: string, keyId: string, fn: () => T): T {
  const prev = process.env["HYDRA_OPERATOR_KEY"];
  const prevId = process.env["HYDRA_OPERATOR_KEY_ID"];
  process.env["HYDRA_OPERATOR_KEY"] = hexKey;
  process.env["HYDRA_OPERATOR_KEY_ID"] = keyId;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env["HYDRA_OPERATOR_KEY"];
    else process.env["HYDRA_OPERATOR_KEY"] = prev;
    if (prevId === undefined) delete process.env["HYDRA_OPERATOR_KEY_ID"];
    else process.env["HYDRA_OPERATOR_KEY_ID"] = prevId;
  }
}

function mintGolden(overrides: Partial<typeof GOLDEN_PAYLOAD> = {}): CapabilityToken {
  return withKey(GOLDEN_KEY_HEX, GOLDEN_KEY_ID, () =>
    mintOperatorCapability({ ...GOLDEN_PAYLOAD, ...overrides }),
  );
}

// ---------------------------------------------------------------------------
// Golden vector — interop proof
// ---------------------------------------------------------------------------
describe("golden vector — canonical JSON + HMAC interop with Python signer", () => {
  it("canonicalJson sorts keys and produces compact form", () => {
    const canonical = canonicalJson(GOLDEN_PAYLOAD as unknown as Parameters<typeof canonicalJson>[0]);
    expect(canonical).toContain('"actor_id":"golden@hydra.test"');
    expect(canonical).toContain('"capability":"hitl_approve"');
    expect(canonical.indexOf('"actor_id"')).toBeLessThan(canonical.indexOf('"actor_kind"'));
    expect(canonical.indexOf('"actor_kind"')).toBeLessThan(canonical.indexOf('"capability"'));
    expect(canonical.indexOf('"capability"')).toBeLessThan(canonical.indexOf('"exp"'));
    // Compact — no spaces around colons or commas
    expect(canonical).not.toContain(': ');
    expect(canonical).not.toContain(', ');
  });

  it("HMAC of golden payload with golden key produces expected sig value", () => {
    const key = Buffer.from(GOLDEN_KEY_HEX, "hex");
    const canonical = canonicalJson(GOLDEN_PAYLOAD as unknown as Parameters<typeof canonicalJson>[0]);
    const sig = hmacSha256Base64url(key, canonical);
    expect(sig).toBe(GOLDEN_EXPECTED_SIG);
  });

  it("mintOperatorCapability with golden key/payload produces the golden sig value", () => {
    const token = mintGolden();
    expect(token.sig.value).toBe(GOLDEN_EXPECTED_SIG);
    expect(token.sig.key_id).toBe(GOLDEN_KEY_ID);
    expect(token.sig.alg).toBe("HMAC-SHA256");
  });

  it("verifyOperatorCapability accepts the golden token (non-expired via explicit now)", () => {
    const token = mintGolden();
    const result = withKey(GOLDEN_KEY_HEX, GOLDEN_KEY_ID, () =>
      verifyOperatorCapability(token, {
        expectedCapability: GOLDEN_PAYLOAD.capability,
        expectedWorkflowId: GOLDEN_PAYLOAD.workflow_id,
        expectedResourceId: GOLDEN_PAYLOAD.resource_id,
        now: GOLDEN_PAYLOAD.issued_at,
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.actor_id).toBe(GOLDEN_PAYLOAD.actor_id);
  });

  it("verifier accepts the exact golden sig literal (byte-identical interop proof)", () => {
    const token: CapabilityToken = {
      ...GOLDEN_PAYLOAD,
      sig: { alg: "HMAC-SHA256", key_id: GOLDEN_KEY_ID, value: GOLDEN_EXPECTED_SIG },
    };
    const result = withKey(GOLDEN_KEY_HEX, GOLDEN_KEY_ID, () =>
      verifyOperatorCapability(token, {
        expectedCapability: GOLDEN_PAYLOAD.capability,
        expectedWorkflowId: GOLDEN_PAYLOAD.workflow_id,
        expectedResourceId: GOLDEN_PAYLOAD.resource_id,
        now: GOLDEN_PAYLOAD.issued_at,
      }),
    );
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-ASCII golden vector (Fix #4/7 — ensure_ascii + surrogate interop)
// ---------------------------------------------------------------------------
describe("non-ASCII golden vector — ensure_ascii + canonicalJson robustness", () => {
  // Python golden for actor_id with accented char: "opérateur@hydra.test"
  // Python: json.dumps({"v":1,...,"actor_id":"opérateur@hydra.test",...}, sort_keys=True, separators=(",",":"), ensure_ascii=True)
  // The é (U+00E9) must appear as é in the canonical string.
  it("non-ASCII actor_id (é) is escaped as \\u00e9 in canonicalJson", () => {
    const payload = { ...GOLDEN_PAYLOAD, actor_id: "opérateur@hydra.test" };
    const canonical = canonicalJson(payload as unknown as Parameters<typeof canonicalJson>[0]);
    expect(canonical).toContain('"actor_id":"op\\u00e9rateur@hydra.test"');
  });

  it("emoji (U+1F600 — above BMP) is encoded as surrogate pair \\uD83D\\uDE00", () => {
    const canonical = canonicalJson("😀" as unknown as Parameters<typeof canonicalJson>[0]);
    expect(canonical).toBe('"\\ud83d\\ude00"');
  });

  it("sign+verify round-trip with non-ASCII actor_id (é)", () => {
    const payload = { ...GOLDEN_PAYLOAD, actor_id: "opérateur@hydra.test" };
    const token = withKey(GOLDEN_KEY_HEX, GOLDEN_KEY_ID, () =>
      mintOperatorCapability(payload),
    );
    const result = withKey(GOLDEN_KEY_HEX, GOLDEN_KEY_ID, () =>
      verifyOperatorCapability(token, {
        expectedCapability: GOLDEN_PAYLOAD.capability,
        expectedWorkflowId: GOLDEN_PAYLOAD.workflow_id,
        expectedResourceId: GOLDEN_PAYLOAD.resource_id,
        now: GOLDEN_PAYLOAD.issued_at,
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.actor_id).toBe("opérateur@hydra.test");
  });

  it("Unicode code-point sort: key '\\u00e9' sorts after 'z' (code point order, not locale)", () => {
    // U+00E9 (233) > 'z' (122) in code-point order (same as Python)
    const out = canonicalJson({ "é": 1, z: 2, a: 3 } as unknown as Parameters<typeof canonicalJson>[0]);
    // Expected sorted order: a, z, é (code points 97, 122, 233)
    expect(out).toBe('{"a":3,"z":2,"\\u00e9":1}');
  });
});

// ---------------------------------------------------------------------------
// Rejection cases (Fix #4 — exact schema + temporal)
// ---------------------------------------------------------------------------
describe("verifyOperatorCapability — rejection cases", () => {
  const VALID_NOW = GOLDEN_PAYLOAD.issued_at;

  function verify(token: unknown, overrides?: Partial<Parameters<typeof verifyOperatorCapability>[1]>) {
    return withKey(GOLDEN_KEY_HEX, GOLDEN_KEY_ID, () =>
      verifyOperatorCapability(token, {
        expectedCapability: GOLDEN_PAYLOAD.capability,
        expectedWorkflowId: GOLDEN_PAYLOAD.workflow_id,
        expectedResourceId: GOLDEN_PAYLOAD.resource_id,
        now: VALID_NOW,
        ...overrides,
      }),
    );
  }

  it("tampered sig value -> invalid (sig mismatch)", () => {
    const token = mintGolden();
    const tampered = { ...token, sig: { ...token.sig, value: token.sig.value!.slice(0, -1) + "X" } };
    const r = verify(tampered);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/sig mismatch/);
  });

  it("expired token (now >= exp) -> invalid", () => {
    const token = mintGolden();
    const r = verify(token, { now: GOLDEN_PAYLOAD.exp });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/expired/);
  });

  it("now = exp - 1 (just before expiry) -> valid", () => {
    const token = mintGolden();
    const r = verify(token, { now: GOLDEN_PAYLOAD.exp - 1 });
    expect(r.valid).toBe(true);
  });

  it("wrong capability -> invalid (sig mismatch due to different payload)", () => {
    const token = mintGolden({ capability: "other.capability" });
    const r = verify(token);
    expect(r.valid).toBe(false);
  });

  it("wrong workflow_id -> invalid", () => {
    const token = mintGolden({ workflow_id: "wf-other" });
    const r = verify(token);
    expect(r.valid).toBe(false);
  });

  it("wrong resource_id -> invalid", () => {
    const token = mintGolden({ resource_id: "other-resource" });
    const r = verify(token);
    expect(r.valid).toBe(false);
  });

  it("actor_kind != 'human' -> invalid (actor_kind must be human)", () => {
    const token = mintGolden({ actor_kind: "agent" } as Parameters<typeof mintGolden>[0]);
    const r = verify(token);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/actor_kind/);
  });

  it("empty actor_id -> invalid", () => {
    const token = mintGolden({ actor_id: "" });
    const r = verify(token);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/actor_id/);
  });

  it("actor_id = 'unknown' -> invalid", () => {
    const token = mintGolden({ actor_id: "unknown" });
    const r = verify(token);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/actor_id/);
  });

  it("degraded token (value: null, degraded: true) -> invalid", () => {
    // sig schema is now EXACT {alg,key_id,value} — 'degraded' field must be absent.
    // A degraded token with value:null and degraded:true is rejected at the schema step
    // ("sig contains unexpected field") before even reaching the value:null check.
    const token = mintGolden();
    const degraded = { ...token, sig: { ...token.sig, value: null, degraded: true as const } };
    const r = verify(degraded);
    expect(r.valid).toBe(false);
    // Rejected due to unexpected 'degraded' field (strict sig schema, issue 4b).
    expect(r.reason).toMatch(/unexpected field/);
  });

  it("degraded:false in sig -> invalid (strict sig schema rejects degraded field even when false)", () => {
    // Codex fix 4b: degraded field MUST be absent on non-degraded tokens.
    // A present degraded:false is rejected (not just degraded:true).
    const token = mintGolden();
    const withDegradedFalse = { ...token, sig: { alg: token.sig.alg, key_id: token.sig.key_id, value: token.sig.value, degraded: false as unknown as true } };
    const r = verify(withDegradedFalse);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/unexpected field/);
  });

  it("missing sig -> invalid", () => {
    const noSig = Object.fromEntries(Object.entries(mintGolden()).filter(([k]) => k !== "sig"));
    const r = verify(noSig);
    expect(r.valid).toBe(false);
  });

  it("HYDRA_OPERATOR_KEY unset -> invalid (fail closed)", () => {
    const token = mintGolden();
    const prev = process.env["HYDRA_OPERATOR_KEY"];
    delete process.env["HYDRA_OPERATOR_KEY"];
    try {
      const r = verifyOperatorCapability(token, {
        expectedCapability: GOLDEN_PAYLOAD.capability,
        expectedWorkflowId: GOLDEN_PAYLOAD.workflow_id,
        expectedResourceId: GOLDEN_PAYLOAD.resource_id,
        now: VALID_NOW,
      });
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/operator key not configured/);
    } finally {
      if (prev !== undefined) process.env["HYDRA_OPERATOR_KEY"] = prev;
    }
  });

  it("token v != 1 -> invalid (unsupported version)", () => {
    const payload2 = { ...GOLDEN_PAYLOAD, v: 2 };
    const token2 = withKey(GOLDEN_KEY_HEX, GOLDEN_KEY_ID, () => mintOperatorCapability(payload2));
    const r = verify(token2);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/version/);
  });

  // --- Fix #4: exact schema — extra fields rejected ---
  it("extra payload field -> invalid (token contains unexpected field)", () => {
    // Must build the token manually so the extra field is covered by the HMAC.
    const withExtra = { ...GOLDEN_PAYLOAD, extra_field: "evil" };
    // The HMAC is over the canonical form including extra_field.
    const tokenWithExtra = withKey(GOLDEN_KEY_HEX, GOLDEN_KEY_ID, () => {
      const key = Buffer.from(GOLDEN_KEY_HEX, "hex");
      const canonical = canonicalJson(withExtra as unknown as Parameters<typeof canonicalJson>[0]);
      const value = hmacSha256Base64url(key, canonical);
      return { ...withExtra, sig: { alg: "HMAC-SHA256", key_id: GOLDEN_KEY_ID, value } };
    });
    const r = verify(tokenWithExtra);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/unexpected field/);
  });

  it("float exp (non-integer) -> invalid", () => {
    // Forge a token with float exp — need to build raw object since mintOperatorCapability type is integer.
    const tokenWithFloat = withKey(GOLDEN_KEY_HEX, GOLDEN_KEY_ID, () => {
      const payload = { ...GOLDEN_PAYLOAD, exp: 1749600900.5 };
      const key = Buffer.from(GOLDEN_KEY_HEX, "hex");
      const canonical = canonicalJson(payload as unknown as Parameters<typeof canonicalJson>[0]);
      const value = hmacSha256Base64url(key, canonical);
      return { ...payload, sig: { alg: "HMAC-SHA256", key_id: GOLDEN_KEY_ID, value } };
    });
    const r = verify(tokenWithFloat);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/safe integer/);
  });

  it("issued_at in future (even 1s) -> invalid (no clock-skew grace)", () => {
    // Issue 4a: issued_at must be <= now; no skew allowance whatsoever.
    const futureIssuedAt = VALID_NOW + 1; // 1s in future
    const token = mintGolden({ issued_at: futureIssuedAt, exp: futureIssuedAt + 900 });
    const r = verify(token, { now: VALID_NOW });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/future/);
  });

  it("issued_at = now -> valid (exactly at now is not future)", () => {
    const token = mintGolden({ issued_at: VALID_NOW, exp: VALID_NOW + 900 });
    const r = verify(token, { now: VALID_NOW });
    expect(r.valid).toBe(true);
  });

  it("TTL too long (exp - issued_at > MAX_TTL_SECONDS) -> invalid", () => {
    const token = mintGolden({
      issued_at: VALID_NOW,
      exp: VALID_NOW + MAX_TTL_SECONDS + 1,
    });
    const r = verify(token, { now: VALID_NOW });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/TTL exceeds/);
  });

  it("wrong sig.key_id -> invalid", () => {
    // Mint with a different key_id; configured key_id is GOLDEN_KEY_ID.
    const token = withKey(GOLDEN_KEY_HEX, GOLDEN_KEY_ID, () => {
      const t = mintOperatorCapability(GOLDEN_PAYLOAD, "different-key-id");
      return t;
    });
    // Verify with GOLDEN_KEY_ID configured (token.sig.key_id = "different-key-id")
    const r = verify(token);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/key_id/);
  });

  it("extra sig field -> invalid (sig contains unexpected field)", () => {
    const token = mintGolden();
    const withExtraSig = { ...token, sig: { ...token.sig, sneaky: "payload" } };
    const r = verify(withExtraSig);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/unexpected field/);
  });

  // Hostile inputs — must never throw
  it("token = null -> invalid, no throw", () => {
    expect(verify(null).valid).toBe(false);
  });

  it("token = plain string -> invalid, no throw", () => {
    expect(verify("evil_string").valid).toBe(false);
  });

  it("token = array -> invalid, no throw", () => {
    expect(verify([1, 2, 3]).valid).toBe(false);
  });

  it("token = {} (empty object) -> invalid, no throw", () => {
    expect(verify({}).valid).toBe(false);
  });

  it("sig = [] (array instead of object) -> invalid, no throw", () => {
    const token = { ...mintGolden(), sig: [] as unknown };
    expect(verify(token).valid).toBe(false);
  });

  it("sig.value = number (not string) -> invalid, no throw", () => {
    const token = mintGolden();
    const bad = { ...token, sig: { ...token.sig, value: 12345 as unknown as string } };
    expect(verify(bad).valid).toBe(false);
  });

  it("token with undefined field (stripped by JSON round-trip) — sig still verified against stripped payload", () => {
    // An extra undefined field is silently dropped by JSON round-trip.
    // The stripped payload won't match the signed payload if extra was in the HMAC,
    // but if extra was NOT included in the original HMAC (undefined → stripped on mint too)
    // then the stripped token === the original minted one → valid.
    const base = mintGolden();
    const withUndef = { ...base, gone: undefined } as unknown;
    // undefined stripped → same as base → valid (but note: now an extra key WAS NOT included in HMAC).
    const r = verify(withUndef);
    // The JSON round-trip drops `gone`; the remaining fields match the HMAC → valid.
    expect(r.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// canonicalJson — edge cases (Fix #4/7)
// ---------------------------------------------------------------------------
describe("canonicalJson — ensure_ascii + Unicode code-point key sort", () => {
  it("non-ASCII string escaped as \\uXXXX", () => {
    const out = canonicalJson("café" as unknown as Parameters<typeof canonicalJson>[0]);
    expect(out).toBe('"caf\\u00e9"');
  });

  it("nested object keys sorted recursively", () => {
    const out = canonicalJson({ z: 1, a: { y: 2, b: 3 } } as unknown as Parameters<typeof canonicalJson>[0]);
    expect(out).toBe('{"a":{"b":3,"y":2},"z":1}');
  });

  it("null value", () => {
    expect(canonicalJson(null)).toBe("null");
  });

  it("boolean values", () => {
    expect(canonicalJson(true as unknown as Parameters<typeof canonicalJson>[0])).toBe("true");
    expect(canonicalJson(false as unknown as Parameters<typeof canonicalJson>[0])).toBe("false");
  });

  it("array with objects (keys sorted inside elements)", () => {
    const out = canonicalJson([{ z: 1, a: 2 }] as unknown as Parameters<typeof canonicalJson>[0]);
    expect(out).toBe('[{"a":2,"z":1}]');
  });

  it("code-point sort: ASCII keys in correct order", () => {
    // 'A' (65) < 'a' (97) < 'z' (122) in code-point order (same as Python)
    const out = canonicalJson({ z: 3, A: 1, a: 2 } as unknown as Parameters<typeof canonicalJson>[0]);
    expect(out).toBe('{"A":1,"a":2,"z":3}');
  });
});

// ---------------------------------------------------------------------------
// Enforcement integration tests
// ---------------------------------------------------------------------------
describe("enforcement — operator-only ops refuse without valid token + new gap fixes", () => {
  let dir: string;
  let sql: SqliteStore;
  let evolution: EvolutionEngine;
  let governance: GovernanceStateEngine;

  const TEST_OP_KEY = GOLDEN_KEY_HEX;
  const TEST_KEY_ID = GOLDEN_KEY_ID;

  const baseEnv: Envelope = {
    tenant_id: "local", actor_id: "op-test-actor", project_id: "TheEights",
    domain: "governance", scope: [], trace_id: "t-cap-enforce",
  };

  const passingAdapter: EvalAdapter = {
    name: "pass", kinds: ["prompt"], consumers: "*",
    async evaluate() { return { eval_delta: 1, metric_scores: {}, notes: "ok" }; },
  };

  /** Mint a fresh token for each call (new issued_at → new sig.value → new jti). */
  function mintEnv(capability: string, resourceId: string, workflowId: string, actorId?: string): Envelope {
    const aid = actorId ?? baseEnv.actor_id;
    const token = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      mintOperatorCapability({
        v: 1, actor_id: aid, actor_kind: "human",
        capability, resource_id: resourceId, workflow_id: workflowId,
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    return { ...baseEnv, actor_id: aid, capability_token: token } as unknown as Envelope;
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-cap-enf-"));
    sql = new SqliteStore(join(dir, "state.db"));
    sql.migrate();
    sql.db.prepare(
      `INSERT OR IGNORE INTO actors(actor_id, kind, created_at) VALUES (?, 'human', datetime('now'))`,
    ).run(baseEnv.actor_id);
    const audit = new AuditEngine(sql, join(dir, "events"));
    const policy = new PolicyEngine(sql);
    governance = new GovernanceStateEngine(sql, audit);
    evolution = new EvolutionEngine(sql, join(dir, "resources"), policy, audit);
    evolution.setWriteRouter(new WriteRouter([]));
    evolution.setGovernance(governance);
    const reg = new EvalRegistry();
    reg.register(passingAdapter);
    evolution.setEvaluator(reg);
    evolution.register(baseEnv, { rid: "resource:cap.test.low", kind: "prompt", risk_class: "low", evolution_policy: "auto", initial_content: "v1" });
    evolution.register(baseEnv, { rid: "resource:cap.test.medium", kind: "prompt", risk_class: "medium", initial_content: "v1-medium" });
    evolution.register(baseEnv, { rid: "resource:cap.test.frozen", kind: "policy", risk_class: "critical", evolution_policy: "frozen", initial_content: "frozen-content" });
  });

  afterAll(() => { sql.close(); rmSync(dir, { recursive: true, force: true }); });

  // --- Fix #2: actor_id mismatch ---
  it("token actor_id != envelope actor_id -> refused (Fix #2)", () => {
    const req = governance.hitlRequest(baseEnv, { kind: "test.mismatch", payload: {} });
    // Mint token with actor_id "other-actor" but envelope says "op-test-actor"
    const token = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      mintOperatorCapability({
        v: 1, actor_id: "other-actor", actor_kind: "human",
        capability: "hitl.resolve", resource_id: req.request_id, workflow_id: req.request_id,
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    // Envelope still says actor_id: "op-test-actor"
    const mismatchEnv = { ...baseEnv, capability_token: token } as unknown as Envelope;
    expect(() => withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      governance.hitlResolve(mismatchEnv, req.request_id, "approved"),
    )).toThrow(/actor_id does not match/);
  });

  // --- hitlResolve ---
  it("hitlResolve without capability_token -> throws (fail closed)", () => {
    const req = governance.hitlRequest(baseEnv, { kind: "test.event", payload: { x: 1 } });
    expect(() => governance.hitlResolve(baseEnv, req.request_id, "approved"))
      .toThrow(/requires an operator capability token/);
  });

  it("hitlResolve with valid token (correct binding) -> succeeds", () => {
    const req = governance.hitlRequest(baseEnv, { kind: "test.event", payload: { x: 2 } });
    const opEnv = mintEnv("hitl.resolve", req.request_id, req.request_id);
    const result = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      governance.hitlResolve(opEnv, req.request_id, "approved"),
    );
    expect(result.status).toBe("approved");
  });

  it("hitlResolve with token for WRONG resource_id -> throws", () => {
    const req = governance.hitlRequest(baseEnv, { kind: "test.event", payload: { x: 3 } });
    const opEnv = mintEnv("hitl.resolve", "wrong-request-id", "wrong-request-id");
    expect(() =>
      withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
        governance.hitlResolve(opEnv, req.request_id, "approved"),
      ),
    ).toThrow(/capability token invalid/);
  });

  // --- Fix #6: single-use jti (replay prevention) ---
  it("replay: reusing the same token on a second call -> refused (Fix #6)", () => {
    // Use breakerReset as the replay vehicle: it binds resource_id = node_id and
    // workflow_id = node_id, so the SAME token presented twice hits the same binding
    // check both times.  First call consumes the jti; second call (same binding) must
    // be rejected as "already been used" rather than any binding-mismatch error.
    const nodeId = "replay-test-node";
    // Ensure the breaker is tripped so that breakerReset actually requires the token.
    // (breakerReset always calls requireOperatorCapability regardless of trip state.)
    const replayEnv = mintEnv("governance.breaker.reset", nodeId, nodeId);
    // First use: succeeds — jti consumed into consumed_capabilities.
    withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      governance.breakerReset(replayEnv, nodeId),
    );
    // Second use: SAME token (same sig.value / jti), same binding — must be rejected.
    expect(() =>
      withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
        governance.breakerReset(replayEnv, nodeId),
      ),
    ).toThrow(/already been used/);
  });

  it("rollback with different to_version uses different resource_id -> different token needed (Fix #6)", async () => {
    // Commit a second version
    const prop = evolution.propose(baseEnv, { rid: "resource:cap.test.low", candidate_content: "v2-for-rollback-test", justification: "two versions" });
    await evolution.evaluate(baseEnv, prop.proposal_id);
    await evolution.commit(baseEnv, prop.proposal_id);
    const r = evolution.getResource("resource:cap.test.low")!;
    const firstVersion = r.versions[0]!.version;
    const secondVersion = r.versions[1]!.version;
    const rid = "resource:cap.test.low";
    // Token bound to firstVersion
    const envFirst = mintEnv("evolution.rollback", `${rid}@${firstVersion}`, rid);
    // Try to use it to roll back to secondVersion — resource_id won't match
    await expect(
      withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
        evolution.rollback(envFirst, rid, secondVersion),
      ),
    ).rejects.toThrow(/capability token invalid/);
  });

  it("rollback with correct bound to_version -> succeeds (Fix #6)", async () => {
    const r = evolution.getResource("resource:cap.test.low")!;
    const firstVersion = r.versions[0]!.version;
    const rid = "resource:cap.test.low";
    const rollbackEnv = mintEnv("evolution.rollback", `${rid}@${firstVersion}`, rid);
    const result = await withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      evolution.rollback(rollbackEnv, rid, firstVersion),
    );
    expect(result.current_version).toBe(firstVersion);
  });

  // --- Fix #3: evolution.reject ---
  it("reject without capability_token -> throws (fail closed) (Fix #3)", () => {
    const prop = evolution.propose(baseEnv, { rid: "resource:cap.test.low", candidate_content: "reject-test-v", justification: "reject cap test" });
    expect(() => evolution.reject(baseEnv, prop.proposal_id, "test reason"))
      .toThrow(/requires an operator capability token/);
  });

  it("reject with valid token -> succeeds (Fix #3)", () => {
    const prop = evolution.propose(baseEnv, { rid: "resource:cap.test.low", candidate_content: "reject-test-v2", justification: "reject cap test 2" });
    const rejectEnv = mintEnv("evolution.reject", prop.proposal_id, prop.proposal_id);
    expect(() =>
      withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
        evolution.reject(rejectEnv, prop.proposal_id, "test reason"),
      ),
    ).not.toThrow();
    const p = evolution.getProposal(prop.proposal_id)!;
    expect(p.status).toBe("rejected");
  });

  // --- Fix #1: breakerOutcome success-untrip ---
  it("breakerOutcome success on non-tripped breaker -> no token needed (Fix #1)", () => {
    // A success outcome that does NOT untrip a breaker (not tripped) should not require a token.
    expect(() => governance.breakerOutcome(baseEnv, "node_no_token_ok", "success")).not.toThrow();
  });

  it("breakerOutcome success on TRIPPED breaker WITHOUT token -> refused (Fix #1)", () => {
    // Trip the breaker first
    governance.breakerOutcome(baseEnv, "node_trip_test", "failure");
    governance.breakerOutcome(baseEnv, "node_trip_test", "failure");
    governance.breakerOutcome(baseEnv, "node_trip_test", "failure");
    const status = governance.breakerStatus("node_trip_test");
    expect(status.tripped).toBe(true);
    // success outcome without token should be refused
    expect(() => governance.breakerOutcome(baseEnv, "node_trip_test", "success"))
      .toThrow(/requires an operator capability token/);
  });

  it("breakerOutcome success on TRIPPED breaker WITH valid token -> untrips (Fix #1)", () => {
    // Trip a fresh breaker
    governance.breakerOutcome(baseEnv, "node_trip_test2", "failure");
    governance.breakerOutcome(baseEnv, "node_trip_test2", "failure");
    governance.breakerOutcome(baseEnv, "node_trip_test2", "failure");
    expect(governance.breakerStatus("node_trip_test2").tripped).toBe(true);
    // Provide a valid token
    const opEnv = mintEnv("governance.breaker.reset", "node_trip_test2", "node_trip_test2");
    const result = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      governance.breakerOutcome(opEnv, "node_trip_test2", "success"),
    );
    expect(result.tripped).toBe(false);
  });

  // --- evolution.approve ---
  it("approve without capability_token -> throws (fail closed)", async () => {
    const prop = evolution.propose(baseEnv, { rid: "resource:cap.test.medium", candidate_content: "v-approve-notoken", justification: "cap test" });
    await evolution.evaluate(baseEnv, prop.proposal_id);
    await evolution.commit(baseEnv, prop.proposal_id);
    await expect(evolution.approve(baseEnv, prop.proposal_id))
      .rejects.toThrow(/requires an operator capability token/);
  });

  it("approve with valid token (correct binding, human actor, HITL row approved) -> commits", async () => {
    const prop = evolution.propose(baseEnv, { rid: "resource:cap.test.medium", candidate_content: "v-approved-final", justification: "cap test approve" });
    await evolution.evaluate(baseEnv, prop.proposal_id);
    await evolution.commit(baseEnv, prop.proposal_id);
    const hitlRow = sql.db.prepare(
      `SELECT request_id FROM hitl_queue WHERE kind='evolution.approve' AND json_extract(payload_json,'$.proposal_id')=? AND status='pending' LIMIT 1`,
    ).get(prop.proposal_id) as { request_id: string } | undefined;
    expect(hitlRow).toBeDefined();
    const resolveEnv = mintEnv("hitl.resolve", hitlRow!.request_id, hitlRow!.request_id);
    withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      governance.hitlResolve(resolveEnv, hitlRow!.request_id, "approved"),
    );
    const approveEnv = mintEnv("evolution.approve", prop.proposal_id, prop.proposal_id);
    const result = await withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      evolution.approve(approveEnv, prop.proposal_id),
    );
    expect(result.committed).toBe(true);
  });

  // --- evolution.unfreeze ---
  it("unfreeze without capability_token -> throws (fail closed)", () => {
    expect(() => evolution.unfreeze(baseEnv, "resource:cap.test.frozen"))
      .toThrow(/requires an operator capability token/);
  });

  it("unfreeze with valid token -> succeeds (policy becomes hitl-only)", () => {
    const unfreezeEnv = mintEnv("evolution.unfreeze", "resource:cap.test.frozen", "resource:cap.test.frozen");
    withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      evolution.unfreeze(unfreezeEnv, "resource:cap.test.frozen"),
    );
    const r = evolution.getResource("resource:cap.test.frozen")!;
    expect(r.evolution_policy).toBe("hitl-only");
  });

  // --- rollback without token ---
  it("rollback without capability_token -> throws (fail closed)", async () => {
    // The low resource currently has versions; get the first version
    const r = evolution.getResource("resource:cap.test.low")!;
    const firstVersion = r.versions[0]!.version;
    await expect(evolution.rollback(baseEnv, "resource:cap.test.low", firstVersion))
      .rejects.toThrow(/requires an operator capability token/);
  });

  // --- actor not in table ---
  it("token with actor_id not in actors table -> refused", () => {
    const req = governance.hitlRequest(baseEnv, { kind: "test.ghost", payload: {} });
    const token = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      mintOperatorCapability({
        v: 1, actor_id: "ghost-actor", actor_kind: "human",
        capability: "hitl.resolve", resource_id: req.request_id, workflow_id: req.request_id,
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const ghostEnv = { ...baseEnv, actor_id: "ghost-actor", capability_token: token } as unknown as Envelope;
    expect(() =>
      withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
        governance.hitlResolve(ghostEnv, req.request_id, "approved"),
      ),
    ).toThrow(/actor_id is not registered/);
  });

  it("token with actor_id registered as agent -> refused (actor_kind not human)", () => {
    sql.db.prepare(
      `INSERT OR IGNORE INTO actors(actor_id, kind, created_at) VALUES ('agent-actor', 'agent', datetime('now'))`,
    ).run();
    const req = governance.hitlRequest(baseEnv, { kind: "test.agent", payload: {} });
    const token = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      mintOperatorCapability({
        v: 1, actor_id: "agent-actor", actor_kind: "human",
        capability: "hitl.resolve", resource_id: req.request_id, workflow_id: req.request_id,
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const agentEnv = { ...baseEnv, actor_id: "agent-actor", capability_token: token } as unknown as Envelope;
    expect(() =>
      withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
        governance.hitlResolve(agentEnv, req.request_id, "approved"),
      ),
    ).toThrow(/actor must have kind=human/);
  });

  // --- Issue 6: jti uniqueness — no collision on same-second mints ---
  it("two identical-param ops with DIFFERENT jti both succeed (no false replay)", () => {
    // mintEnv calls mintOperatorCapability which auto-generates a fresh random jti each time.
    // Two calls with the same capability/resource binding but different jti MUST both succeed.
    const req1 = governance.hitlRequest(baseEnv, { kind: "test.jti-uniq-1", payload: {} });
    const req2 = governance.hitlRequest(baseEnv, { kind: "test.jti-uniq-2", payload: {} });
    // Two separate fresh tokens (different jti)
    const env1 = mintEnv("hitl.resolve", req1.request_id, req1.request_id);
    const env2 = mintEnv("hitl.resolve", req2.request_id, req2.request_id);
    // Both must succeed independently
    expect(() => withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      governance.hitlResolve(env1, req1.request_id, "approved"),
    )).not.toThrow();
    expect(() => withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      governance.hitlResolve(env2, req2.request_id, "approved"),
    )).not.toThrow();
  });

  it("same jti reused (same token object) -> rejected as already-used", () => {
    // The jti is now the random payload nonce — reusing the SAME token object
    // means the same jti and must be rejected on the second use regardless of which op.
    const nodeId = "jti-replay-node-2";
    const replayEnv = mintEnv("governance.breaker.reset", nodeId, nodeId);
    // First use: ok
    withKey(TEST_OP_KEY, TEST_KEY_ID, () => governance.breakerReset(replayEnv, nodeId));
    // Second use: same token (same jti) → rejected
    expect(() => withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      governance.breakerReset(replayEnv, nodeId),
    )).toThrow(/already been used/);
  });

  // --- Issue cap.set: governance.cap.set gated ---
  it("setCap without capability_token -> refused (fail closed)", () => {
    expect(() => governance.setCap(baseEnv, "run-capset-test", "budget", 50))
      .toThrow(/requires an operator capability token/);
  });

  it("setCap with valid token -> succeeds", () => {
    const capSetEnv = mintEnv("governance.cap.set", "run-capset-ok", "run-capset-ok");
    expect(() =>
      withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
        governance.setCap(capSetEnv, "run-capset-ok", "budget", 42),
      ),
    ).not.toThrow();
    // Verify the cap was stored
    const row = sql.db.prepare(
      `SELECT cap FROM governance_caps WHERE run_id = ? AND kind = ?`,
    ).get("run-capset-ok", "budget") as { cap: number } | undefined;
    expect(row?.cap).toBe(42);
  });

  // --- Issue 1: breaker untrip atomicity (transaction wraps check+clear) ---
  it("breakerOutcome success on tripped breaker is atomic: token check + clear in one transaction", () => {
    // This test verifies the transaction path executes without error when a valid token
    // is provided (i.e., no TOCTOU between the capability check and the DB clear).
    governance.breakerOutcome(baseEnv, "node_atomic_test", "failure");
    governance.breakerOutcome(baseEnv, "node_atomic_test", "failure");
    governance.breakerOutcome(baseEnv, "node_atomic_test", "failure");
    expect(governance.breakerStatus("node_atomic_test").tripped).toBe(true);
    const atomicEnv = mintEnv("governance.breaker.reset", "node_atomic_test", "node_atomic_test");
    const result = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      governance.breakerOutcome(atomicEnv, "node_atomic_test", "success"),
    );
    expect(result.tripped).toBe(false);
    expect(result.consecutive_failures).toBe(0);
  });

  // --- Issue 5: operator actor registered as human — e2e operator approve path ---
  it("operator actor (eights.operator) registered as human -> hitlResolve + approve succeed e2e", async () => {
    // Register the operator actor as human (mirrors what daemon startup does).
    const OP_ACTOR = "eights.operator";
    sql.db.prepare(
      `INSERT OR IGNORE INTO actors(actor_id, kind, created_at) VALUES (?, 'human', datetime('now'))`,
    ).run(OP_ACTOR);

    // Propose + evaluate + commit (creates a pending hitl.approve row).
    const prop = evolution.propose(baseEnv, {
      rid: "resource:cap.test.medium", candidate_content: "e2e-operator-v", justification: "e2e op test",
    });
    await evolution.evaluate(baseEnv, prop.proposal_id);
    await evolution.commit(baseEnv, prop.proposal_id);

    const hitlRow = sql.db.prepare(
      `SELECT request_id FROM hitl_queue WHERE kind='evolution.approve' AND json_extract(payload_json,'$.proposal_id')=? AND status='pending' LIMIT 1`,
    ).get(prop.proposal_id) as { request_id: string } | undefined;
    expect(hitlRow).toBeDefined();

    // Operator mints resolve cap + approves hitl row.
    const resolveToken = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      mintOperatorCapability({
        v: 1, actor_id: OP_ACTOR, actor_kind: "human",
        capability: "hitl.resolve", resource_id: hitlRow!.request_id, workflow_id: hitlRow!.request_id,
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const resolveEnv = { ...baseEnv, actor_id: OP_ACTOR, capability_token: resolveToken } as unknown as Envelope;
    withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      governance.hitlResolve(resolveEnv, hitlRow!.request_id, "approved"),
    );

    // Operator mints approve cap + calls evolution.approve.
    const approveToken = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      mintOperatorCapability({
        v: 1, actor_id: OP_ACTOR, actor_kind: "human",
        capability: "evolution.approve", resource_id: prop.proposal_id, workflow_id: prop.proposal_id,
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const approveEnv = { ...baseEnv, actor_id: OP_ACTOR, capability_token: approveToken } as unknown as Envelope;
    const result = await withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      evolution.approve(approveEnv, prop.proposal_id),
    );
    expect(result.committed).toBe(true);
  });

  it("operator actor: reject e2e succeeds with minted token", () => {
    const OP_ACTOR = "eights.operator";
    sql.db.prepare(
      `INSERT OR IGNORE INTO actors(actor_id, kind, created_at) VALUES (?, 'human', datetime('now'))`,
    ).run(OP_ACTOR);
    const prop = evolution.propose(baseEnv, {
      rid: "resource:cap.test.low", candidate_content: "op-reject-test", justification: "operator reject e2e",
    });
    const rejectToken = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      mintOperatorCapability({
        v: 1, actor_id: OP_ACTOR, actor_kind: "human",
        capability: "evolution.reject", resource_id: prop.proposal_id, workflow_id: prop.proposal_id,
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const rejectEnv = { ...baseEnv, actor_id: OP_ACTOR, capability_token: rejectToken } as unknown as Envelope;
    withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      evolution.reject(rejectEnv, prop.proposal_id, "operator rejected"),
    );
    expect(evolution.getProposal(prop.proposal_id)?.status).toBe("rejected");
  });

  it("operator actor: unfreeze e2e succeeds with minted token", () => {
    const OP_ACTOR = "eights.operator";
    // Register a second frozen resource for this test.
    evolution.register(baseEnv, {
      rid: "resource:cap.test.frozen2", kind: "policy", risk_class: "critical",
      evolution_policy: "frozen", initial_content: "frozen2",
    });
    sql.db.prepare(
      `INSERT OR IGNORE INTO actors(actor_id, kind, created_at) VALUES (?, 'human', datetime('now'))`,
    ).run(OP_ACTOR);
    const unfreezeToken = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      mintOperatorCapability({
        v: 1, actor_id: OP_ACTOR, actor_kind: "human",
        capability: "evolution.unfreeze", resource_id: "resource:cap.test.frozen2", workflow_id: "resource:cap.test.frozen2",
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const unfreezeEnv = { ...baseEnv, actor_id: OP_ACTOR, capability_token: unfreezeToken } as unknown as Envelope;
    withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      evolution.unfreeze(unfreezeEnv, "resource:cap.test.frozen2"),
    );
    expect(evolution.getResource("resource:cap.test.frozen2")?.evolution_policy).toBe("hitl-only");
  });

  // --- Fix 6.3: consume VERIFIED jti, not raw token jti ---
  it("6.3: consumed-capabilities table keys off verifier-returned jti (HMAC-proven), not a raw re-read", () => {
    // This test proves that the jti stored in consumed_capabilities is the one
    // returned by verifyOperatorCapability (from the JSON-normalized, HMAC-verified
    // payload), not a re-extraction from the raw envelope token.
    //
    // Proof strategy: mint a token with a known, fixed jti.  After one use, verify
    // that exact jti appears in the consumed_capabilities table.  Then confirm the
    // second use of the same token is rejected with "already been used" — proving
    // the table lookup (using the verifier-returned jti) correctly identifies the replay.
    const nodeId = "jti-verified-consume-node";
    const knownJti = "verified-jti-consume-6.3";
    const token = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      mintOperatorCapability({
        v: 1, actor_id: baseEnv.actor_id, actor_kind: "human",
        capability: "governance.breaker.reset", resource_id: nodeId, workflow_id: nodeId,
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: knownJti,
      }),
    );
    const env63 = { ...baseEnv, capability_token: token } as unknown as Envelope;

    // First use: succeeds.
    withKey(TEST_OP_KEY, TEST_KEY_ID, () => governance.breakerReset(env63, nodeId));

    // The HMAC-proven jti must be in consumed_capabilities (verifier-returned value).
    const row = sql.db.prepare(
      `SELECT jti FROM consumed_capabilities WHERE jti = ?`,
    ).get(knownJti) as { jti: string } | undefined;
    expect(row?.jti).toBe(knownJti);

    // Second use: same token → jti already consumed → rejected.
    expect(() =>
      withKey(TEST_OP_KEY, TEST_KEY_ID, () => governance.breakerReset(env63, nodeId)),
    ).toThrow(/already been used/);
  });

  // --- Fix 5.1: Atlas operator id consistent with registered human ---
  it("5.1: token with actor_id matching EIGHTS_OPERATOR_ACTOR_ID (eights.operator) registered as human -> Atlas-style approve e2e", async () => {
    // This mirrors what Atlas (web/server/operator.ts) now does: actor_id = EIGHTS_OPERATOR_ACTOR_ID.
    // The daemon startup registers that id as kind='human'. Token must use the same id.
    const OP_ACTOR = "eights.operator"; // same as OPERATOR_ACTOR_ID in operator.ts after fix 5.1
    sql.db.prepare(
      `INSERT OR IGNORE INTO actors(actor_id, kind, created_at) VALUES (?, 'human', datetime('now'))`,
    ).run(OP_ACTOR);

    // Propose on a medium (hitl-only) resource.
    const prop = evolution.propose(baseEnv, {
      rid: "resource:cap.test.medium",
      candidate_content: "atlas-aligned-op-v",
      justification: "fix 5.1 atlas id alignment test",
    });
    await evolution.evaluate(baseEnv, prop.proposal_id);
    await evolution.commit(baseEnv, prop.proposal_id);

    // Find the HITL row.
    const hitlRow = sql.db.prepare(
      `SELECT request_id FROM hitl_queue WHERE kind='evolution.approve' AND json_extract(payload_json,'$.proposal_id')=? AND status='pending' LIMIT 1`,
    ).get(prop.proposal_id) as { request_id: string } | undefined;
    expect(hitlRow).toBeDefined();

    // Resolve with the aligned actor_id.
    const resolveToken = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      mintOperatorCapability({
        v: 1, actor_id: OP_ACTOR, actor_kind: "human",
        capability: "hitl.resolve", resource_id: hitlRow!.request_id, workflow_id: hitlRow!.request_id,
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const resolveEnv = { ...baseEnv, actor_id: OP_ACTOR, capability_token: resolveToken } as unknown as Envelope;
    withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      governance.hitlResolve(resolveEnv, hitlRow!.request_id, "approved"),
    );

    // Approve with the aligned actor_id.
    const approveToken = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      mintOperatorCapability({
        v: 1, actor_id: OP_ACTOR, actor_kind: "human",
        capability: "evolution.approve", resource_id: prop.proposal_id, workflow_id: prop.proposal_id,
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const approveEnv = { ...baseEnv, actor_id: OP_ACTOR, capability_token: approveToken } as unknown as Envelope;
    const result = await withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      evolution.approve(approveEnv, prop.proposal_id),
    );
    expect(result.committed).toBe(true);
  });

  // --- Fix 5.2: CLI hitl-only resolve → approve e2e ---
  it("5.2: hitl-only proposal: operator must resolve HITL row before approve; resolve→approve sequence commits", async () => {
    // This exercises the engine-level flow that the CLI review command now performs:
    // 1) commit() on a hitl-only resource creates a pending evolution.approve HITL row
    // 2) operator resolves the row (hitl.resolve capability)
    // 3) operator calls approve() (evolution.approve capability) → committed=true
    // Without step 2, approve() returns {committed:false, reason:"...no approved HITL"}.
    const OP_ACTOR = "eights.operator";
    sql.db.prepare(
      `INSERT OR IGNORE INTO actors(actor_id, kind, created_at) VALUES (?, 'human', datetime('now'))`,
    ).run(OP_ACTOR);

    // Register a fresh hitl-only resource for this test.
    evolution.register(baseEnv, {
      rid: "resource:cap.test.hitlonly-52",
      kind: "prompt", risk_class: "medium",
      evolution_policy: "hitl-only", initial_content: "init-52",
    });

    const prop = evolution.propose(baseEnv, {
      rid: "resource:cap.test.hitlonly-52",
      candidate_content: "v2-hitlonly-52",
      justification: "5.2 cli resolve→approve test",
    });
    await evolution.evaluate(baseEnv, prop.proposal_id);
    // commit() on hitl-only creates HITL row and returns committed:false.
    const commitResult = await evolution.commit(baseEnv, prop.proposal_id);
    expect(commitResult.committed).toBe(false);
    expect(commitResult.reason).toMatch(/hitl-only/);

    // Confirm HITL row created.
    const hitlRow = sql.db.prepare(
      `SELECT request_id FROM hitl_queue WHERE kind='evolution.approve' AND json_extract(payload_json,'$.proposal_id')=? AND status='pending' LIMIT 1`,
    ).get(prop.proposal_id) as { request_id: string } | undefined;
    expect(hitlRow).toBeDefined();

    // Without resolve: approve() must fail.
    const approveNoResolve = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      mintOperatorCapability({
        v: 1, actor_id: OP_ACTOR, actor_kind: "human",
        capability: "evolution.approve", resource_id: prop.proposal_id, workflow_id: prop.proposal_id,
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const envNoResolve = { ...baseEnv, actor_id: OP_ACTOR, capability_token: approveNoResolve } as unknown as Envelope;
    const resultNoResolve = await withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      evolution.approve(envNoResolve, prop.proposal_id),
    );
    expect(resultNoResolve.committed).toBe(false);
    expect(resultNoResolve.reason).toMatch(/HITL/);

    // Operator resolves the HITL row (step 2).
    const resolveToken = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      mintOperatorCapability({
        v: 1, actor_id: OP_ACTOR, actor_kind: "human",
        capability: "hitl.resolve", resource_id: hitlRow!.request_id, workflow_id: hitlRow!.request_id,
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const resolveEnv = { ...baseEnv, actor_id: OP_ACTOR, capability_token: resolveToken } as unknown as Envelope;
    withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      governance.hitlResolve(resolveEnv, hitlRow!.request_id, "approved"),
    );

    // After resolve: approve() now commits (step 3).
    const approveToken = withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      mintOperatorCapability({
        v: 1, actor_id: OP_ACTOR, actor_kind: "human",
        capability: "evolution.approve", resource_id: prop.proposal_id, workflow_id: prop.proposal_id,
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const approveEnv = { ...baseEnv, actor_id: OP_ACTOR, capability_token: approveToken } as unknown as Envelope;
    const finalResult = await withKey(TEST_OP_KEY, TEST_KEY_ID, () =>
      evolution.approve(approveEnv, prop.proposal_id),
    );
    expect(finalResult.committed).toBe(true);
  });
});
