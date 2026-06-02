/**
 * Hard read-only tool whitelist for the Atlas bridge.
 *
 * INVARIANT #1 (no broadening of tenant/scope access) + the campaign's
 * read-only mandate are enforced HERE, structurally: the bridge will refuse to
 * call any tool not in this frozen set. There are NO write/commit/approve/
 * charge/resolve/reject tools in it, by construction.
 *
 * This is the single source of truth for what the browser-facing bridge may
 * ever ask the daemon to do. Adding a tool here is a governance event.
 */
export const READ_ONLY_TOOLS = Object.freeze([
  "audit.trace",
  "audit.verify",
  "audit.bom",
  "evolution.list_resources",
  "evolution.list_pending",
  "evolution.get_resource",
  "governance.hitl.list",
  "cells.distribution",
  "cells.query",
  "hydra.envelope.query",
  "hydra.handoff.list",
  "squad.list",
  "prompt.list",
] as const);

export type ReadOnlyTool = (typeof READ_ONLY_TOOLS)[number];

const SET: ReadonlySet<string> = new Set(READ_ONLY_TOOLS);

/** Returns true iff `tool` is on the hard read-only whitelist. */
export function isWhitelisted(tool: string): tool is ReadOnlyTool {
  return SET.has(tool);
}

/**
 * Defense-in-depth: even if a tool were somehow added to the whitelist by
 * mistake, this denylist of dangerous verbs is checked first. A tool that
 * matches any of these patterns is ALWAYS refused, whitelist notwithstanding.
 */
const FORBIDDEN_SUBSTRINGS = [
  ".add",
  ".commit",
  ".approve",
  ".reject",
  ".charge",
  ".resolve",
  ".register",
  ".propose",
  ".unfreeze",
  ".rollback",
  ".cap",
  ".reset",
  ".outcome",
  ".start",
  ".stop",
  ".sync",
  ".run_now",
  ".write",
  ".classify",
  ".link",
  ".attest",
  ".amendment",
];

export function isForbidden(tool: string): boolean {
  const t = tool.toLowerCase();
  return FORBIDDEN_SUBSTRINGS.some((s) => t.includes(s));
}

/** The only gate the bridge uses. Read-only AND not forbidden. */
export function allowTool(tool: string): boolean {
  return isWhitelisted(tool) && !isForbidden(tool);
}
