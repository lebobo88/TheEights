import type { Consumer } from "../../schemas/resource.js";
import { pathContains, type WriteBridge, type WriteRequest, type WriteResult } from "../writeback.js";
import { writeWithGitSideBranch, writeInPlace } from "../git-writer.js";
import { loadConfig } from "../../config.js";

// pp has two trust roots: its repo, and the user-level Claude install (~/.claude)
// where pp installs its agents/skills/commands. Roots are injectable so tests
// can pin the sandbox independent of host layout.
function defaultRoots(): string[] {
  const cfg = loadConfig();
  return [cfg.ppRoot, cfg.claudeRoot];
}

export class PpWriteBridge implements WriteBridge {
  readonly consumer: Consumer = "pp";
  constructor(private readonly roots: string[] = defaultRoots()) {}
  canHandle(source_path: string): boolean {
    return this.roots.some((r) => pathContains(r, source_path));
  }
  async write(req: WriteRequest): Promise<WriteResult> {
    if (!this.canHandle(req.source_path)) {
      return { ok: false, source_path: req.source_path, mode_used: req.writeback_mode, error: "sandbox: path not under pp roots" };
    }
    if (req.writeback_mode === "none") {
      return { ok: true, source_path: req.source_path, mode_used: "none" };
    }
    if (req.writeback_mode === "in-place") return writeInPlace(req);
    return writeWithGitSideBranch(req);
  }
}
