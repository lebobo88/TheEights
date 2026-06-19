import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { SqliteStore } from "../src/stores/sqlite.js";
import { VectorStore } from "../src/stores/vec.js";
import { GraphStore } from "../src/stores/graph.js";
import { AuditEngine } from "../src/engines/audit.js";
import { MemoryEngine } from "../src/engines/memory.js";
import { PolicyEngine } from "../src/engines/policy.js";
import { NullEmbedder } from "../src/embeddings.js";
import { PpBridge } from "../src/adapters/pp-bridge.js";
import { PpWatcher } from "../src/engines/pp-watcher.js";

/**
 * Regression: the pp-watcher must persist its keyset cursor and NEVER re-ingest
 * a run it has already seen — even across same-finished_at rows. The original
 * bug left the cursor unpersisted, re-ingesting every terminal run every 5s and
 * flooding `memories` with ~1244x duplicates. These tests pin: (a) the cursor
 * persists to daemon_meta, (b) a second sync ingests zero new memories, and
 * (c) rows sharing one finished_at are each ingested exactly once.
 */
describe("pp-watcher — keyset cursor never re-ingests", () => {
  let dir: string;
  let sql: SqliteStore;
  let ppPath: string;
  let watcher: PpWatcher;

  const seedPp = (): void => {
    const pp = new Database(ppPath);
    pp.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, request_text TEXT, status TEXT,
        profile_snapshot_json TEXT, taxonomy_mapping_json TEXT, finished_at TEXT);
      CREATE TABLE stages (id TEXT PRIMARY KEY, run_id TEXT, kind TEXT);
      CREATE TABLE attempts (id TEXT PRIMARY KEY, stage_id TEXT);
      CREATE TABLE verdicts (id TEXT PRIMARY KEY, attempt_id TEXT, rubric_id TEXT,
        outcome TEXT, critique_md TEXT, score_json TEXT, cross_vendor INTEGER,
        created_at TEXT, judge_producer TEXT, judge_model_id TEXT);
    `);
    const ins = pp.prepare(
      `INSERT INTO runs(id, request_text, status, finished_at) VALUES (?,?,?,?)`,
    );
    // Two runs share the exact same finished_at — the keyset (ts,id) cursor must
    // ingest both exactly once and not skip the second.
    ins.run("run_a", "do a", "complete", "2026-06-19T10:00:00.000Z");
    ins.run("run_b", "do b", "complete", "2026-06-19T10:00:00.000Z");
    ins.run("run_c", "do c", "surfaced", "2026-06-19T10:00:05.000Z");
    pp.close();
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-ppw-"));
    sql = new SqliteStore(join(dir, "state.db"));
    sql.migrate();
    const vec = new VectorStore(sql.db, 4);
    vec.load();
    const graph = new GraphStore(join(dir, "graph.kuzu"), "ladybug");
    const audit = new AuditEngine(sql, join(dir, "events"));
    const policy = new PolicyEngine(sql);
    const memory = new MemoryEngine(sql, vec, graph, audit, new NullEmbedder(4), policy);
    const bridge = new PpBridge(memory);
    ppPath = join(dir, "pp-state.db");
    seedPp();
    watcher = new PpWatcher(sql, bridge, pino({ level: "silent" }), { ppStatePath: ppPath, pollMs: 999_999 });
    watcher.start();
  });

  afterEach(() => {
    watcher.stop();
    sql.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const memCount = (): number =>
    (sql.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
  const cursor = (): string | undefined =>
    (sql.db.prepare("SELECT value FROM daemon_meta WHERE key = 'pp-watcher:runs'").get() as { value: string } | undefined)?.value;

  it("ingests each terminal run exactly once (including same-timestamp rows)", async () => {
    const res = await watcher.syncNow();
    expect(res.runs).toBe(3);
    expect(memCount()).toBe(3); // run_a, run_b (same ts), run_c — each once
  });

  it("persists the cursor and re-syncing ingests zero new memories", async () => {
    await watcher.syncNow();
    expect(cursor()).toBeDefined();
    const after = memCount();

    // Five more ticks over the same pp state must add nothing.
    for (let i = 0; i < 5; i += 1) await watcher.syncNow();
    expect(memCount()).toBe(after);
  });

  it("picks up only newly-finished runs on a later tick", async () => {
    await watcher.syncNow();
    const before = memCount();
    const pp = new Database(ppPath);
    pp.prepare(`INSERT INTO runs(id, request_text, status, finished_at) VALUES (?,?,?,?)`)
      .run("run_d", "do d", "complete", "2026-06-19T11:00:00.000Z");
    pp.close();

    const res = await watcher.syncNow();
    expect(res.runs).toBe(1);
    expect(memCount()).toBe(before + 1);
  });
});
