import { readdirSync, existsSync } from "node:fs";
import type { Consumer } from "../../schemas/resource.js";
import { pathContains, type WriteBridge, type WriteRequest, type WriteResult } from "../writeback.js";
import { writeWithGitSideBranch, writeInPlace } from "../git-writer.js";
import { loadConfig } from "../../config.js";

// RLM's claim surface is the canonical starter repo plus every `^RLM*` sibling
// directory found under the scan root. Both are injectable so tests can pin the
// sandbox independent of host layout, and the scan root is env-pinnable
// (EIGHTS_RLM_ROOT) to constrain the claim surface on broad parents.
function discoverRoots(scanRoot: string, starter: string): string[] {
  const roots = [starter];
  try {
    for (const e of readdirSync(scanRoot, { withFileTypes: true })) {
      if (e.isDirectory() && /^RLM/.test(e.name)) roots.push(`${scanRoot}/${e.name}`);
    }
  } catch { /* ignore */ }
  return roots.filter(existsSync);
}

export class RlmWriteBridge implements WriteBridge {
  readonly consumer: Consumer = "rlm";
  private readonly roots: string[];
  constructor(scanRoot: string = loadConfig().rlmScanRoot, starter: string = loadConfig().rlmStarterRoot) {
    this.roots = discoverRoots(scanRoot, starter);
  }
  canHandle(source_path: string): boolean { return this.roots.some((r) => pathContains(r, source_path)); }
  async write(req: WriteRequest): Promise<WriteResult> {
    if (!this.canHandle(req.source_path)) {
      return { ok: false, source_path: req.source_path, mode_used: req.writeback_mode, error: "sandbox: path not under any RLM* root" };
    }
    if (req.writeback_mode === "none") return { ok: true, source_path: req.source_path, mode_used: "none" };
    if (req.writeback_mode === "in-place") return writeInPlace(req);
    return writeWithGitSideBranch(req);
  }
}
