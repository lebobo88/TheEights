/**
 * E2-12 — the Hydra squad registrar must converge on a re-scan.
 *
 * Three regressions are covered:
 *  1. walk() skipped symlinked squad directories (Dirent.isDirectory() is false for a link),
 *     so squads laid out as symlinks into a sibling repo were never visited.
 *  2. The registrar's implicit `high` default asked evolution.register() to downgrade a
 *     stored `critical` resource, which is rejected — a permanent error on every run.
 *  3. A frozen resource whose source is unchanged threw out of importFromSource instead of
 *     being reported as skipped.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/stores/sqlite.js";
import { AuditEngine } from "../src/engines/audit.js";
import { PolicyEngine } from "../src/engines/policy.js";
import { EvolutionEngine, contentHash } from "../src/engines/evolution.js";
import { WriteRouter } from "../src/engines/writeback.js";
import { walk, registerFile } from "../src/engines/registrars/common.js";
import type { Envelope } from "../src/schemas/envelope.js";

const env: Envelope = {
  tenant_id: "local", actor_id: "registrar-converge-test",
  project_id: "hydra", domain: "code", scope: [], trace_id: "t-e2-12",
};

describe("E2-12 — registrar convergence", () => {
  let dir: string;
  let sql: SqliteStore;
  let engine: EvolutionEngine;
  let squadsDir: string;
  let symlinkSupported = true;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-e2-12-"));
    squadsDir = join(dir, "squads");
    mkdirSync(squadsDir, { recursive: true });
    sql = new SqliteStore(join(dir, "state.db"));
    sql.migrate();
    sql.db.prepare(
      `INSERT OR IGNORE INTO actors(actor_id, kind, created_at) VALUES (?, 'agent', datetime('now'))`,
    ).run(env.actor_id);
    const audit = new AuditEngine(sql, join(dir, "events"));
    engine = new EvolutionEngine(sql, join(dir, "resources"), new PolicyEngine(sql), audit);
    engine.setWriteRouter(new WriteRouter([]));

    // A real squad directory.
    mkdirSync(join(squadsDir, "engineering"), { recursive: true });
    writeFileSync(join(squadsDir, "engineering", "squad.yaml"), "slug: engineering\n");

    // A squad that lives outside the tree and is symlinked in (Hydra's marketing-* layout).
    const external = join(dir, "external", "marketing-ops");
    mkdirSync(external, { recursive: true });
    writeFileSync(join(external, "squad.yaml"), "slug: marketing-ops\n");
    try {
      symlinkSync(external, join(squadsDir, "marketing-ops"), "junction");
    } catch {
      symlinkSupported = false;
    }
  });

  afterAll(() => { sql.close(); rmSync(dir, { recursive: true, force: true }); });

  it("walk() follows a symlinked squad directory and finds its squad.yaml", () => {
    if (!symlinkSupported) return; // unprivileged host without symlink rights
    const found = walk(squadsDir, (f) => f.endsWith("squad.yaml"), 3);
    const slugs = found.map((p) => p.split(/[\\/]/).slice(-2, -1)[0]).sort();
    expect(slugs).toEqual(["engineering", "marketing-ops"]);
  });

  it("walk() terminates on a self-referential symlink cycle", () => {
    if (!symlinkSupported) return;
    const cyclic = join(dir, "cyclic");
    mkdirSync(cyclic, { recursive: true });
    writeFileSync(join(cyclic, "squad.yaml"), "slug: cyclic\n");
    try {
      symlinkSync(cyclic, join(cyclic, "self"), "junction");
    } catch {
      return;
    }
    const found = walk(cyclic, (f) => f.endsWith("squad.yaml"), 6);
    expect(found.length).toBe(1);
  });

  it("re-registering a stored 'critical' resource with the default 'high' does not error", () => {
    const filePath = join(squadsDir, "engineering", "squad.yaml");
    const rid = "resource:hydra.squad.engineering";
    // The store already holds this squad at the more severe class.
    const first = registerFile(engine, env, {
      source_path: filePath, kind: "squad", risk_class: "critical", consumer: "hydra", rid,
    });
    expect(first.kind).toBe("registered");
    expect(engine.getResource(rid)!.risk_class).toBe("critical");

    // The registrar re-scans with its implicit 'high' default. This must not throw.
    const second = registerFile(engine, env, {
      source_path: filePath, kind: "squad", risk_class: "high", consumer: "hydra", rid,
    });
    expect(second.kind).toBe("skipped");
    expect(second.risk_class_deferred).toBe("critical");
    // Governance is NOT weakened: the stored class stays critical.
    expect(engine.getResource(rid)!.risk_class).toBe("critical");
  });

  it("an explicit downgrade through evolution.register() is still rejected", () => {
    const rid = "resource:hydra.squad.engineering";
    expect(() => engine.register(env, {
      rid, kind: "squad", risk_class: "low",
      initial_content: "slug: engineering\n", consumer: "hydra",
    })).toThrow(/cannot downgrade risk_class/);
  });

  it("a frozen, unchanged resource is skipped rather than erroring", () => {
    const squadDir = join(squadsDir, "executive");
    mkdirSync(squadDir, { recursive: true });
    const filePath = join(squadDir, "squad.yaml");
    const content = "slug: executive\n";
    writeFileSync(filePath, content);
    const rid = "resource:hydra.squad.executive";

    const first = registerFile(engine, env, {
      source_path: filePath, kind: "squad", risk_class: "critical", consumer: "hydra", rid,
    });
    expect(first.kind).toBe("registered");
    const stored = engine.getResource(rid)!;
    expect(stored.evolution_policy).toBe("frozen");
    expect(stored.current_version).toBe(contentHash(content));

    const second = registerFile(engine, env, {
      source_path: filePath, kind: "squad", risk_class: "high", consumer: "hydra", rid,
    });
    expect(second.kind).toBe("skipped");
    expect(second.reason).toBe("frozen, unchanged");
  });

  it("a frozen resource whose source HAS changed still surfaces an error", () => {
    const filePath = join(squadsDir, "executive", "squad.yaml");
    writeFileSync(filePath, "slug: executive\nchanged: true\n");
    expect(() => registerFile(engine, env, {
      source_path: filePath, kind: "squad", risk_class: "high",
      consumer: "hydra", rid: "resource:hydra.squad.executive",
    })).toThrow(/frozen/);
  });
});
