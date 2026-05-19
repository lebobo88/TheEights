import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/stores/sqlite.js";
import { AuditEngine } from "../src/engines/audit.js";
import { PolicyEngine } from "../src/engines/policy.js";
import { EvolutionEngine } from "../src/engines/evolution.js";
import type { Envelope } from "../src/schemas/envelope.js";

describe("evolution — RSPL + SEPL + risk routing", () => {
  let dir: string;
  let sql: SqliteStore;
  let engine: EvolutionEngine;
  const env: Envelope = {
    tenant_id: "local", actor_id: "test", project_id: "TheEights",
    domain: "infra", scope: [], trace_id: "t-evo",
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-evo-"));
    sql = new SqliteStore(join(dir, "state.db"));
    sql.migrate();
    const audit = new AuditEngine(sql, join(dir, "events"));
    const policy = new PolicyEngine(sql);
    engine = new EvolutionEngine(sql, join(dir, "resources"), policy, audit);
    engine.seedCriticalResources();
  });

  afterAll(() => { sql.close(); rmSync(dir, { recursive: true, force: true }); });

  it("seeds critical resources and freezes them", () => {
    const policy = engine.getResource("resource:eights.policy.evolution-defaults");
    expect(policy).not.toBeNull();
    expect(policy!.evolution_policy).toBe("frozen");
    expect(() => engine.propose(env, {
      rid: "resource:eights.policy.evolution-defaults",
      candidate_content: "bad",
      justification: "should be rejected",
    })).toThrow(/frozen/);
  });

  it("auto-commits a low-risk proposal with eval_delta>=0", async () => {
    const before = engine.getResource("resource:eights.template.docs-prompt")!;
    expect(before.evolution_policy).toBe("auto");
    const prop = engine.propose(env, {
      rid: "resource:eights.template.docs-prompt",
      candidate_content: "You are a documentation author. Write for senior engineers, prefer concrete examples.",
      justification: "include 'concrete examples' guidance",
    });
    const evalReport = await engine.evaluate(env, prop.proposal_id);
    expect(evalReport.eval_delta).toBeGreaterThanOrEqual(0);
    const result = await engine.commit(env, prop.proposal_id);
    expect(result.committed).toBe(true);
    const after = engine.getResource("resource:eights.template.docs-prompt")!;
    expect(after.current_version).not.toBe(before.current_version);
    expect(after.versions.length).toBe(2);
  });

  it("rolls back to a prior version", async () => {
    const r = engine.getResource("resource:eights.template.docs-prompt")!;
    const first = r.versions[0]!;
    const result = await engine.rollback(env, r.rid, first.version);
    expect(result.current_version).toBe(first.version);
  });

  it("detects drift when on-disk content differs from recorded hash", () => {
    const drift = engine.detectDrift();
    expect(Array.isArray(drift)).toBe(true);
  });
});
