import { readdirSync, existsSync } from "node:fs";
import type { Consumer } from "../../schemas/resource.js";
import { pathContains, type WriteBridge, type WriteRequest, type WriteResult } from "../writeback.js";
import { writeWithGitSideBranch, writeInPlace } from "../git-writer.js";
import { aiappBase } from "../../paths.js";

const BASE = aiappBase();

function discoverRoots(): string[] {
  // Sibling dir is RLM-Creative (RLM-CLI-Starter was a stale name); the loop
  // below also picks up any other ^RLM* siblings present on disk.
  const roots = [`${BASE}/RLM-Creative`];
  try {
    for (const e of readdirSync(BASE, { withFileTypes: true })) {
      if (e.isDirectory() && /^RLM/.test(e.name)) roots.push(`${BASE}/${e.name}`);
    }
  } catch { /* ignore */ }
  return roots.filter(existsSync);
}

export class RlmWriteBridge implements WriteBridge {
  readonly consumer: Consumer = "rlm";
  private readonly roots: string[] = discoverRoots();
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
