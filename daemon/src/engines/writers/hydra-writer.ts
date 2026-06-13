import type { Consumer } from "../../schemas/resource.js";
import { pathContains, type WriteBridge, type WriteRequest, type WriteResult } from "../writeback.js";
import { writeWithGitSideBranch, writeInPlace } from "../git-writer.js";
import { siblingRoot } from "../../paths.js";

const ROOT = siblingRoot("Hydra");

export class HydraWriteBridge implements WriteBridge {
  readonly consumer: Consumer = "hydra";
  canHandle(source_path: string): boolean { return pathContains(ROOT, source_path); }
  async write(req: WriteRequest): Promise<WriteResult> {
    if (!this.canHandle(req.source_path)) {
      return { ok: false, source_path: req.source_path, mode_used: req.writeback_mode, error: "sandbox: path not under Hydra root" };
    }
    if (req.writeback_mode === "none") return { ok: true, source_path: req.source_path, mode_used: "none" };
    if (req.writeback_mode === "in-place") return writeInPlace(req);
    return writeWithGitSideBranch(req);
  }
}
