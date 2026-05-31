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

describe("memory engine — Phase 0 smoke", () => {
  let dir: string;
  let sql: SqliteStore;
  let vec: VectorStore;
  let audit: AuditEngine;
  let memory: MemoryEngine;
  const env: Envelope = {
    tenant_id: "local",
    actor_id: "test-actor",
    project_id: "TheEights",
    domain: "test",
    scope: [],
    trace_id: "trace_test_1",
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-test-"));
    sql = new SqliteStore(join(dir, "state.db"));
    sql.migrate();
    vec = new VectorStore(sql.db, 4); // small dim for tests
    vec.load();
    const graph = new GraphStore(join(dir, "graph.kuzu"), "ladybug");
    audit = new AuditEngine(sql, join(dir, "events"));
    const policy = new PolicyEngine(sql);
    memory = new MemoryEngine(sql, vec, graph, audit, new NullEmbedder(4), policy);
  });

  afterAll(() => {
    sql.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes and reads back an episodic memory", async () => {
    const m = await memory.add(env, {
      type: "episodic",
      content: "first run finalized cleanly",
      provenance: { actor: "test", run_id: "r_1" },
    });
    expect(m.id).toMatch(/^mem_/);
    const got = memory.get(env, m.id);
    expect(got?.content).toBe("first run finalized cleanly");
  });

  it("writes a vector-indexed memory and finds it via vector search", async () => {
    const emb = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
    const m = await memory.add(env, {
      type: "semantic",
      content: "feature-team-tdd consistently rejects mocked DB tests",
      provenance: { actor: "pp-bridge" },
      embedding: emb,
    });
    expect(m.embedding_id).toBeDefined();

    const hits = await memory.search(env, {
      query: "tdd",
      query_embedding: Float32Array.from([0.1, 0.2, 0.3, 0.4]),
      top_k: 5,
      fusion: "vector",
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toBe("vector");
  });

  it("falls back to episodic search when no embedding available", async () => {
    const hits = await memory.search(env, {
      query: "finalized",
      top_k: 5,
      fusion: "episodic",
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toBe("episodic");
  });

  it("hash-chains the audit log and verifies clean", async () => {
    const chain = await audit.verifyChain();
    expect(chain.ok).toBe(true);
  });
});
