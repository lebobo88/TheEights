import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/stores/sqlite.js";
import { AuditEngine } from "../src/engines/audit.js";
import type { Envelope } from "../src/schemas/envelope.js";

/**
 * Regression: concurrent audit appends used to corrupt the hash chain because
 * each AuditEngine instance trusted its own in-memory `prevHash`. Two instances
 * with the same stale `prevHash` produced sibling rows that both claimed the
 * same `prev_hash`, forking the chain.
 *
 * Fix: `record()` now reads prev_hash from the DB inside a BEGIN IMMEDIATE
 * transaction, so concurrent writers serialize on the write lock and each one
 * observes the actual latest hash. These tests simulate that race.
 */
describe("audit concurrency — DB-driven prev_hash", () => {
  let dir: string;
  let store: SqliteStore;
  let eventsDir: string;
  const env: Envelope = {
    tenant_id: "local",
    actor_id: "t",
    project_id: "T",
    domain: "d",
    scope: [],
    trace_id: "x",
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-concurrency-"));
    eventsDir = join(dir, "events");
    store = new SqliteStore(join(dir, "state.db"));
    store.migrate();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps chain intact when two AuditEngine instances share a store", () => {
    // Two engines = simulated dual-spawn (Claude Code child + AgentSmith bridge
    // child both opening the same ~/.eights/state.db). Both start with empty
    // in-memory state and append in interleaved order.
    const a = new AuditEngine(store, eventsDir);
    const b = new AuditEngine(store, eventsDir);

    for (let i = 0; i < 50; i++) {
      a.record("a.tick", env, { i });
      b.record("b.tick", env, { i });
    }

    const verify = a.verifyChain();
    expect(verify.ok).toBe(true);

    const count = (store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    expect(count).toBe(100);
  });

  it("keeps chain intact when engines are constructed mid-stream (stale bootstrap)", () => {
    // Under the old design, the second engine's constructor cached prev_hash =
    // <hash of latest row at construction time>. If the first engine then wrote
    // more rows, the second engine's cached value went stale and its next
    // record() forked the chain. The new design reads prev_hash live from the
    // DB inside the txn, so a stale constructor snapshot is harmless.
    const first = new AuditEngine(store, eventsDir);
    first.record("first.write", env, { i: 1 });
    first.record("first.write", env, { i: 2 });
    first.record("first.write", env, { i: 3 });

    // Now `second` snapshots an outdated view (rows 1-3 exist when it boots).
    const second = new AuditEngine(store, eventsDir);

    // First keeps writing — under the old design this would advance the chain
    // beyond what `second` cached, then second.record() would fork.
    first.record("first.write", env, { i: 4 });
    first.record("first.write", env, { i: 5 });

    // Now second writes — must observe rows 4+5 via the DB, not its bootstrap.
    second.record("second.write", env, { i: 1 });
    second.record("second.write", env, { i: 2 });

    // Interleave a bit more.
    first.record("first.write", env, { i: 6 });
    second.record("second.write", env, { i: 3 });

    expect(first.verifyChain().ok).toBe(true);
    expect(second.verifyChain().ok).toBe(true);
  });
});
