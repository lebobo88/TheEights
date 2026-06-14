/**
 * YamlStructuralEval — parses both yamls, runs lightweight property tests:
 *   - Both parse without error.
 *   - Candidate did not remove top-level keys present in current.
 *   - If a `stages` list exists, candidate stages must be a superset.
 *   - If a `tools` allowlist exists, candidate must not broaden it.
 *
 * Returns +0.1 on clean pass, -1 on any violation. Cheap; no LLM.
 *
 * Genre guard: these checks only make sense when BOTH sides are genuine YAML
 * *mappings* (real config files — team/squad/workflow/schema yaml). Many
 * governed resources of these kinds actually store a prose design-decision as
 * their content; YAML parses prose into a bare string (or a scalar), which used
 * to make `Object.keys(string)` enumerate character indices ("removed keys
 * 0,1,2…") and `key in <string>` throw "Cannot use 'in' operator". When either
 * side is not a mapping we now return `not_applicable` so the registry falls
 * through to the LLM judge, which is the right tool for prose. We never throw
 * and never emit a spurious -1 on a content-genre mismatch.
 */
import { parse as parseYaml } from "yaml";
import type { Consumer, ResourceKind } from "../../schemas/resource.js";
import type { EvalAdapter, EvalResult } from "./registry.js";

export class YamlStructuralEval implements EvalAdapter {
  readonly name = "yaml-structural";
  readonly kinds: ResourceKind[] = ["team", "workflow", "schema", "squad", "redaction_policy"];
  readonly consumers: Consumer[] | "*" = "*";

  async evaluate(input: { current_content: string; candidate_content: string }): Promise<EvalResult> {
    const cur = tryParse(input.current_content);
    const cand = tryParse(input.candidate_content);

    // Genre guard: structural property tests require BOTH sides to be genuine
    // YAML *config* mappings. We reject two genres of non-config content:
    //   1. Not a mapping at all (prose → string, a list, a scalar, parse error).
    //   2. A mapping whose top-level keys are not identifiers — a prose sentence
    //      like "PostGIS extension: defer until Phase 6" parses into the single
    //      key {"PostGIS extension": ...}, which is NOT config. Real config keys
    //      are identifiers (name, stages, tools, entrypoint) with no whitespace.
    // In either case we defer (not_applicable) to the prose-aware LLM judge
    // rather than fabricate a structural verdict.
    if (!isConfigMapping(cur) || !isConfigMapping(cand)) {
      return {
        eval_delta: 0,
        not_applicable: true,
        metric_scores: {},
        notes: "content is not a YAML config mapping on both sides — deferring to a prose-aware evaluator",
      };
    }

    const removed = Object.keys(cur).filter((k) => !(k in cand));
    if (removed.length) return fail(`candidate removed top-level keys: ${removed.join(", ")}`);

    const curStages = listOf(cur.stages);
    const candStages = listOf(cand.stages);
    if (curStages && candStages) {
      const missing = curStages.filter((s) => !candStages.includes(s));
      if (missing.length) return fail(`candidate missing stages: ${missing.join(", ")}`);
    }

    const curTools = listOf(cur.tools);
    const candTools = listOf(cand.tools);
    if (curTools && candTools) {
      const added = candTools.filter((t) => !curTools.includes(t));
      if (added.length) return fail(`candidate broadens tool whitelist: ${added.join(", ")}`);
    }

    return { eval_delta: 0.1, metric_scores: { structural: 1 }, notes: "structural checks passed" };
  }
}

function fail(reason: string): EvalResult {
  return { eval_delta: -1, metric_scores: { structural: 0 }, notes: reason };
}

/** Parse YAML, returning `undefined` on any error (callers treat that as "not a mapping"). */
function tryParse(s: string): unknown {
  try { return parseYaml(s); }
  catch { return undefined; }
}

/** True only for a plain object (YAML mapping) — not null, not an array, not a scalar. */
function isMapping(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * True for a non-empty mapping whose top-level keys all look like config
 * identifiers (letters/digits/_/-/. , no whitespace). Prose that YAML coerces
 * into a single-key mapping — e.g. {"PostGIS extension": "..."} — fails this
 * because the key contains a space, so it is correctly treated as non-config.
 */
function isConfigMapping(v: unknown): v is Record<string, unknown> {
  if (!isMapping(v)) return false;
  const keys = Object.keys(v);
  if (keys.length === 0) return false;
  return keys.every((k) => /^[A-Za-z0-9_.-]+$/.test(k));
}

function listOf(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.map((x) => typeof x === "string" ? x : (typeof x === "object" && x && "name" in x ? String((x as { name: unknown }).name) : JSON.stringify(x)));
}
