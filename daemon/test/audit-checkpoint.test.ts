import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/stores/sqlite.js";
import { AuditEngine } from "../src/engines/audit.js";
import type { Envelope } from "../src/schemas/envelope.js";

let store: SqliteStore;
let dir: string;
let eventsDir: string;
let env: Envelope;

const BAD_HASH = "deadbeef".repeat(8); // 64 hex chars — valid shape, wrong value

function checkpoint(): { event_id: number; hash: string } | undefined {
  return store.db.prepare("SELECT event_id, hash FROM audit_checkpoint WHERE id = 1").get() as
    | { event_id: number; hash: string }
    | undefined;
}

function tamper(eventId: number): void {
  store.db.prepare("UPDATE events SET hash = ? WHERE event_id = ?").run(BAD_HASH, eventId);
}

beforeEach(() => {
  store = new SqliteStore(join((dir = mkdtempSync(join(tmpdir(), "eights-ckpt-"))), "state.db"));
  store.migrate();
  eventsDir = join(dir, "events");
  env = { tenant_id: "local", actor_id: "t", project_id: "T", domain: "d", scope: [], trace_id: "x" };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("audit checkpointed verifyChain", () => {
  it("advances the persisted checkpoint to the tip after a successful verify", async () => {
    const audit = new AuditEngine(store, eventsDir);
    audit.record("k", env, { i: 1 });
    audit.record("k", env, { i: 2 });
    const tip = store.db.prepare("SELECT event_id, hash FROM events ORDER BY event_id DESC LIMIT 1").get() as {
      event_id: number; hash: string;
    };

    expect(checkpoint()).toBeUndefined();
    expect((await audit.verifyChain()).ok).toBe(true);

    const cp = checkpoint();
    expect(cp?.event_id).toBe(tip.event_id);
    expect(cp?.hash).toBe(tip.hash);

    // Re-verify is a no-op tail (nothing past the checkpoint) and still ok.
    expect((await audit.verifyChain()).ok).toBe(true);
  });

  it("incremental verify trusts the checkpointed prefix; full verify still catches it", async () => {
    const audit = new AuditEngine(store, eventsDir);
    audit.record("k", env, { i: 1 });
    audit.record("k", env, { i: 2 });
    audit.record("k", env, { i: 3 });
    expect((await audit.verifyChain()).ok).toBe(true); // checkpoint → 3

    // Tamper a row inside the checkpointed prefix.
    tamper(2);

    // Incremental (default) only re-hashes event_id > checkpoint → sees nothing wrong.
    expect((await audit.verifyChain()).ok).toBe(true);

    // Full re-verification (the daily job / repair path) detects the break.
    const full = await audit.verifyChain({ full: true });
    expect(full.ok).toBe(false);
    expect(full.ok === false && full.broken_at).toBe(2);
  });

  it("detects tampering in the un-checkpointed tail on boot", async () => {
    const audit = new AuditEngine(store, eventsDir);
    audit.record("k", env, { i: 1 });
    audit.record("k", env, { i: 2 });
    audit.record("k", env, { i: 3 });
    expect((await audit.verifyChain()).ok).toBe(true); // checkpoint → 3

    audit.record("k", env, { i: 4 });
    audit.record("k", env, { i: 5 });
    tamper(5);

    const result = await audit.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.broken_at).toBe(5);
  });

  it("does not advance the checkpoint when the tail is broken", async () => {
    const audit = new AuditEngine(store, eventsDir);
    audit.record("k", env, { i: 1 });
    audit.record("k", env, { i: 2 });
    expect((await audit.verifyChain()).ok).toBe(true); // checkpoint → 2

    audit.record("k", env, { i: 3 });
    tamper(3);
    await audit.verifyChain(); // broken at 3

    // Mark stays at the last verified row, never advances past a break.
    expect(checkpoint()?.event_id).toBe(2);
  });
});
