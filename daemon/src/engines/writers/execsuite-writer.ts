import type { Consumer } from "../../schemas/resource.js";
import { pathContains, type WriteBridge, type WriteRequest, type WriteResult } from "../writeback.js";
import { writeWithGitSideBranch, writeInPlace } from "../git-writer.js";

const ROOT = "C:/AiAppDeployments/ExecutiveSuite";

export class ExecSuiteWriteBridge implements WriteBridge {
  readonly consumer: Consumer = "execsuite";
  canHandle(source_path: string): boolean { return pathContains(ROOT, source_path); }
  async write(req: WriteRequest): Promise<WriteResult> {
    if (!this.canHandle(req.source_path)) {
      return { ok: false, source_path: req.source_path, mode_used: req.writeback_mode, error: "sandbox: path not under ExecutiveSuite root" };
    }
    if (req.writeback_mode === "none") return { ok: true, source_path: req.source_path, mode_used: "none" };
    if (req.writeback_mode === "in-place") return writeInPlace(req);
    return writeWithGitSideBranch(req);
  }
}
