import { describe, it, expect } from "vitest";
import { PpWriteBridge } from "../src/engines/writers/pp-writer.js";
import { HydraWriteBridge } from "../src/engines/writers/hydra-writer.js";
import { ExecSuiteWriteBridge } from "../src/engines/writers/execsuite-writer.js";
import { RlmWriteBridge } from "../src/engines/writers/rlm-writer.js";
import { pathContains } from "../src/engines/writeback.js";
import { aiappBase, siblingRoot } from "../src/paths.js";

// Anchor the fixtures on the SAME resolver the bridges use, so these
// invariants hold on any machine instead of assuming C:/AiAppDeployments.
const BASE = aiappBase();
const HYDRA = siblingRoot("Hydra");
const PP = siblingRoot("pair-programmer");
const EXEC = siblingRoot("ExecutiveSuite");

describe("writeback — sandbox invariants (HARD INVARIANT #6)", () => {
  it("pathContains rejects escape paths", () => {
    expect(pathContains(HYDRA, `${EXEC}/foo.md`)).toBe(false);
    expect(pathContains(HYDRA, `${HYDRA}/../ExecutiveSuite/foo.md`)).toBe(false);
    expect(pathContains(HYDRA, `${HYDRA}/squads/exec/squad.yaml`)).toBe(true);
  });

  it("PpWriteBridge accepts pp + user .claude; refuses others", () => {
    const b = new PpWriteBridge();
    const home = (process.env.USERPROFILE ?? process.env.HOME ?? "").replace(/\\/g, "/");
    expect(b.canHandle(`${PP}/daemon/src/index.ts`)).toBe(true);
    expect(b.canHandle(`${home}/.claude/teams/feature-team.yaml`)).toBe(true);
    expect(b.canHandle(`${HYDRA}/squads/exec/squad.yaml`)).toBe(false);
    expect(b.canHandle("C:/Windows/System32/cmd.exe")).toBe(false);
  });

  it("HydraWriteBridge accepts only Hydra root", () => {
    const b = new HydraWriteBridge();
    expect(b.canHandle(`${HYDRA}/squads/exec/squad.yaml`)).toBe(true);
    expect(b.canHandle(`${PP}/daemon/src/index.ts`)).toBe(false);
  });

  it("ExecSuiteWriteBridge accepts only ExecutiveSuite root", () => {
    const b = new ExecSuiteWriteBridge();
    expect(b.canHandle(`${EXEC}/.claude/agents/ceo.md`)).toBe(true);
    expect(b.canHandle(`${HYDRA}/squads/exec/squad.yaml`)).toBe(false);
  });

  it("RlmWriteBridge claims RLM* siblings under the AIAPP base", () => {
    const b = new RlmWriteBridge();
    // RLM-Creative is the canonical RLM sibling in the workspace.
    expect(b.canHandle(`${BASE}/RLM-Creative/RLM/prompts/01-discover.md`)).toBe(true);
    expect(b.canHandle(`${PP}/foo.md`)).toBe(false);
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
