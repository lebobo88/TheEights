/**
 * YamlStructuralEval — parses both yamls, runs lightweight property tests:
 *   - Both parse without error.
 *   - Candidate did not remove top-level keys present in current.
 *   - If a `stages` list exists, candidate stages must be a superset.
 *   - If a `tools` allowlist exists, candidate must not broaden it.
 *
 * Returns +0.1 on clean pass, -1 on any violation. Cheap; no LLM.
 */
import { parse as parseYaml } from "yaml";
import type { Consumer, ResourceKind } from "../../schemas/resource.js";
import type { EvalAdapter } from "./registry.js";

export class YamlStructuralEval implements EvalAdapter {
  readonly name = "yaml-structural";
  readonly kinds: ResourceKind[] = ["team", "workflow", "schema"];
  readonly consumers: Consumer[] | "*" = "*";

  async evaluate(input: { current_content: string; candidate_content: string }): Promise<{ eval_delta: number; metric_scores: Record<string, number>; notes: string }> {
    let cur: Record<string, unknown>;
    let cand: Record<string, unknown>;
    try { cur = parseYaml(input.current_content) ?? {}; }
    catch (err) { return fail(`current YAML invalid: ${(err as Error).message}`); }
    try { cand = parseYaml(input.candidate_content) ?? {}; }
    catch (err) { return fail(`candidate YAML invalid: ${(err as Error).message}`); }

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

function fail(reason: string): { eval_delta: number; metric_scores: Record<string, number>; notes: string } {
  return { eval_delta: -1, metric_scores: { structural: 0 }, notes: reason };
}

function listOf(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.map((x) => typeof x === "string" ? x : (typeof x === "object" && x && "name" in x ? String((x as { name: unknown }).name) : JSON.stringify(x)));
}
