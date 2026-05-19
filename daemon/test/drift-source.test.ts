import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqliteStore } from "../src/stores/sqlite.js";
import { AuditEngine } from "../src/engines/audit.js";
import { PolicyEngine } from "../src/engines/policy.js";
import { EvolutionEngine } from "../src/engines/evolution.js";
import { WriteRouter } from "../src/engines/writeback.js";
import type { Envelope } from "../src/schemas/envelope.js";

describe("drift detection — consumer source paths", () => {
  let dir: string;
  let sql: SqliteStore;
  let engine: EvolutionEngine;
  let srcFile: string;
  const env: Envelope = {
    tenant_id: "local", actor_id: "drift-test",
    project_id: "TheEights", domain: "infra",
    scope: [], trace_id: "t-drift",
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-drift-"));
    mkdirSync(join(dir, "consumer"));
    srcFile = resolve(join(dir, "consumer", "team.yaml"));
    writeFileSync(srcFile, "name: feature-team\nstages: [spec, code]\n");
    sql = new SqliteStore(join(dir, "state.db"));
    sql.migrate();
    const audit = new AuditEngine(sql, join(dir, "events"));
    const policy = new PolicyEngine(sql);
    engine = new EvolutionEngine(sql, join(dir, "resources"), policy, audit);
    engine.setWriteRouter(new WriteRouter([]));
    engine.register(env, {
      rid: "resource:test.team.feature",
      kind: "team", risk_class: "high",
      consumer: "pp",
      initial_content: "name: feature-team\nstages: [spec, code]\n",
      source_paths: [srcFile],
    });
  });

  afterAll(() => { sql.close(); rmSync(dir, { recursive: true, force: true }); });

  it("reports clean when source matches recorded version", () => {
    const drift = engine.detectDrift();
    expect(drift.sources.length).toBe(0);
  });

  it("detects drift when source file is hand-edited", () => {
    writeFileSync(srcFile, "name: feature-team\nstages: [spec, code, deploy]\n");
    const drift = engine.detectDrift();
    expect(drift.sources.length).toBe(1);
    expect(drift.sources[0]?.source_path).toBe(srcFile);
  });

  it("flags MISSING when source file is deleted", () => {
    unlinkSync(srcFile);
    const drift = engine.detectDrift();
    expect(drift.sources.some((s) => s.on_disk_hash === "MISSING")).toBe(true);
  });
});
