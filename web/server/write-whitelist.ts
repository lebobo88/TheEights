/**
 * Hard WRITE tool allowlist for the Atlas governed operator-write path.
 *
 * This is SEPARATE from the read-only whitelist (`whitelist.ts`) by design. The
 * read path keeps its fixed read-only `eights-atlas` envelope + 13-tool read
 * whitelist + forbidden-verb denylist, untouched. This module governs ONLY the
 * new POST endpoints.
 *
 * GOVERNANCE (inviolable, CONSTITUTION.md §III + AGENTS.md):
 *   - This allowlist contains EXACTLY THREE governed evolution tools and nothing
 *     else. No other write tool is reachable from the browser. Adding a tool here
 *     is a governance event and requires HITL + an AgentSmith review of this file.
 *   - Every tool here is a GOVERNED tool: `eights.evolution.*` enforces policy,
 *     HITL, frozen-refusal, write-back, and audit on the daemon side. The bridge
 *     NEVER bypasses governance — it invokes it. (Invariants #2, #3, #5.)
 *   - Tool names are server-controlled literals. The browser supplies only the
 *     proposal_id / reason / to_version / rid (all validated), never a tool name.
 */
export const WRITE_TOOLS = Object.freeze([
  "evolution.approve",
  "evolution.reject",
  "evolution.rollback",
] as const);

export type WriteTool = (typeof WRITE_TOOLS)[number];

const SET: ReadonlySet<string> = new Set(WRITE_TOOLS);

/** Returns true iff `tool` is one of the exactly-three governed write tools. */
export function isWriteTool(tool: string): tool is WriteTool {
  return SET.has(tool);
}

/**
 * The only gate the write path uses. A write tool is permitted iff it is one of
 * the exactly-three governed evolution tools. There is no "and not forbidden"
 * escape here: this allowlist is a closed set of three, by construction.
 */
export function allowWriteTool(tool: string): boolean {
  return isWriteTool(tool);
}
