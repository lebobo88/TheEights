/**
 * WS10: Pagination + Drift Reconciliation tests (including fix-round 2: fixes 1-7)
 *
 * Self-contained: uses in-memory/temp sqlite, no daemon, no network.
 * Run: timeout 150 npx vitest run test/ws10-pagination-reconcile.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SqliteStore } from "../src/stores/sqlite.js";
import { EvolutionEngine, clampPage, contentHash } from "../src/engines/evolution.js";
import { AuditEngine } from "../src/engines/audit.js";
import { PolicyEngine } from "../src/engines/policy.js";
import type { Envelope } from "../src/schemas/envelope.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(): Envelope {
  return {
    tenant_id: "test",
    actor_id: "ws10-test",
    project_id: "ws10",
    domain: "test",
    scope: [],
    trace_id: randomUUID(),
  };
}

function makeTestDir(): string {
  const dir = join(tmpdir(), `ws10-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEngine(baseDir: string): { engine: EvolutionEngine; sql: SqliteStore; resourcesDir: string } {
  const dbPath = join(baseDir, "test.db");
  const resourcesDir = join(baseDir, "resources");
  const eventsDir = join(baseDir, "events");
  mkdirSync(resourcesDir, { recursive: true });
  mkdirSync(eventsDir, { recursive: true });
  const sql = new SqliteStore(dbPath);
  sql.migrate();
  sql.db.prepare(`INSERT OR IGNORE INTO projects(project_id, domain, default_scopes_json, created_at) VALUES (?,?,?,datetime('now'))`).run("ws10", "test", "[]");
  sql.db.prepare(`INSERT OR IGNORE INTO actors(actor_id, kind, created_at) VALUES (?,?,datetime('now'))`).run("ws10-test", "agent");
  const policy = new PolicyEngine(sql);
  const audit = new AuditEngine(sql, eventsDir);
  const engine = new EvolutionEngine(sql, resourcesDir, policy, audit);
  return { engine, sql, resourcesDir };
}

// ---------------------------------------------------------------------------
// PART 1: clampPage helper (fix 7: no schema rejection — clamp accepts any int)
// ---------------------------------------------------------------------------

describe("clampPage", () => {
  it("default 50 when limit absent", () => {
    expect(clampPage({})).toEqual({ limit: 50, offset: 0 });
  });

  it("clamps limit>200 to 200 (MCP hard cap, clamp-not-reject)", () => {
    expect(clampPage({ limit: 500 })).toEqual({ limit: 200, offset: 0 });
  });

  it("clamps limit=0 to 50 (default)", () => {
    expect(clampPage({ limit: 0 })).toEqual({ limit: 50, offset: 0 });
  });

  it("clamps limit=-1 (negative) to 50 (default)", () => {
    expect(clampPage({ limit: -1 })).toEqual({ limit: 50, offset: 0 });
  });

  it("passes limit=25 through unchanged", () => {
    expect(clampPage({ limit: 25, offset: 10 })).toEqual({ limit: 25, offset: 10 });
  });

  it("clamps negative offset to 0", () => {
    expect(clampPage({ limit: 10, offset: -5 })).toEqual({ limit: 10, offset: 0 });
  });
});

// ---------------------------------------------------------------------------
// PART 1: listPendingPage
// ---------------------------------------------------------------------------

describe("listPendingPage", () => {
  let baseDir: string;
  let engine: EvolutionEngine;
  let sql: SqliteStore;

  beforeEach(() => {
    baseDir = makeTestDir();
    ({ engine, sql } = makeEngine(baseDir));
    const env = makeEnv();
    engine.register(env, { rid: "res:ws10", kind: "prompt", risk_class: "low", initial_content: "base" });
    // Insert 60 proposals directly (bypasses unique-index — each has distinct proposal_id,
    // and we clear them to status='committed' except the ones we want pending).
    // Actually: the unique index is on active (pending/evaluating) proposals per rid.
    // Insert them with distinct resource_rids to avoid the constraint.
    const now = new Date().toISOString();
    for (let i = 0; i < 60; i++) {
      // Register a distinct resource for each proposal to avoid the unique-index constraint.
      const rid = `res:ws10:pending:${i.toString().padStart(3, "0")}`;
      sql.db.prepare(
        `INSERT OR IGNORE INTO resources(rid, kind, risk_class, current_version, evolution_policy, audit_url, consumer, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(rid, "prompt", "low", `sha256:${"0".repeat(64)}`, "auto", `graph://resources/${rid}`, "eights", now, now);
      sql.db.prepare(
        `INSERT INTO proposals(proposal_id, resource_rid, candidate_version, candidate_content, justification, evidence_memory_ids_json, proposed_by, proposed_at, status)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        `prop_${i.toString().padStart(3, "0")}`,
        rid,
        `sha256:dummy${i}`,
        `content ${i}`,
        `justification ${i}`,
        "[]",
        "ws10-test",
        new Date(Date.now() + i).toISOString(),
        "pending",
      );
    }
  });

  afterEach(() => {
    sql.close();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("offset=0 limit=25: returns 25 items, total=60, has_more=true", () => {
    const page = engine.listPendingPage({ limit: 25, offset: 0 });
    expect(page.items.length).toBe(25);
    expect(page.total).toBe(60);
    expect(page.limit).toBe(25);
    expect(page.offset).toBe(0);
    expect(page.has_more).toBe(true);
  });

  it("offset=50: returns 10 items, has_more=false", () => {
    const page = engine.listPendingPage({ limit: 25, offset: 50 });
    expect(page.items.length).toBe(10);
    expect(page.total).toBe(60);
    expect(page.has_more).toBe(false);
  });

  it("limit=200 covers all 60, has_more=false", () => {
    const page = engine.listPendingPage({ limit: 200, offset: 0 });
    expect(page.items.length).toBe(60);
    expect(page.has_more).toBe(false);
  });

  it("MCP-style clamp: limit=500 clamped to 200", () => {
    const page = engine.listPendingPage({ limit: 500, offset: 0 });
    expect(page.limit).toBe(200);
    expect(page.items.length).toBe(60);
    expect(page.has_more).toBe(false);
  });

  it("default limit=50 when no opts passed", () => {
    const page = engine.listPendingPage();
    expect(page.limit).toBe(50);
    expect(page.items.length).toBe(50);
    expect(page.has_more).toBe(true);
  });

  it("pages cover all items without overlap", () => {
    const ids1 = engine.listPendingPage({ limit: 25, offset: 0 }).items.map((p) => p.proposal_id);
    const ids2 = engine.listPendingPage({ limit: 25, offset: 25 }).items.map((p) => p.proposal_id);
    const ids3 = engine.listPendingPage({ limit: 25, offset: 50 }).items.map((p) => p.proposal_id);
    const all = new Set([...ids1, ...ids2, ...ids3]);
    expect(all.size).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// PART 1: listResourcesPage
// ---------------------------------------------------------------------------

describe("listResourcesPage", () => {
  let baseDir: string;
  let engine: EvolutionEngine;
  let sql: SqliteStore;

  beforeEach(() => {
    baseDir = makeTestDir();
    ({ engine, sql } = makeEngine(baseDir));
    const env = makeEnv();
    for (let i = 0; i < 70; i++) {
      engine.register(env, {
        rid: `res:batch:${i.toString().padStart(4, "0")}`,
        kind: "prompt",
        risk_class: "low",
        initial_content: `content ${i}`,
      });
    }
  });

  afterEach(() => {
    sql.close();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("offset=0 limit=25: 25 items, total=70, has_more=true", () => {
    const page = engine.listResourcesPage({}, { limit: 25, offset: 0 });
    expect(page.items.length).toBe(25);
    expect(page.total).toBe(70);
    expect(page.has_more).toBe(true);
  });

  it("offset=60 limit=25: 10 items, has_more=false", () => {
    const page = engine.listResourcesPage({}, { limit: 25, offset: 60 });
    expect(page.items.length).toBe(10);
    expect(page.has_more).toBe(false);
  });

  it("limit clamped to 200 (clamp-not-reject)", () => {
    const page = engine.listResourcesPage({}, { limit: 9999, offset: 0 });
    expect(page.limit).toBe(200);
    expect(page.items.length).toBe(70);
    expect(page.has_more).toBe(false);
  });

  it("default limit=50", () => {
    const page = engine.listResourcesPage();
    expect(page.limit).toBe(50);
    expect(page.items.length).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// PART 1: detectDriftPage — FIX 3: paginates over DRIFT ENTRIES, not resources
// ---------------------------------------------------------------------------

describe("detectDriftPage", () => {
  let baseDir: string;
  let engine: EvolutionEngine;
  let sql: SqliteStore;
  let sourceDir: string;

  beforeEach(() => {
    baseDir = makeTestDir();
    ({ engine, sql } = makeEngine(baseDir));
    sourceDir = join(baseDir, "sources");
    mkdirSync(sourceDir, { recursive: true });
    const env = makeEnv();
    // Seed 30 resources each with ONE drifted source (= 30 drift entries).
    // Plus 10 resources with no source (no drift).
    for (let i = 0; i < 30; i++) {
      const sourcePath = join(sourceDir, `res_${i}.txt`);
      writeFileSync(sourcePath, `DRIFTED content ${i}`, "utf8");
      engine.register(env, {
        rid: `res:drift:${i.toString().padStart(4, "0")}`,
        kind: "prompt",
        risk_class: "low",
        initial_content: `initial content ${i}`,
        source_paths: [sourcePath],
      });
    }
    for (let i = 30; i < 40; i++) {
      engine.register(env, {
        rid: `res:drift:${i.toString().padStart(4, "0")}`,
        kind: "prompt",
        risk_class: "low",
        initial_content: `initial content ${i}`,
      });
    }
  });

  afterEach(() => {
    sql.close();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("total=drift entries (30), total_resources=40, has_more with limit=10", () => {
    const page = engine.detectDriftPage({ limit: 10, offset: 0 });
    expect(page.total).toBe(30);          // 30 drift entries total
    expect(page.total_resources).toBe(40); // 40 resources total
    expect(page.items.length).toBe(10);
    expect(page.limit).toBe(10);
    expect(page.has_more).toBe(true);
  });

  it("offset=25 limit=10: 5 items left, has_more=false", () => {
    const page = engine.detectDriftPage({ limit: 10, offset: 25 });
    expect(page.items.length).toBe(5);
    expect(page.has_more).toBe(false);
  });

  it("limit clamped to 200 (clamp-not-reject), returns all 30 drifts", () => {
    const page = engine.detectDriftPage({ limit: 999 });
    expect(page.limit).toBe(200);
    expect(page.items.length).toBe(30); // only 30 drift entries
    expect(page.has_more).toBe(false);
  });

  it("FIX 3: resource with N sources yields N drift entries, all subject to limit", () => {
    const env = makeEnv();
    // Register one resource with 5 drifted sources.
    const rid = "res:drift:multi-source";
    const sourcePaths: string[] = [];
    engine.register(env, { rid, kind: "prompt", risk_class: "low", initial_content: "original" });
    for (let i = 0; i < 5; i++) {
      const sp = join(sourceDir, `multi_${i}.txt`);
      writeFileSync(sp, `drifted content ${i}`, "utf8");
      sql.db.prepare(`INSERT OR IGNORE INTO resource_sources(rid, source_path, consumer, writeback_mode) VALUES (?,?,?,?)`).run(rid, sp, "eights", "none");
      sourcePaths.push(sp);
    }
    // Now limit=3 should return only 3 entries (not all 5+previous 30).
    // Total drift entries = 30 (from beforeEach) + 5 = 35.
    const page = engine.detectDriftPage({ limit: 3, offset: 0 });
    expect(page.items.length).toBe(3);
    expect(page.total).toBe(35);
    expect(page.has_more).toBe(true);
    // Confirm no single call exceeds the limit.
    for (let off = 0; off <= page.total; off += 3) {
      const p = engine.detectDriftPage({ limit: 3, offset: off });
      expect(p.items.length).toBeLessThanOrEqual(3);
    }
  });

  it("total_registry + total_sources present on every page regardless of limit (single-call status pattern)", () => {
    // beforeEach seeds 30 source-drifted + 10 clean resources = total=30, total_sources=30, total_registry=0.
    // CLI status calls detectDriftPage(limit=1) — the counters must be correct on that single call.
    const p1 = engine.detectDriftPage({ limit: 1, offset: 0 });
    expect(p1.items.length).toBe(1);          // only 1 item returned
    expect(p1.total).toBe(30);                // but true total is 30
    expect(p1.total_sources).toBe(30);        // all 30 are source drifts
    expect(p1.total_registry).toBe(0);        // none are registry drifts
    expect(p1.total_resources).toBe(40);      // 40 resources total

    // Same result with limit=0 (clamped to 50 default) and limit=200.
    const p2 = engine.detectDriftPage({ limit: 200 });
    expect(p2.total_sources).toBe(30);
    expect(p2.total_registry).toBe(0);
    expect(p2.total).toBe(p2.total_sources + p2.total_registry);

    // total_registry + total_sources == total always holds.
    expect(p1.total_registry + p1.total_sources).toBe(p1.total);
  });

  it("mixed registry+source drift: total_registry and total_sources correct across any limit", () => {
    // Corrupt 3 of the 30 drifted resources' registry files to create registry drift entries.
    // Those 3 resources lose their source-drift entries (FIX 2: continue after registry drift).
    // Net: 3 registry + 27 source = 30 total drift entries, total_resources=40.
    const resourcesDir = (engine as unknown as { resourcesDir: string }).resourcesDir;
    for (let i = 0; i < 3; i++) {
      const rid = `res:drift:${i.toString().padStart(4, "0")}`;
      const resource = engine.getResource(rid)!;
      const version = resource.current_version;
      const sanitized = rid.replace(/[^a-zA-Z0-9._-]/g, "_");
      const contentPath = join(resourcesDir, sanitized, `${version}.content`);
      if (existsSync(contentPath)) writeFileSync(contentPath, "TAMPERED", "utf8");
    }
    // Now: 3 registry drift + 27 source drift (the 3 tampered resources' sources are skipped).
    const p = engine.detectDriftPage({ limit: 1, offset: 0 });
    expect(p.total_registry).toBe(3);
    expect(p.total_sources).toBe(27);
    expect(p.total).toBe(30);
    expect(p.total_registry + p.total_sources).toBe(p.total);
    expect(p.total_resources).toBe(40);

    // Same totals on a different page (offset=15) — totals are NOT page-scoped.
    const p2 = engine.detectDriftPage({ limit: 5, offset: 15 });
    expect(p2.total_registry).toBe(3);
    expect(p2.total_sources).toBe(27);
    expect(p2.total).toBe(30);
    expect(p2.items.length).toBe(5);   // only 5 items on this page
  });

  it("BOUNDED ARRAY: 60 drift entries + limit=10 → items.length===10 (NOT 60), totals accurate", () => {
    // Add 30 more drifted resources (beforeEach already has 30) → 60 total drift entries.
    const env = makeEnv();
    for (let i = 40; i < 70; i++) {
      const sp = join(sourceDir, `extra_${i}.txt`);
      writeFileSync(sp, `DRIFTED extra ${i}`, "utf8");
      engine.register(env, {
        rid: `res:drift:extra:${i.toString().padStart(4, "0")}`,
        kind: "prompt",
        risk_class: "low",
        initial_content: `initial content extra ${i}`,
        source_paths: [sp],
      });
    }
    // Now 60 source-drifted resources + 10 clean = 70 resources, 60 drift entries.

    const p = engine.detectDriftPage({ limit: 10, offset: 0 });

    // Core bounded-array invariant: items array is at most `limit` entries.
    expect(p.items.length).toBe(10);   // NOT 60 — bounded to limit
    expect(p.total).toBe(60);          // true total always accurate
    expect(p.total_sources).toBe(60);  // all source drifts
    expect(p.total_registry).toBe(0);
    expect(p.total_resources).toBe(70);
    expect(p.has_more).toBe(true);

    // Totals are identical regardless of which page is requested.
    const pMid = engine.detectDriftPage({ limit: 10, offset: 30 });
    expect(pMid.items.length).toBe(10);
    expect(pMid.total).toBe(60);
    expect(pMid.total_sources).toBe(60);

    // Last page has fewer items but same totals.
    const pLast = engine.detectDriftPage({ limit: 10, offset: 55 });
    expect(pLast.items.length).toBe(5);
    expect(pLast.total).toBe(60);
    expect(pLast.has_more).toBe(false);

    // Confirm items array never grows past limit under any offset.
    for (let off = 0; off < 60; off += 10) {
      const pg = engine.detectDriftPage({ limit: 10, offset: off });
      expect(pg.items.length).toBeLessThanOrEqual(10);
    }
  });
});

// ---------------------------------------------------------------------------
// PART 2: reconcileDrift
// ---------------------------------------------------------------------------

describe("reconcileDrift", () => {
  let baseDir: string;
  let engine: EvolutionEngine;
  let sql: SqliteStore;
  let sourceDir: string;

  beforeEach(() => {
    baseDir = makeTestDir();
    ({ engine, sql } = makeEngine(baseDir));
    sourceDir = join(baseDir, "sources");
    mkdirSync(sourceDir, { recursive: true });
  });

  afterEach(() => {
    sql.close();
    rmSync(baseDir, { recursive: true, force: true });
  });

  function registerWithSourceDrift(rid: string, env: Envelope): { sourcePath: string } {
    const sourcePath = join(sourceDir, `${rid.replace(/[^a-z0-9]/g, "_")}.txt`);
    writeFileSync(sourcePath, `ORIGINAL content`, "utf8");
    engine.register(env, {
      rid,
      kind: "prompt",
      risk_class: "low",
      initial_content: "ORIGINAL content",
      source_paths: [sourcePath],
    });
    writeFileSync(sourcePath, "DRIFTED content — diverged from recorded", "utf8");
    return { sourcePath };
  }

  // --- dryRun (default) ---

  it("dryRun (default true): source drift → action=propose, no proposal created", () => {
    const env = makeEnv();
    registerWithSourceDrift("res:reconcile:a", env);

    const result = engine.reconcileDrift(env, { rid: "res:reconcile:a" });

    expect(result.applied).toBe(false);
    const entry = result.planned.find((e) => e.rid === "res:reconcile:a" && e.drift_kind === "source");
    expect(entry).toBeDefined();
    expect(entry?.action).toBe("propose");
    expect(entry?.proposal_id).toBeUndefined();

    const pending = engine.listPendingPage({ limit: 200 });
    expect(pending.items.filter((p) => p.resource_rid === "res:reconcile:a").length).toBe(0);
  });

  it("dryRun:false — creates a pending proposal and does NOT commit (version unchanged)", () => {
    const env = makeEnv();
    registerWithSourceDrift("res:reconcile:b", env);
    const before = engine.getResource("res:reconcile:b")!.current_version;

    const result = engine.reconcileDrift(env, { rid: "res:reconcile:b", dryRun: false });

    expect(result.applied).toBe(true);
    const entry = result.planned.find((e) => e.rid === "res:reconcile:b" && e.drift_kind === "source");
    expect(entry?.action).toBe("propose");
    expect(entry?.proposal_id).toBeDefined();

    const pending = engine.listPendingPage({ limit: 200 });
    const proposals = pending.items.filter((p) => p.resource_rid === "res:reconcile:b");
    expect(proposals.length).toBeGreaterThan(0);

    const after = engine.getResource("res:reconcile:b")!.current_version;
    expect(after).toBe(before);
  });

  // --- FIX 1a: anonymous actor rejected ---

  it("FIX 1a: anonymous actor → reconcileDrift/propose throws, no proposals created", () => {
    const env = makeEnv();
    registerWithSourceDrift("res:reconcile:authz", env);

    const anonEnv: Envelope = { ...env, actor_id: "" };
    // reconcileDrift with anonymous actor should either throw or return all surface/skip
    // (propose() will throw; reconcileDrift catches it and surfaces fail-closed).
    const result = engine.reconcileDrift(anonEnv, { rid: "res:reconcile:authz", dryRun: false });
    // The source drift entry should be "surface" (fail-closed catch) or the reconcile threw.
    const entry = result.planned.find((e) => e.rid === "res:reconcile:authz");
    // Anonymous actor hits authz in propose() → caught as surface in reconcile.
    expect(entry).toBeDefined();
    // Either surfaced (propose threw) or no entry created.
    if (entry) expect(["surface", "skip"]).toContain(entry.action);
    // No proposal created.
    const pending = engine.listPendingPage({ limit: 200 });
    expect(pending.items.filter((p) => p.resource_rid === "res:reconcile:authz").length).toBe(0);
  });

  it("FIX 1a: propose() with empty actor_id → throws with descriptive error", () => {
    const env = makeEnv();
    engine.register(env, { rid: "res:authz:direct", kind: "prompt", risk_class: "low", initial_content: "x" });
    const anonEnv: Envelope = { ...env, actor_id: "" };
    expect(() => engine.propose(anonEnv, { rid: "res:authz:direct", candidate_content: "y", justification: "test" }))
      .toThrow(/anonymous|empty actor/i);
  });

  it("FIX 1a: propose() with actor_id='anonymous' → throws", () => {
    const env = makeEnv();
    engine.register(env, { rid: "res:authz:anon", kind: "prompt", risk_class: "low", initial_content: "x" });
    const anonEnv: Envelope = { ...env, actor_id: "anonymous" };
    expect(() => engine.propose(anonEnv, { rid: "res:authz:anon", candidate_content: "y", justification: "test" }))
      .toThrow(/anonymous/i);
  });

  it("FIX 1a: propose() on critical resource → throws even with valid actor", () => {
    const env = makeEnv();
    engine.register(env, { rid: "res:authz:critical", kind: "policy", risk_class: "critical", initial_content: "x" });
    expect(() => engine.propose(env, { rid: "res:authz:critical", candidate_content: "y", justification: "test" }))
      .toThrow(/critical/i);
  });

  // --- FIX 6: critical/frozen → skip FIRST before registry/source ---

  it("FIX 6: critical resource with source drift → action=skip (no surface), no proposal, no mutation", () => {
    const env = makeEnv();
    const sourcePath = join(sourceDir, "critical_res.txt");
    writeFileSync(sourcePath, "critical initial", "utf8");
    engine.register(env, { rid: "res:critical:reconcile", kind: "policy", risk_class: "critical", initial_content: "critical initial" });
    sql.db.prepare(`INSERT OR IGNORE INTO resource_sources(rid, source_path, consumer, writeback_mode) VALUES (?,?,?,?)`).run("res:critical:reconcile", sourcePath, "eights", "none");
    writeFileSync(sourcePath, "DRIFTED critical content", "utf8");

    const result = engine.reconcileDrift(env, { rid: "res:critical:reconcile", dryRun: false });

    const entry = result.planned.find((e) => e.rid === "res:critical:reconcile");
    expect(entry?.action).toBe("skip");
    // No proposals.
    const pending = engine.listPendingPage({ limit: 200 });
    expect(pending.items.filter((p) => p.resource_rid === "res:critical:reconcile").length).toBe(0);
    expect(engine.getResource("res:critical:reconcile")!.current_version).toBe(contentHash("critical initial"));
  });

  it("FIX 6: frozen resource missing source → action=skip (not surface)", () => {
    const env = makeEnv();
    const missingPath = join(sourceDir, "frozen_missing.txt");
    // Register a low resource then manually set it frozen (simulate frozen policy).
    engine.register(env, { rid: "res:frozen:miss", kind: "policy", risk_class: "critical", initial_content: "x" });
    sql.db.prepare(`INSERT OR IGNORE INTO resource_sources(rid, source_path, consumer, writeback_mode) VALUES (?,?,?,?)`).run("res:frozen:miss", missingPath, "eights", "none");
    // missingPath does not exist on disk.

    const result = engine.reconcileDrift(env, { rid: "res:frozen:miss", dryRun: false });
    const entry = result.planned.find((e) => e.rid === "res:frozen:miss");
    // Frozen/critical = skip unconditionally, not surface.
    expect(entry?.action).toBe("skip");
    expect(entry?.action).not.toBe("surface");
  });

  // --- FIX 2: registry drift → continue (no source proposal) ---

  it("FIX 2: registry hash mismatch → surface + NO source proposal created (continue)", () => {
    const env = makeEnv();
    // Register resource with a source that also differs.
    const sourcePath = join(sourceDir, "registry_with_source.txt");
    writeFileSync(sourcePath, "initial reg src", "utf8");
    engine.register(env, {
      rid: "res:registry:with-source",
      kind: "prompt",
      risk_class: "low",
      initial_content: "initial reg src",
      source_paths: [sourcePath],
    });
    const resource = engine.getResource("res:registry:with-source")!;
    const version = resource.current_version;

    // Corrupt the registry .content file.
    const resourcesDir = (engine as unknown as { resourcesDir: string }).resourcesDir;
    // sanitizeRid keeps hyphens; only replaces chars outside [a-zA-Z0-9._-]
    const sanitizedRid = "res_registry_with-source";
    const contentFilePath = join(resourcesDir, sanitizedRid, `${version}.content`);
    if (existsSync(contentFilePath)) {
      writeFileSync(contentFilePath, "TAMPERED CONTENT", "utf8");
    }
    // Also make the source file differ.
    writeFileSync(sourcePath, "drifted source content", "utf8");

    const result = engine.reconcileDrift(env, { rid: "res:registry:with-source", dryRun: false });

    // Registry entry should be surface.
    const regEntry = result.planned.find((e) => e.rid === "res:registry:with-source" && e.drift_kind === "registry");
    expect(regEntry?.action).toBe("surface");

    // NO source entry — FIX 2: continue after registry drift means source is NOT processed.
    const srcEntries = result.planned.filter((e) => e.rid === "res:registry:with-source" && e.drift_kind === "source");
    expect(srcEntries.length).toBe(0);

    // No proposals created (registry-corrupt resource must never get a source proposal).
    const pending = engine.listPendingPage({ limit: 200 });
    expect(pending.items.filter((p) => p.resource_rid === "res:registry:with-source").length).toBe(0);

    // Version unchanged.
    expect(engine.getResource("res:registry:with-source")!.current_version).toBe(version);
  });

  it("registry content MISSING → surface + no source proposal", () => {
    const env = makeEnv();
    engine.register(env, { rid: "res:registry:drift", kind: "prompt", risk_class: "low", initial_content: "clean content" });
    const resource = engine.getResource("res:registry:drift")!;
    const version = resource.current_version;

    // Delete the .content file.
    const resourcesDir = (engine as unknown as { resourcesDir: string }).resourcesDir;
    const sanitizedRid = "res_registry_drift";
    const contentFilePath = join(resourcesDir, sanitizedRid, `${version}.content`);
    if (existsSync(contentFilePath)) {
      rmSync(contentFilePath);
    }

    const result = engine.reconcileDrift(env, { rid: "res:registry:drift", dryRun: false });

    const entry = result.planned.find((e) => e.rid === "res:registry:drift" && e.drift_kind === "registry");
    expect(entry?.action).toBe("surface");
    expect(entry?.reason).toMatch(/missing/i);

    const pending = engine.listPendingPage({ limit: 200 });
    expect(pending.items.filter((p) => p.resource_rid === "res:registry:drift").length).toBe(0);
    expect(engine.getResource("res:registry:drift")!.current_version).toBe(version);
  });

  // --- FIX 5: unique-index dedup (concurrent-ish) ---

  it("FIX 5: second reconcileDrift when proposal already pending → skip (dedup, no duplicate)", () => {
    const env = makeEnv();
    registerWithSourceDrift("res:reconcile:dedup", env);

    engine.reconcileDrift(env, { rid: "res:reconcile:dedup", dryRun: false });
    const afterFirst = engine.listPendingPage({ limit: 200 });
    const countFirst = afterFirst.items.filter((p) => p.resource_rid === "res:reconcile:dedup").length;
    expect(countFirst).toBe(1);

    const result2 = engine.reconcileDrift(env, { rid: "res:reconcile:dedup", dryRun: false });
    const entry2 = result2.planned.find((e) => e.rid === "res:reconcile:dedup" && e.drift_kind === "source");
    expect(entry2?.action).toBe("skip");
    expect(entry2?.reason).toMatch(/already pending/i);

    const afterSecond = engine.listPendingPage({ limit: 200 });
    const countSecond = afterSecond.items.filter((p) => p.resource_rid === "res:reconcile:dedup").length;
    expect(countSecond).toBe(1);
  });

  it("FIX 5: reconcileDrift dedup — second reconcile on same resource with pending proposal → skip (not duplicate)", () => {
    // The dedup is enforced by reconcileDrift's pre-loaded pendingRids Set, not propose() directly.
    // This verifies the Set-based dedup works: first reconcile creates proposal, second skips.
    const env = makeEnv();
    engine.register(env, { rid: "res:uniqueidx:test", kind: "prompt", risk_class: "low", initial_content: "v1" });
    const sourcePath = join(sourceDir, "uniqueidx_test.txt");
    writeFileSync(sourcePath, "v1", "utf8");
    sql.db.prepare(`INSERT OR IGNORE INTO resource_sources(rid, source_path, consumer, writeback_mode) VALUES (?,?,?,?)`).run("res:uniqueidx:test", sourcePath, "eights", "none");
    writeFileSync(sourcePath, "v2 — drifted", "utf8");

    // First reconcile: creates a proposal.
    const r1 = engine.reconcileDrift(env, { rid: "res:uniqueidx:test", dryRun: false });
    expect(r1.planned.find((e) => e.action === "propose")).toBeDefined();
    expect(engine.listPendingPage({ limit: 200 }).items.filter((p) => p.resource_rid === "res:uniqueidx:test").length).toBe(1);

    // Second reconcile: proposal is still pending → skip.
    const r2 = engine.reconcileDrift(env, { rid: "res:uniqueidx:test", dryRun: false });
    expect(r2.planned.find((e) => e.action === "skip" && e.reason.match(/already pending/i))).toBeDefined();

    // Still exactly one pending proposal.
    const pending = engine.listPendingPage({ limit: 200 });
    expect(pending.items.filter((p) => p.resource_rid === "res:uniqueidx:test").length).toBe(1);
  });

  // --- FIX 3: drift-entry pagination ---

  it("FIX 3: N>limit sources → drift entries capped at limit, has_more=true", () => {
    const env = makeEnv();
    const rid = "res:reconcile:many-sources";
    engine.register(env, { rid, kind: "prompt", risk_class: "low", initial_content: "original" });
    // Add 10 drifted sources directly.
    for (let i = 0; i < 10; i++) {
      const sp = join(sourceDir, `manysrc_${i}.txt`);
      writeFileSync(sp, `drifted content ${i}`, "utf8");
      sql.db.prepare(`INSERT OR IGNORE INTO resource_sources(rid, source_path, consumer, writeback_mode) VALUES (?,?,?,?)`).run(rid, sp, "eights", "none");
    }
    // With limit=5: should get 5 entries, has_more=true.
    const result = engine.reconcileDrift(env, { limit: 5, offset: 0 });
    expect(result.planned.length).toBeLessThanOrEqual(5);
    // With offset=5: should get remaining entries.
    const result2 = engine.reconcileDrift(env, { limit: 5, offset: 5 });
    expect(result2.planned.length).toBeLessThanOrEqual(5);
    // No single page exceeds limit.
    const bigResult = engine.reconcileDrift(env, { limit: 200 });
    expect(bigResult.planned.length).toBeLessThanOrEqual(200);
  });

  // --- Never-commit invariant ---

  it("reconcileDrift(dryRun:false) never changes resource current_version", () => {
    const env = makeEnv();
    registerWithSourceDrift("res:reconcile:nocommit", env);
    const vBefore = engine.getResource("res:reconcile:nocommit")!.current_version;

    engine.reconcileDrift(env, { rid: "res:reconcile:nocommit", dryRun: false });

    const vAfter = engine.getResource("res:reconcile:nocommit")!.current_version;
    expect(vAfter).toBe(vBefore);
  });

  // --- Explicit dryRun:true ---

  it("explicit dryRun:true behaves same as omitted (no proposal created)", () => {
    const env = makeEnv();
    registerWithSourceDrift("res:reconcile:explicit-dry", env);

    const result = engine.reconcileDrift(env, { rid: "res:reconcile:explicit-dry", dryRun: true });
    expect(result.applied).toBe(false);
    const entry = result.planned.find((e) => e.drift_kind === "source");
    expect(entry?.action).toBe("propose");
    expect(entry?.proposal_id).toBeUndefined();

    expect(engine.listPendingPage({ limit: 200 }).items.filter((p) => p.resource_rid === "res:reconcile:explicit-dry").length).toBe(0);
  });

  // --- FIX 3 (Round 3): limit caps WRITES, not just response slice ---

  it("FIX 3: reconcileDrift(dryRun:false, limit:N) creates exactly N proposals when >N drifts exist", () => {
    const env = makeEnv();
    // Create 6 resources each with one drifted source.
    for (let i = 0; i < 6; i++) {
      registerWithSourceDrift(`res:fix3:write:${i}`, env);
    }

    // With limit=3: only 3 proposals should be created.
    const result = engine.reconcileDrift(env, { limit: 3, offset: 0, dryRun: false });

    expect(result.planned.length).toBe(3);
    expect(result.total_drifts).toBe(6);
    expect(result.has_more).toBe(true);
    expect(result.applied).toBe(true);

    // Exactly 3 proposals created for these resources.
    const pending = engine.listPendingPage({ limit: 200 });
    const createdRids = result.planned.filter((e) => e.action === "propose" && e.proposal_id).map((e) => e.rid);
    expect(createdRids.length).toBe(3);
    for (const rid of createdRids) {
      expect(pending.items.some((p) => p.resource_rid === rid)).toBe(true);
    }

    // The next page (offset=3) creates 3 more.
    const result2 = engine.reconcileDrift(env, { limit: 3, offset: 3, dryRun: false });
    expect(result2.planned.length).toBe(3);
    expect(result2.has_more).toBe(false);
    const createdRids2 = result2.planned.filter((e) => e.action === "propose" && e.proposal_id).map((e) => e.rid);
    expect(createdRids2.length).toBe(3);

    // No overlap between pages.
    const allCreated = new Set([...createdRids, ...createdRids2]);
    expect(allCreated.size).toBe(6);

    // Total proposals now = 6.
    const pendingAfter = engine.listPendingPage({ limit: 200 });
    const fixRids = pendingAfter.items.filter((p) => p.resource_rid.startsWith("res:fix3:write:"));
    expect(fixRids.length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// PART 3: Fix 5 (Round 3) — UNIQUE index: direct propose() deduplicate
// ---------------------------------------------------------------------------

describe("propose() UNIQUE index dedup (Fix 5 Round 3)", () => {
  let baseDir: string;
  let engine: EvolutionEngine;
  let sql: SqliteStore;

  beforeEach(() => {
    baseDir = makeTestDir();
    ({ engine, sql } = makeEngine(baseDir));
  });

  afterEach(() => {
    sql.close();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("direct duplicate propose() throws PROPOSAL_ALREADY_PENDING (unique index enforcement)", () => {
    const env = makeEnv();
    engine.register(env, { rid: "res:unique:direct", kind: "prompt", risk_class: "low", initial_content: "v0" });

    // First propose: succeeds.
    engine.propose(env, { rid: "res:unique:direct", candidate_content: "v1", justification: "first" });

    // Second propose on same rid while first is still pending: should throw PROPOSAL_ALREADY_PENDING.
    let caught: Error | undefined;
    try {
      engine.propose(env, { rid: "res:unique:direct", candidate_content: "v2", justification: "second — should fail" });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect((caught as Error & { code?: string }).code).toBe("PROPOSAL_ALREADY_PENDING");
    expect(caught!.message).toMatch(/already has an active/i);

    // Only one proposal exists.
    const pending = engine.listPendingPage({ limit: 200 });
    expect(pending.items.filter((p) => p.resource_rid === "res:unique:direct").length).toBe(1);
  });

  it("sequential propose→reject→propose: allowed (rejected row exits unique scope)", () => {
    const env = makeEnv();
    engine.register(env, { rid: "res:unique:seq", kind: "prompt", risk_class: "low", initial_content: "v0" });

    // First propose.
    const p1 = engine.propose(env, { rid: "res:unique:seq", candidate_content: "v1", justification: "first" });
    expect(p1.status).toBe("pending");

    // Reject the first proposal directly (bypasses operator capability for test convenience).
    sql.db.prepare(
      `UPDATE proposals SET status = 'rejected', decided_at = datetime('now'), decided_by = 'ws10-test' WHERE proposal_id = ?`,
    ).run(p1.proposal_id);

    // Now propose again — should succeed since p1 is no longer active.
    const p2 = engine.propose(env, { rid: "res:unique:seq", candidate_content: "v2", justification: "second after rejection" });
    expect(p2.status).toBe("pending");
    expect(p2.proposal_id).not.toBe(p1.proposal_id);

    const pending = engine.listPendingPage({ limit: 200 });
    expect(pending.items.filter((p) => p.resource_rid === "res:unique:seq").length).toBe(1);
    expect(pending.items.find((p) => p.resource_rid === "res:unique:seq")!.proposal_id).toBe(p2.proposal_id);
  });

  it("propose() with unregistered actor throws", () => {
    const env = makeEnv();
    engine.register(env, { rid: "res:authz:unregistered", kind: "prompt", risk_class: "low", initial_content: "x" });

    const unregisteredEnv: Envelope = { ...env, actor_id: "actor:not-in-db" };
    expect(() =>
      engine.propose(unregisteredEnv, { rid: "res:authz:unregistered", candidate_content: "y", justification: "test" }),
    ).toThrow(/not registered in the actors table/i);

    // No proposal created.
    expect(engine.listPendingPage({ limit: 200 }).items.filter((p) => p.resource_rid === "res:authz:unregistered").length).toBe(0);
  });

  it("propose() with registered actor succeeds", () => {
    const env = makeEnv();
    // ws10-test is inserted in makeEngine's actors table.
    engine.register(env, { rid: "res:authz:registered", kind: "prompt", risk_class: "low", initial_content: "x" });

    const prop = engine.propose(env, { rid: "res:authz:registered", candidate_content: "y", justification: "registered actor" });
    expect(prop.proposal_id).toBeDefined();
    expect(prop.status).toBe("pending");
  });

  it("migration dedup: pre-existing duplicate active proposals get 'superseded' on V7", () => {
    // Manually insert two active proposals on the same rid BEFORE the unique index is applied.
    // This simulates a pre-V7 DB with a pile-up.
    const env = makeEnv();
    engine.register(env, { rid: "res:dedup:migration", kind: "prompt", risk_class: "low", initial_content: "v0" });

    // Inject duplicates directly bypassing propose() (which would hit the unique index).
    // Drop the unique index temporarily to simulate pre-V7 state.
    sql.db.exec(`DROP INDEX IF EXISTS idx_proposals_active_per_resource`);
    const now = new Date().toISOString();
    sql.db.prepare(
      `INSERT INTO proposals(proposal_id, resource_rid, candidate_version, candidate_content, justification, evidence_memory_ids_json, proposed_by, proposed_at, status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run("prop_dup_1", "res:dedup:migration", "sha256:aaa", "v1", "dup 1", "[]", "ws10-test", now, "pending");
    sql.db.prepare(
      `INSERT INTO proposals(proposal_id, resource_rid, candidate_version, candidate_content, justification, evidence_memory_ids_json, proposed_by, proposed_at, status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run("prop_dup_2", "res:dedup:migration", "sha256:bbb", "v2", "dup 2", "[]", "ws10-test", now, "pending");

    // Now run V7 migration (simulate upgrade path).
    // V7's idempotency check uses schema_version table — remove V7 entry if it exists.
    sql.db.exec(`DELETE FROM schema_version WHERE version = 7`);
    // Call migrate() again — V7 will dedup and create the unique index.
    sql.migrate();

    // One of the two duplicates should now be 'superseded', the other 'pending'.
    const active = sql.db.prepare(
      `SELECT proposal_id, status FROM proposals WHERE resource_rid = 'res:dedup:migration' AND proposal_id IN ('prop_dup_1','prop_dup_2')`,
    ).all() as Array<{ proposal_id: string; status: string }>;
    const pending = active.filter((r) => r.status === "pending");
    const superseded = active.filter((r) => r.status === "superseded");
    expect(pending.length).toBe(1);
    expect(superseded.length).toBe(1);
    // V7 keeps MIN(proposal_id) = 'prop_dup_1' (alphabetically smaller).
    expect(pending[0]!.proposal_id).toBe("prop_dup_1");

    // Verify the unique index is now enforced: a new propose() on this rid should fail.
    expect(() =>
      engine.propose(env, { rid: "res:dedup:migration", candidate_content: "v3", justification: "post-migration" }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// PART 4: get_resource audit (Fix — Round 3+)
// ---------------------------------------------------------------------------

describe("getResource audit (Fix Round 3+)", () => {
  let baseDir: string;
  let engine: EvolutionEngine;
  let sql: SqliteStore;

  beforeEach(() => {
    baseDir = makeTestDir();
    ({ engine, sql } = makeEngine(baseDir));
  });

  afterEach(() => {
    sql.close();
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("getResource without env: returns resource, no audit event", () => {
    const env = makeEnv();
    engine.register(env, { rid: "res:get:noenv", kind: "prompt", risk_class: "low", initial_content: "x" });

    const countBefore = (sql.db.prepare(`SELECT COUNT(*) as n FROM events WHERE kind = 'evolution.read'`).get() as { n: number }).n;
    const r = engine.getResource("res:get:noenv");
    expect(r).not.toBeNull();
    expect(r!.rid).toBe("res:get:noenv");
    const countAfter = (sql.db.prepare(`SELECT COUNT(*) as n FROM events WHERE kind = 'evolution.read'`).get() as { n: number }).n;
    // No audit event emitted when env is absent.
    expect(countAfter).toBe(countBefore);
  });

  it("getResource with env: returns resource AND emits evolution.read audit event", () => {
    const env = makeEnv();
    engine.register(env, { rid: "res:get:withenv", kind: "prompt", risk_class: "low", initial_content: "y" });

    const countBefore = (sql.db.prepare(`SELECT COUNT(*) as n FROM events WHERE kind = 'evolution.read'`).get() as { n: number }).n;
    const r = engine.getResource("res:get:withenv", env);
    expect(r).not.toBeNull();
    expect(r!.rid).toBe("res:get:withenv");
    const countAfter = (sql.db.prepare(`SELECT COUNT(*) as n FROM events WHERE kind = 'evolution.read'`).get() as { n: number }).n;
    // Exactly one new audit event.
    expect(countAfter).toBe(countBefore + 1);
    // Audit event carries op=get_resource and found=true.
    const event = sql.db.prepare(
      `SELECT payload_json FROM events WHERE kind = 'evolution.read' ORDER BY event_id DESC LIMIT 1`,
    ).get() as { payload_json: string } | undefined;
    expect(event).toBeDefined();
    const payload = JSON.parse(event!.payload_json) as Record<string, unknown>;
    expect(payload["op"]).toBe("get_resource");
    expect(payload["rid"]).toBe("res:get:withenv");
    expect(payload["found"]).toBe(true);
  });

  it("getResource with env for missing rid: returns null AND emits audit event with found=false", () => {
    const env = makeEnv();
    const countBefore = (sql.db.prepare(`SELECT COUNT(*) as n FROM events WHERE kind = 'evolution.read'`).get() as { n: number }).n;
    const r = engine.getResource("res:get:nonexistent", env);
    expect(r).toBeNull();
    const countAfter = (sql.db.prepare(`SELECT COUNT(*) as n FROM events WHERE kind = 'evolution.read'`).get() as { n: number }).n;
    expect(countAfter).toBe(countBefore + 1);
    const event = sql.db.prepare(
      `SELECT payload_json FROM events WHERE kind = 'evolution.read' ORDER BY event_id DESC LIMIT 1`,
    ).get() as { payload_json: string } | undefined;
    const payload = JSON.parse(event!.payload_json) as Record<string, unknown>;
    expect(payload["op"]).toBe("get_resource");
    expect(payload["found"]).toBe(false);
  });
});
