import { homedir } from "node:os";
import { join } from "node:path";
import type { Consumer } from "../../schemas/resource.js";
import { pathContains, type WriteBridge, type WriteRequest, type WriteResult } from "../writeback.js";
import { writeWithGitSideBranch, writeInPlace } from "../git-writer.js";

const ROOTS = [
  "C:/AiAppDeployments/pair-programmer",
  join(homedir(), ".claude").replace(/\\/g, "/"),
];

export class PpWriteBridge implements WriteBridge {
  readonly consumer: Consumer = "pp";
  canHandle(source_path: string): boolean {
    return ROOTS.some((r) => pathContains(r, source_path));
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
