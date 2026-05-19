/**
 * WriteBridge — per-consumer adapter that propagates a committed Resource
 * version back to the consumer's filesystem (and optionally stages a commit
 * on a `theeights/auto` side-branch in the consumer repo).
 *
 * Sandboxing (HARD INVARIANT #6, ADR-0007): every `canHandle` MUST refuse
 * paths that are not `path.resolve`-contained inside the consumer's
 * allowlisted root(s). `write()` validates this again as defense-in-depth.
 */
import { resolve, sep } from "node:path";
import type { Consumer, WritebackMode } from "../schemas/resource.js";

export interface WriteRequest {
  rid: string;
  version: string;
  content: string;
  source_path: string;
  writeback_mode: WritebackMode;
  proposal_id?: string;
  justification?: string;
}

export interface WriteResult {
  ok: boolean;
  source_path: string;
  mode_used: WritebackMode;
  git_branch?: string;
  git_commit?: string;
  error?: string;
}

export interface WriteBridge {
  consumer: Consumer;
  canHandle(source_path: string): boolean;
  write(req: WriteRequest): Promise<WriteResult>;
}

/** Returns true iff `child` is resolved-contained within `parent`. */
export function pathContains(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (p === c) return true;
  const prefix = p.endsWith(sep) ? p : p + sep;
  // Case-insensitive on Windows.
  if (process.platform === "win32") {
    return c.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return c.startsWith(prefix);
}

/**
 * Routes a write request to whichever bridge claims its source_path.
 * Used by the EvolutionEngine post-commit hook.
 */
export class WriteRouter {
  constructor(private readonly bridges: WriteBridge[]) {}

  find(source_path: string): WriteBridge | null {
    for (const b of this.bridges) {
      if (b.canHandle(source_path)) return b;
    }
    return null;
  }

  async write(req: WriteRequest): Promise<WriteResult> {
    const bridge = this.find(req.source_path);
    if (!bridge) {
      return {
        ok: false,
        source_path: req.source_path,
        mode_used: req.writeback_mode,
        error: `no WriteBridge claims path ${req.source_path}`,
      };
    }
    return bridge.write(req);
  }
}
