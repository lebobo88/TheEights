import { describe, it, expect } from "vitest";
import { PpWriteBridge } from "../src/engines/writers/pp-writer.js";
import { HydraWriteBridge } from "../src/engines/writers/hydra-writer.js";
import { ExecSuiteWriteBridge } from "../src/engines/writers/execsuite-writer.js";
import { RlmWriteBridge } from "../src/engines/writers/rlm-writer.js";
import { pathContains } from "../src/engines/writeback.js";

describe("writeback — sandbox invariants (HARD INVARIANT #6)", () => {
  it("pathContains rejects escape paths", () => {
    expect(pathContains("C:/AiAppDeployments/Hydra", "C:/AiAppDeployments/ExecutiveSuite/foo.md")).toBe(false);
    expect(pathContains("C:/AiAppDeployments/Hydra", "C:/AiAppDeployments/Hydra/../ExecutiveSuite/foo.md")).toBe(false);
    expect(pathContains("C:/AiAppDeployments/Hydra", "C:/AiAppDeployments/Hydra/squads/exec/squad.yaml")).toBe(true);
  });

  it("PpWriteBridge accepts pp + user .claude; refuses others", () => {
    const b = new PpWriteBridge();
    const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
    expect(b.canHandle("C:/AiAppDeployments/pair-programmer/daemon/src/index.ts")).toBe(true);
    expect(b.canHandle(`${home}/.claude/teams/feature-team.yaml`)).toBe(true);
    expect(b.canHandle("C:/AiAppDeployments/Hydra/squads/exec/squad.yaml")).toBe(false);
    expect(b.canHandle("C:/Windows/System32/cmd.exe")).toBe(false);
  });

  it("HydraWriteBridge accepts only Hydra root", () => {
    const b = new HydraWriteBridge();
    expect(b.canHandle("C:/AiAppDeployments/Hydra/squads/exec/squad.yaml")).toBe(true);
    expect(b.canHandle("C:/AiAppDeployments/pair-programmer/daemon/src/index.ts")).toBe(false);
  });

  it("ExecSuiteWriteBridge accepts only ExecutiveSuite root", () => {
    const b = new ExecSuiteWriteBridge();
    expect(b.canHandle("C:/AiAppDeployments/ExecutiveSuite/.claude/agents/ceo.md")).toBe(true);
    expect(b.canHandle("C:/AiAppDeployments/Hydra/squads/exec/squad.yaml")).toBe(false);
  });

  it("RlmWriteBridge claims RLM* siblings under C:/AiAppDeployments", () => {
    const b = new RlmWriteBridge();
    // RLM-CLI-Starter is guaranteed by the workspace per earlier surveys.
    expect(b.canHandle("C:/AiAppDeployments/RLM-CLI-Starter/RLM/prompts/01-discover.md")).toBe(true);
    expect(b.canHandle("C:/AiAppDeployments/pair-programmer/foo.md")).toBe(false);
  });

  it("write() refuses non-claimed paths even if mode is in-place", async () => {
    const b = new HydraWriteBridge();
    const r = await b.write({
      rid: "x", version: "v", content: "x",
      source_path: "C:/Windows/System32/should-never-write.txt",
      writeback_mode: "in-place",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sandbox/);
  });
});
