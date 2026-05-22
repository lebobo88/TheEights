import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/stores/sqlite.js";
import { AuditEngine, GENESIS_HASH, computeRowHash } from "../src/engines/audit.js";
import { repairChain } from "../src/audit-repair.js";

function insertRaw(
  store: SqliteStore,
  ts: string,
  kind: string,
  payload: unknown,
  prevHash: string,
  hashOverride?: string,
): number {
  const envJson = JSON.stringify({ tenant_id: "local", actor_id: "t", project_id: "T", domain: "d", scope: [], trace_id: "x" });
  const payloadJson = JSON.stringify(payload);
  const hash = hashOverride ?? computeRowHash(prevHash, ts, kind, envJson, payloadJson);
  const r = store.db
    .prepare(`INSERT INTO events(ts, kind, envelope_json, payload_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(ts, kind, envJson, payloadJson, prevHash, hash);
  return r.lastInsertRowid as number;
}

describe("audit-repair — forensic chain rebuild", () => {
  let dir: string;
  let store: SqliteStore;
  let eventsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-repair-"));
    eventsDir = join(dir, "events");
    store = new SqliteStore(join(dir, "state.db"));
    store.migrate();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("verifies an intact chain as ok", () => {
    const audit = new AuditEngine(store, eventsDir);
    const env = { tenant_id: "local", actor_id: "t", project_id: "T", domain: "d", scope: [] as string[], trace_id: "x" };
    audit.record("k1", env, { i: 1 });
    audit.record("k2", env, { i: 2 });
    const r = repairChain(store, { eventsDir, dryRun: true });
    expect(r.broken_at).toBeNull();
    expect(r.rows_before).toBe(2);
    expect(r.dedup_count).toBe(0);
    expect(r.rehashed_count).toBe(0);
  });

  it("repairs a chain broken by the 1326/1336/1337 dual-spawn pattern", () => {
    // Simulate two processes interleaving writes. Rows 1..3 land cleanly via the
    // real AuditEngine. Then a second process appends two more rows both chained
    // off row 3's hash (stale prevHash) — exactly the failure mode that produced
    // the row-1337 break in production.
    const env = { tenant_id: "local", actor_id: "t", project_id: "T", domain: "d", scope: [] as string[], trace_id: "x" };
    const audit = new AuditEngine(store, eventsDir);
    audit.record("k", env, { i: 1 });
    audit.record("k", env, { i: 2 });
    audit.record("k", env, { i: 3 });
    const row3 = store.db.prepare("SELECT hash FROM events WHERE event_id = 3").get() as { hash: string };

    // Row 4: written by process B chained off row 3.
    insertRaw(store, "2026-05-19T15:00:03.000Z", "k", { i: 4 }, row3.hash);

    // Row 5: written by process A with STALE prevHash = row3.hash (should have
    // been row4's hash). This is the first row whose prev_hash diverges from the
    // expected forward chain.
    insertRaw(store, "2026-05-19T15:00:04.000Z", "k", { i: 5 }, row3.hash);

    // Pre-repair: chain should be broken at row 5.
    const pre = repairChain(store, { eventsDir, dryRun: true });
    expect(pre.broken_at).toBe(5);

    // Repair.
    const result = repairChain(store, { eventsDir, dryRun: false });
    expect(result.ok).toBe(true);
    expect(result.rows_after).toBeGreaterThan(0);
    expect(result.rehashed_count).toBeGreaterThan(0);

    // Verify via the same algorithm the daemon uses at startup.
    const verify = audit.verifyChain();
    expect(verify.ok).toBe(true);

    // No real event payloads lost — all 5 distinct payloads survive.
    const payloads = store.db
      .prepare("SELECT payload_json FROM events ORDER BY event_id")
      .all() as Array<{ payload_json: string }>;
    const seenIs = new Set(payloads.map((p) => (JSON.parse(p.payload_json) as { i?: number }).i).filter((x) => x !== undefined));
    expect(seenIs.has(2)).toBe(true);
    expect(seenIs.has(3)).toBe(true);
    expect(seenIs.has(4)).toBe(true);
    expect(seenIs.has(5)).toBe(true);

    // JSONL mirrors regenerated. Rows 4-5 carry an explicit 2026-05-19 ts; rows
    // 1-3 carry the real-time ts from AuditEngine.record(). Both day files
    // together must contain all five surviving events.
    const dayFile = join(eventsDir, "2026-05-19.jsonl");
    expect(existsSync(dayFile)).toBe(true);
    const totalLines = readdirSync(eventsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .reduce((sum, f) => sum + readFileSync(join(eventsDir, f), "utf8").trim().split("\n").filter(Boolean).length, 0);
    expect(totalLines).toBe(5);
  });

  it("dedupes exact-duplicate content rows from a race", () => {
    // Two rows with identical content but written by racing processes.
    const ts = "2026-05-19T15:00:00.000Z";
    insertRaw(store, ts, "boot", { x: 1 }, GENESIS_HASH);
    // Duplicate (same ts/kind/payload), broken prev_hash from a separate lineage.
    insertRaw(store, ts, "boot", { x: 1 }, "ff".repeat(32));

    const result = repairChain(store, { eventsDir, dryRun: false });
    expect(result.dedup_count).toBe(1);
    expect(result.rows_after).toBe(1);

    const audit = new AuditEngine(store, eventsDir);
    expect(audit.verifyChain().ok).toBe(true);
  });
});
