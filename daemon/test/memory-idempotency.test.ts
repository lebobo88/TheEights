import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/stores/sqlite.js";
import { VectorStore } from "../src/stores/vec.js";
import { GraphStore } from "../src/stores/graph.js";
import { AuditEngine } from "../src/engines/audit.js";
import { MemoryEngine } from "../src/engines/memory.js";
import { PolicyEngine } from "../src/engines/policy.js";
import { NullEmbedder } from "../src/embeddings.js";
import type { Envelope } from "../src/schemas/envelope.js";

/**
 * Anti-bloat regression: a re-ingesting adapter (e.g. the pp-watcher) that
 * supplies a stable idempotency_key must NEVER create duplicate memory rows,
 * no matter how many times it re-adds the same upstream event. This is the
 * structural guard that prevents the 1244x duplicate-memory flood that grew
 * `memories` to ~1M rows / 3.5GB. See SqliteStore V8 + MemoryEngine.add.
 */
describe("memory engine — idempotent add by key", () => {
  let dir: string;
  let sql: SqliteStore;
  let vec: VectorStore;
  let memory: MemoryEngine;
  const env: Envelope = {
    tenant_id: "local",
    actor_id: "pp-watcher",
    project_id: "pair-programmer",
    domain: "code",
    scope: [],
    trace_id: "pp_run_r_1",
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-idem-"));
    sql = new SqliteStore(join(dir, "state.db"));
    sql.migrate();
    vec = new VectorStore(sql.db, 4);
    vec.load();
    const graph = new GraphStore(join(dir, "graph.kuzu"), "ladybug");
    const audit = new AuditEngine(sql, join(dir, "events"));
    const policy = new PolicyEngine(sql);
    memory = new MemoryEngine(sql, vec, graph, audit, new NullEmbedder(4), policy);
  });

  afterAll(() => {
    sql.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const rowCount = (): number =>
    (sql.db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;

  it("re-adding the same idempotency_key returns the original and inserts no duplicate", async () => {
    const first = await memory.add(env, {
      type: "episodic",
      content: "pair-programmer run r_1 finalized.",
      provenance: { actor: "pp-bridge", run_id: "r_1" },
      idempotency_key: "pp:run:r_1",
    });
    const before = rowCount();

    // Simulate 50 watcher re-ingest ticks of the same run.
    for (let i = 0; i < 50; i += 1) {
      const again = await memory.add(env, {
        type: "episodic",
        content: "pair-programmer run r_1 finalized.",
        provenance: { actor: "pp-bridge", run_id: "r_1" },
        idempotency_key: "pp:run:r_1",
      });
      expect(again.id).toBe(first.id);
    }
    expect(rowCount()).toBe(before); // zero new rows
  });

  it("distinct idempotency_keys still create distinct memories", async () => {
    const before = rowCount();
    await memory.add(env, {
      type: "episodic",
      content: "run r_2 finalized",
      provenance: { actor: "pp-bridge", run_id: "r_2" },
      idempotency_key: "pp:run:r_2",
    });
    await memory.add(env, {
      type: "episodic",
      content: "run r_3 finalized",
      provenance: { actor: "pp-bridge", run_id: "r_3" },
      idempotency_key: "pp:run:r_3",
    });
    expect(rowCount()).toBe(before + 2);
  });

  it("adds without an idempotency_key are unaffected (legacy behavior)", async () => {
    const before = rowCount();
    await memory.add(env, { type: "episodic", content: "ad-hoc a", provenance: { actor: "test" } });
    await memory.add(env, { type: "episodic", content: "ad-hoc b", provenance: { actor: "test" } });
    expect(rowCount()).toBe(before + 2);
  });
});
