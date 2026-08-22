import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PpWriteBridge } from "../src/engines/writers/pp-writer.js";
import { HydraWriteBridge } from "../src/engines/writers/hydra-writer.js";
import { ExecSuiteWriteBridge } from "../src/engines/writers/execsuite-writer.js";
import { RlmWriteBridge } from "../src/engines/writers/rlm-writer.js";
import { pathContains } from "../src/engines/writeback.js";
import { loadConfig } from "../src/config.js";

// Roots are injected explicitly so these sandbox-invariant assertions are
// independent of the host's filesystem layout (HARD INVARIANT #6 / ADR-0007).
describe("writeback — sandbox invariants (HARD INVARIANT #6)", () => {
  it("pathContains rejects escape paths", () => {
    expect(pathContains("C:/AiAppDeployments/Hydra", "C:/AiAppDeployments/ExecutiveSuite/foo.md")).toBe(false);
    expect(pathContains("C:/AiAppDeployments/Hydra", "C:/AiAppDeployments/Hydra/../ExecutiveSuite/foo.md")).toBe(false);
    expect(pathContains("C:/AiAppDeployments/Hydra", "C:/AiAppDeployments/Hydra/squads/exec/squad.yaml")).toBe(true);
  });

  it("PpWriteBridge accepts pp + user .claude; refuses others", () => {
    const b = new PpWriteBridge(["C:/AiAppDeployments/pair-programmer", "C:/Users/dev/.claude"]);
    expect(b.canHandle("C:/AiAppDeployments/pair-programmer/daemon/src/index.ts")).toBe(true);
    expect(b.canHandle("C:/Users/dev/.claude/teams/feature-team.yaml")).toBe(true);
    expect(b.canHandle("C:/AiAppDeployments/Hydra/squads/exec/squad.yaml")).toBe(false);
    expect(b.canHandle("C:/Windows/System32/cmd.exe")).toBe(false);
  });

  it("HydraWriteBridge accepts only Hydra root", () => {
    const b = new HydraWriteBridge("C:/AiAppDeployments/Hydra");
    expect(b.canHandle("C:/AiAppDeployments/Hydra/squads/exec/squad.yaml")).toBe(true);
    expect(b.canHandle("C:/AiAppDeployments/pair-programmer/daemon/src/index.ts")).toBe(false);
  });

  it("ExecSuiteWriteBridge accepts only ExecutiveSuite root", () => {
    const b = new ExecSuiteWriteBridge("C:/AiAppDeployments/ExecutiveSuite");
    expect(b.canHandle("C:/AiAppDeployments/ExecutiveSuite/.claude/agents/ceo.md")).toBe(true);
    expect(b.canHandle("C:/AiAppDeployments/Hydra/squads/exec/squad.yaml")).toBe(false);
  });

  it("write() refuses non-claimed paths even if mode is in-place", async () => {
    const b = new HydraWriteBridge("C:/AiAppDeployments/Hydra");
    const r = await b.write({
      rid: "x", version: "v", content: "x",
      source_path: "C:/Windows/System32/should-never-write.txt",
      writeback_mode: "in-place",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sandbox/);
  });
});

// RlmWriteBridge discovers `^RLM*` dirs under a scan root and filters by
// existence, so it needs real directories — exercised against a temp tree to
// stay host-independent.
describe("RlmWriteBridge — scan-root discovery + sandbox", () => {
  let base: string;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "eights-rlm-"));
    mkdirSync(join(base, "RLM-CLI-Starter"), { recursive: true });
    mkdirSync(join(base, "RLMextra"), { recursive: true });
    mkdirSync(join(base, "NotRlm"), { recursive: true });
  });
  afterAll(() => { rmSync(base, { recursive: true, force: true }); });

  it("claims the starter repo and discovered ^RLM* siblings, refuses others", () => {
    const b = new RlmWriteBridge(base, join(base, "RLM-CLI-Starter"));
    expect(b.canHandle(join(base, "RLM-CLI-Starter", "RLM/prompts/01-discover.md"))).toBe(true);
    expect(b.canHandle(join(base, "RLMextra", "foo.md"))).toBe(true);
    expect(b.canHandle(join(base, "NotRlm", "foo.md"))).toBe(false);
    expect(b.canHandle("C:/AiAppDeployments/pair-programmer/foo.md")).toBe(false);
  });
});

// Proves the zero-config default wiring: arg-less bridges resolve their roots
// from loadConfig() (parent-of-repo by default), relocating — not broadening —
// the sandbox to wherever the sibling repos actually live.
describe("writeback — default roots come from config", () => {
  it("arg-less bridges claim under the configured sibling roots", () => {
    const cfg = loadConfig();
    expect(new HydraWriteBridge().canHandle(join(cfg.hydraRoot, "squads/x.yaml"))).toBe(true);
    expect(new ExecSuiteWriteBridge().canHandle(join(cfg.execsuiteRoot, ".claude/agents/ceo.md"))).toBe(true);
    const pp = new PpWriteBridge();
    expect(pp.canHandle(join(cfg.ppRoot, "daemon/src/index.ts"))).toBe(true);
    expect(pp.canHandle(join(cfg.claudeRoot, "teams/feature-team.yaml"))).toBe(true);
    // Cross-sibling escape still refused.
    expect(new HydraWriteBridge().canHandle(join(cfg.execsuiteRoot, "x.md"))).toBe(false);
  });
});
