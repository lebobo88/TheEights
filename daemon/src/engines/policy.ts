/**
 * PolicyEngine — pure deterministic policy decisions. No LLM calls.
 *
 * Implements:
 *   - SSGM Gate 1: consistency verification (memory writes)
 *   - SSGM Gate 2: temporal decay sanity (memory consolidate)
 *   - SSGM Gate 3: dynamic access control (read + write)
 *   - LASM access checks (cross-layer)
 *   - Redaction at the MCP boundary (PII patterns)
 *
 * Policies live in a frozen meta-resource. Default policy is bundled below; the
 * Evolution Engine (Phase 3) will load overrides from the resource registry.
 */
import type { SqliteStore } from "../stores/sqlite.js";
import type { Memory } from "../schemas/memory.js";
import type { Envelope } from "../schemas/envelope.js";

export interface PolicyDecision {
  allow: boolean;
  reason: string;
  requires_hitl: boolean;
}

export interface ConsistencyResult {
  ok: boolean;
  conflicts: Array<{ memory_id: string; reason: string }>;
}

export interface AccessResult {
  ok: boolean;
  reason: string;
}

export interface RedactionResult {
  text: string;
  redacted_count: number;
}

const HIGH_CONFIDENCE_THRESHOLD = 0.8;

// PII patterns — conservative, easy to extend. Documented in ADR-0007 (TODO).
const REDACTION_PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  { name: "ssn",        pattern: /\b\d{3}-\d{2}-\d{4}\b/g,                               replacement: "[REDACTED:ssn]" },
  { name: "credit-card", pattern: /\b(?:\d[ -]*?){13,19}\b/g,                            replacement: "[REDACTED:cc]" },
  { name: "email",      pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,  replacement: "[REDACTED:email]" },
  { name: "aws-key",    pattern: /\bAKIA[0-9A-Z]{16}\b/g,                                replacement: "[REDACTED:aws-key]" },
  { name: "github-pat", pattern: /\bghp_[A-Za-z0-9]{36,}\b/g,                            replacement: "[REDACTED:github-pat]" },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,                             replacement: "[REDACTED:openai-key]" },
  { name: "private-key", pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g, replacement: "[REDACTED:private-key]" },
];

export class PolicyEngine {
  constructor(private readonly store: SqliteStore) {}

  // ---------- SSGM Gate 1: consistency ----------
  consistencyCheck(env: Envelope, candidate: {
    content: string;
    type: string;
    scopes: string[];
    supersedes: string[];
    confidence: number;
  }): ConsistencyResult {
    // Find existing high-confidence memories in same (type, scope) slice that
    // share substantial entity overlap and weren't explicitly superseded.
    const scopeMarker = candidate.scopes[0] ?? "";
    const rows = this.store.db
      .prepare(
        `SELECT id, content, confidence, scopes_json FROM memories
         WHERE tenant_id = ? AND type = ? AND confidence >= ?
         ORDER BY created_at DESC LIMIT 200`,
      )
      .all(env.tenant_id, candidate.type, HIGH_CONFIDENCE_THRESHOLD) as Array<{
        id: string; content: string; confidence: number; scopes_json: string;
      }>;
    const conflicts: ConsistencyResult["conflicts"] = [];
    const candTokens = tokens(candidate.content);
    for (const row of rows) {
      if (candidate.supersedes.includes(row.id)) continue;
      const rowScopes = safeJsonArray(row.scopes_json);
      if (scopeMarker && !rowScopes.includes(scopeMarker)) continue;
      const overlap = overlapCoefficient(candTokens, tokens(row.content));
      // Same surface area + opposing valence signals = candidate conflict.
      // Use overlap coefficient (intersection / min size) — robust on short texts.
      if (overlap >= 0.5 && hasContradiction(candidate.content, row.content)) {
        conflicts.push({ memory_id: row.id, reason: `high overlap (${overlap.toFixed(2)}) with opposing valence` });
      }
    }
    return { ok: conflicts.length === 0, conflicts };
  }

  // ---------- SSGM Gate 2: temporal decay ----------
  decayConfidence(typeHalfLifeDays: number, ageDays: number, currentConfidence: number): number {
    if (ageDays <= 0) return currentConfidence;
    const decay = Math.pow(0.5, ageDays / Math.max(typeHalfLifeDays, 0.001));
    return Math.max(0, currentConfidence * decay);
  }

  /** Reject consolidation that resurrects a superseded fact without evidence. */
  resurrectionCheck(supersedes: string[], evidence: string[]): { ok: boolean; reason?: string } {
    if (!supersedes.length) return { ok: true };
    // If any of the memories being "consumed" by this write are themselves
    // currently superseded, require explicit evidence.
    const placeholders = supersedes.map(() => "?").join(",");
    const rows = this.store.db
      .prepare(`SELECT id, superseded_by_json FROM memories WHERE id IN (${placeholders})`)
      .all(...supersedes) as Array<{ id: string; superseded_by_json: string }>;
    for (const row of rows) {
      const supBy = safeJsonArray(row.superseded_by_json);
      if (supBy.length > 0 && evidence.length === 0) {
        return { ok: false, reason: `${row.id} is already superseded by ${supBy.join(",")}; evidence_memory_ids required` };
      }
    }
    return { ok: true };
  }

  // ---------- SSGM Gate 3: dynamic access control ----------
  accessCheck(env: Envelope, target_scopes: string[]): AccessResult {
    // v1: actor's scopes must be a superset of target's "sensitive" scopes.
    const sensitive = target_scopes.filter((s) => s.startsWith("sensitive:"));
    for (const s of sensitive) {
      if (!env.scope.includes(s)) {
        return { ok: false, reason: `actor lacks required scope ${s}` };
      }
    }
    return { ok: true, reason: "ok" };
  }

  // ---------- LASM cross-layer policy ----------
  policyEvaluate(action: string, env: Envelope): PolicyDecision {
    // Default-allow with a small allow/deny matrix; resource-backed overrides land in Phase 3.
    // Deny pattern: writes from an "untrusted" actor to a "frozen" scope.
    if (env.scope.includes("frozen") && action.endsWith(".write")) {
      return { allow: false, reason: "frozen scope is write-protected", requires_hitl: false };
    }
    // Tenant cross-talk: only allow same-tenant for now.
    if (env.tenant_id !== "local") {
      return { allow: false, reason: "multi-tenant disabled in v1", requires_hitl: false };
    }
    return { allow: true, reason: "default-allow", requires_hitl: false };
  }

  // ---------- Redaction (MCP boundary) ----------
  redact(text: string): RedactionResult {
    let count = 0;
    let out = text;
    for (const p of REDACTION_PATTERNS) {
      out = out.replace(p.pattern, () => { count += 1; return p.replacement; });
    }
    return { text: out, redacted_count: count };
  }
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
}

function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / Math.min(a.size, b.size);
}

function hasContradiction(a: string, b: string): boolean {
  // v1: explicit negation flip. "X is approved" vs "X is rejected", "do" vs "do not".
  const NEG = /\b(not|never|reject(ed)?|deny|denied|disable[d]?|disabled|false|incorrect|wrong|forbid)\b/i;
  const negA = NEG.test(a);
  const negB = NEG.test(b);
  return negA !== negB;
}

function safeJsonArray(s: string | null | undefined): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v as string[] : []; } catch { return []; }
}
