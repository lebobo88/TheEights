import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pino from "pino";
import { SqliteStore } from "../src/stores/sqlite.js";
import { AuditEngine } from "../src/engines/audit.js";
import { PolicyEngine } from "../src/engines/policy.js";
import { EvolutionEngine } from "../src/engines/evolution.js";
import { WriteRouter } from "../src/engines/writeback.js";
import { registerFile } from "../src/engines/registrars/common.js";
import type { Envelope } from "../src/schemas/envelope.js";

describe("registration — source-anchored resources", () => {
  let dir: string;
  let sql: SqliteStore;
  let engine: EvolutionEngine;
  let srcDir: string;
  const env: Envelope = {
    tenant_id: "local", actor_id: "registrar-test",
    project_id: "pair-programmer", domain: "code",
    scope: [], trace_id: "t-reg",
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-reg-"));
    srcDir = join(dir, "fake-consumer");
    mkdirSync(srcDir, { recursive: true });
    sql = new SqliteStore(join(dir, "state.db"));
    sql.migrate();
    const audit = new AuditEngine(sql, join(dir, "events"));
    const policy = new PolicyEngine(sql);
    engine = new EvolutionEngine(sql, join(dir, "resources"), policy, audit);
    engine.setWriteRouter(new WriteRouter([])); // no bridges for these tests
  });

  afterAll(() => { sql.close(); rmSync(dir, { recursive: true, force: true }); });

  it("registers a file as a resource with source_paths attached", () => {
    const filePath = join(srcDir, "agent-a.md");
    writeFileSync(filePath, "you are agent A");
    const result = registerFile(engine, env, {
      source_path: filePath, kind: "agent", risk_class: "high",
      consumer: "pp", rid: "resource:pp.agent.agent-a",
    });
    expect(result.kind).toBe("registered");
    const r = engine.getResource("resource:pp.agent.agent-a");
    expect(r).not.toBeNull();
    expect(r!.sources.length).toBe(1);
    expect(r!.sources[0]?.source_path).toBe(resolve(filePath));
    expect(r!.evolution_policy).toBe("hitl-only"); // risk=high → hitl-only
  });

  it("is idempotent on rerun (unchanged file)", () => {
    const filePath = join(srcDir, "agent-a.md");
    const result = registerFile(engine, env, {
      source_path: filePath, kind: "agent", risk_class: "high",
      consumer: "pp", rid: "resource:pp.agent.agent-a",
    });
    expect(result.kind).toBe("skipped");
    expect(result.reason).toBe("unchanged");
  });

  it("queues a proposal (not a direct write) when the source file changes for a hitl-only resource", () => {
    // register_now bypass fix: importFromSource on a hitl-only resource must NOT
    // directly mutate current_version. It routes through propose() so the operator
    // approves before any commit. The resource version stays at 1 (unchanged).
    const filePath = join(srcDir, "agent-a.md");
    writeFileSync(filePath, "you are agent A v2 — updated by human");
    const result = registerFile(engine, env, {
      source_path: filePath, kind: "agent", risk_class: "high",
      consumer: "pp", rid: "resource:pp.agent.agent-a",
    });
    expect(result.kind).toBe("updated");  // registerFile still returns "updated" (it called importFromSource)
    const r = engine.getResource("resource:pp.agent.agent-a")!;
    // Version count stays 1 — the change is pending as a proposal, not committed.
    expect(r.versions.length).toBe(1);
    // A pending proposal should exist for this resource.
    const pending = engine.listPending();
    expect(pending.some((p) => p.resource_rid === "resource:pp.agent.agent-a")).toBe(true);
  });

  it("assigns critical+frozen for security/contract/spec rubrics", () => {
    const filePath = join(srcDir, "security-injection.md");
    writeFileSync(filePath, "# security rubric body");
    registerFile(engine, env, {
      source_path: filePath, kind: "rubric", risk_class: "critical",
      consumer: "pp", rid: "resource:pp.rubric.security-injection",
    });
    const r = engine.getResource("resource:pp.rubric.security-injection")!;
    expect(r.risk_class).toBe("critical");
    expect(r.evolution_policy).toBe("frozen");
  });
});
