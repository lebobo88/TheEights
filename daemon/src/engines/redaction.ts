/**
 * Squad-scoped redaction. Each Hydra target squad has a redaction policy
 * stored as a `redaction_policy` resource (risk_class: high → HITL-only
 * mutation per AGENTS.md hard rule 1).
 *
 * Policy format (YAML in the resource body):
 *   target_squad: <slug>
 *   strip_scopes:        [secret, pii, financial]
 *   block_envelope_types: [HITLRequest]   # optional — bounce these instead of forwarding
 *   keep_summary_only:   true             # if true, replace content with summary
 *
 * If no policy is registered for the target squad, the default `creative`
 * policy is applied (most restrictive).
 */
import { parse as parseYaml } from "yaml";
import type { EvolutionEngine } from "./evolution.js";
import type { PolicyEngine } from "./policy.js";
import type { AuditEngine } from "./audit.js";
import type { Envelope } from "../schemas/envelope.js";

export interface SquadRedactionPolicy {
  target_squad: string;
  strip_scopes: string[];
  block_envelope_types: string[];
  keep_summary_only: boolean;
}

export interface RedactedPayload {
  target_squad: string;
  policy_rid: string;
  blocked: boolean;
  block_reason?: string;
  payload: unknown;
  redacted_count: number;
  scopes_stripped: string[];
}

const DEFAULT_POLICY: SquadRedactionPolicy = {
  target_squad: "default",
  strip_scopes: ["secret", "pii", "financial", "phi"],
  block_envelope_types: [],
  keep_summary_only: false,
};

export class RedactionEngine {
  constructor(
    private readonly evolution: EvolutionEngine,
    private readonly policy: PolicyEngine,
    private readonly audit: AuditEngine,
  ) {}

  getPolicy(target_squad: string): { policy: SquadRedactionPolicy; rid: string } {
    const rid = `resource:hydra.redaction-policy.${target_squad}`;
    const r = this.evolution.getResource(rid);
    if (!r) return { policy: { ...DEFAULT_POLICY, target_squad }, rid: "<default>" };
    const text = this.evolution.readVersion(r.rid, r.current_version) ?? "";
    try {
      const parsed = parseYaml(text) as Partial<SquadRedactionPolicy>;
      return {
        rid: r.rid,
        policy: {
          target_squad: parsed.target_squad ?? target_squad,
          strip_scopes: parsed.strip_scopes ?? DEFAULT_POLICY.strip_scopes,
          block_envelope_types: parsed.block_envelope_types ?? [],
          keep_summary_only: parsed.keep_summary_only ?? false,
        },
      };
    } catch {
      return { policy: { ...DEFAULT_POLICY, target_squad }, rid: r.rid };
    }
  }

  redactForSquad(env: Envelope, target_squad: string, payload: unknown): RedactedPayload {
    const { policy, rid } = this.getPolicy(target_squad);
    const envelope_type = typeof payload === "object" && payload !== null
      ? (payload as { type?: string }).type ?? null : null;

    if (envelope_type && policy.block_envelope_types.includes(envelope_type)) {
      this.audit.record("redaction.block", env, { target_squad, envelope_type, policy_rid: rid });
      return {
        target_squad,
        policy_rid: rid,
        blocked: true,
        block_reason: `envelope type '${envelope_type}' is blocked for ${target_squad}`,
        payload: null,
        redacted_count: 0,
        scopes_stripped: [],
      };
    }

    const { redacted, count, stripped } = redactDeep(payload, policy, (s) => this.policy.redact(s));

    this.audit.record("redaction.apply", env, {
      target_squad, policy_rid: rid, redacted_count: count,
      scopes_stripped: stripped, envelope_type,
    });

    return {
      target_squad,
      policy_rid: rid,
      blocked: false,
      payload: redacted,
      redacted_count: count,
      scopes_stripped: stripped,
    };
  }
}

function redactDeep(
  value: unknown,
  policy: SquadRedactionPolicy,
  patternRedact: (s: string) => { text: string; redacted_count: number },
): { redacted: unknown; count: number; stripped: string[] } {
  let count = 0;
  const stripped = new Set<string>();

  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v === "string") {
      const r = patternRedact(v);
      count += r.redacted_count;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const scopes = o.scopes;
      const refScopes = Array.isArray(scopes) ? scopes as unknown[] : [];
      if (refScopes.some((s) => typeof s === "string" && policy.strip_scopes.includes(s))) {
        for (const s of refScopes) if (typeof s === "string" && policy.strip_scopes.includes(s)) stripped.add(s);
        if (policy.keep_summary_only && typeof o.summary === "string") {
          return { ...o, content: undefined, payload: undefined, key: o.key, summary: o.summary, scopes: o.scopes, _redacted: true };
        }
        count += 1;
        return { ...o, content: "[REDACTED:scope]", payload: "[REDACTED:scope]", _redacted: true };
      }
      for (const [k, vv] of Object.entries(o)) out[k] = walk(vv);
      return out;
    }
    return v;
  };

  return { redacted: walk(value), count, stripped: [...stripped] };
}
