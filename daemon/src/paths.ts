/**
 * Shared path resolver — removes machine-specific absolute paths from runtime.
 *
 * Resolution order (the ecosystem AIAPP_BASE convention):
 *   1. Per-purpose env override (callers check theirs FIRST, e.g. EIGHTS_HOME,
 *      EIGHTS_RLM_ROOT, EIGHTS_EXEC_OUTPUT_ROOT, EIGHTS_DAEMON_JS). This module
 *      honours EIGHTS_HOME for the repo root; siblings honour AIAPP_BASE.
 *   2. Anchor-relative auto-detect: walk up from THIS module's own location
 *      (import.meta.url -> dirname) until a directory containing package.json
 *      is found (the repo root sentinel), capped at ~8 levels.
 *   3. Siblings live under AIAPP_BASE if set, else dirname(detected repoRoot()).
 *   4. If unresolved, throw a clear error naming the env var to set.
 *
 * NEVER hardcode a C:/AiAppDeployments literal here.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const MAX_WALK_LEVELS = 8;

/** Posix-normalize backslashes so downstream string compares are stable. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Absolute path to the TheEights repo root.
 *   tier-1: EIGHTS_HOME env override.
 *   tier-2: walk up from this module to the dir containing package.json.
 * Throws if neither resolves.
 */
export function repoRoot(): string {
  const env = process.env.EIGHTS_HOME;
  if (env && env.trim()) return toPosix(resolve(env.trim()));

  // This file compiles to <repoRoot>/daemon/dist/paths.js (or runs from
  // <repoRoot>/daemon/src/paths.ts under tsx). This is a multi-package repo:
  // the root has NO package.json (daemon/, cli/, web/ each carry their own),
  // so the repo-root sentinel is `.git`, with the daemon/ subdir as a
  // structural confirmation. We deliberately skip the inner daemon package
  // root and stop at the ancestor that holds both `.git` and `daemon/`.
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < MAX_WALK_LEVELS; i++) {
    const hasGit = existsSync(join(dir, ".git"));
    const hasDaemon = existsSync(join(dir, "daemon"));
    if (hasGit && hasDaemon) return toPosix(dir);
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  // Fallback 1: nearest ancestor with a `.git` (covers checkouts without the
  // daemon/ sibling, e.g. a sparse clone).
  dir = start;
  for (let i = 0; i < MAX_WALK_LEVELS; i++) {
    if (existsSync(join(dir, ".git"))) return toPosix(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback 2: the ancestor that holds a daemon/ subdir (covers exported
  // trees with no .git).
  dir = start;
  for (let i = 0; i < MAX_WALK_LEVELS; i++) {
    if (existsSync(join(dir, "daemon", "package.json"))) return toPosix(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "TheEights repo root not found by walking up from " +
      `${start}. Set EIGHTS_HOME to the repo root.`,
  );
}

/**
 * Base directory that holds all sibling repos (Hydra, pair-programmer, ...).
 *   tier-1: AIAPP_BASE env override.
 *   tier-2: the parent directory of repoRoot().
 */
export function aiappBase(): string {
  const env = process.env.AIAPP_BASE;
  if (env && env.trim()) return toPosix(resolve(env.trim()));
  return toPosix(dirname(repoRoot()));
}

/**
 * Absolute path to a sibling repo directory under aiappBase().
 * Per-sibling env overrides (handled by callers) take precedence over this.
 */
export function siblingRoot(name: string): string {
  return toPosix(join(aiappBase(), name));
}

/** Absolute path to the built daemon entrypoint inside this repo. */
export function daemonEntrypoint(): string {
  return toPosix(join(repoRoot(), "daemon", "dist", "index.js"));
}
