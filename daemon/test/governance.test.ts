import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/stores/sqlite.js";
import { VectorStore } from "../src/stores/vec.js";
import { GraphStore } from "../src/stores/graph.js";
import { AuditEngine } from "../src/engines/audit.js";
import { MemoryEngine, MemoryRejection } from "../src/engines/memory.js";
import { PolicyEngine } from "../src/engines/policy.js";
import { NullEmbedder } from "../src/embeddings.js";
import type { Envelope } from "../src/schemas/envelope.js";

describe("governance — SSGM gates + redaction", () => {
  let dir: string;
  let sql: SqliteStore;
  let memory: MemoryEngine;
  let policy: PolicyEngine;
  const env: Envelope = {
    tenant_id: "local", actor_id: "test", project_id: "TheEights",
    domain: "test", scope: [], trace_id: "t",
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-gov-"));
    sql = new SqliteStore(join(dir, "state.db"));
    sql.migrate();
    const vec = new VectorStore(sql.db, 4); vec.load();
    const graph = new GraphStore(join(dir, "graph"), "ladybug");
    const audit = new AuditEngine(sql, join(dir, "events"));
    policy = new PolicyEngine(sql);
    memory = new MemoryEngine(sql, vec, graph, audit, new NullEmbedder(4), policy);
  });

  afterAll(() => { sql.close(); rmSync(dir, { recursive: true, force: true }); });

  it("redacts sensitive patterns", () => {
    const r = policy.redact("contact bob@example.com about AKIAABCDEFGHIJKL1234 and SSN 123-45-6789");
    expect(r.redacted_count).toBeGreaterThanOrEqual(2);
    expect(r.text).toContain("[REDACTED:email]");
    expect(r.text).toContain("[REDACTED:aws-key]");
    expect(r.text).toContain("[REDACTED:ssn]");
  });

  it("blocks contradictory high-confidence writes via SSGM Gate 1", async () => {
    await memory.add(env, {
      type: "semantic",
      content: "Project Atlas capex is approved for Q3 deployment",
      scopes: ["project:Atlas"],
      provenance: { actor: "test" },
      confidence: 0.95,
    });
    await expect(memory.add(env, {
      type: "semantic",
      content: "Project Atlas capex is rejected; do not deploy in Q3",
      scopes: ["project:Atlas"],
      provenance: { actor: "test" },
      confidence: 0.9,
    })).rejects.toThrow(MemoryRejection);
  });

  it("allows supersession when explicit", async () => {
    const a = await memory.add(env, {
      type: "semantic",
      content: "Project Beta capex is approved for Q4",
      scopes: ["project:Beta"],
      provenance: { actor: "test" },
      confidence: 0.9,
    });
    const b = await memory.add(env, {
      type: "semantic",
      content: "Project Beta capex is rejected; do not deploy in Q4",
      scopes: ["project:Beta"],
      supersedes: [a.id],
      provenance: { actor: "test" },
      confidence: 0.92,
    });
    expect(b.id).toBeTruthy();
  });
});
