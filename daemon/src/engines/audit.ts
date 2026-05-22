import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SqliteStore } from "../stores/sqlite.js";
import type { Envelope } from "../schemas/envelope.js";

export const GENESIS_HASH = "0".repeat(64);

/** Pure SHA-256 chain step. Single source of truth shared with the repair tool. */
export function computeRowHash(
  prev: string,
  ts: string,
  kind: string,
  envJson: string,
  payloadJson: string,
): string {
  return createHash("sha256")
    .update(prev)
    .update(ts)
    .update(kind)
    .update(envJson)
    .update(payloadJson)
    .digest("hex");
}

/**
 * Audit engine — append-only event log with running hash chain for tamper evidence.
 * Every MCP call lands here. See ARCHITECTURE.md §6.5.
 *
 * Concurrency: `record()` reads the canonical prev_hash directly from SQLite
 * inside an IMMEDIATE transaction. With WAL mode, BEGIN IMMEDIATE acquires the
 * write lock atomically — so two concurrent eights-daemon processes (Claude
 * Code child + AgentSmith bridge child + ...) serialize on the audit append.
 * The previous design read `prevHash` from in-memory state, which let two
 * processes with stale state compute against the same `prev_hash` and produce
 * a chain fork. That race is what produced the 1326/1336/1337 break and the
 * 80939 follow-on break.
 */
export class AuditEngine {
  private readonly selectLatestHash;
  private readonly insertEvent;

  constructor(
    private readonly store: SqliteStore,
    private readonly eventsDir: string,
  ) {
    mkdirSync(eventsDir, { recursive: true });
    this.selectLatestHash = this.store.db.prepare(
      "SELECT hash FROM events ORDER BY event_id DESC LIMIT 1",
    );
    this.insertEvent = this.store.db.prepare(
      `INSERT INTO events(ts, kind, envelope_json, payload_json, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
  }

  record(kind: string, envelope: Envelope, payload: unknown): { event_id: number; hash: string } {
    const ts = new Date().toISOString();
    const envJson = JSON.stringify(envelope);
    const payloadJson = JSON.stringify(payload);

    // BEGIN IMMEDIATE → SELECT latest → compute → INSERT → COMMIT, all atomic.
    // better-sqlite3's `.immediate(...)` runs the inner function inside a
    // BEGIN IMMEDIATE transaction, taking the write lock up-front so concurrent
    // writers from sibling processes are blocked rather than racing on read.
    const txn = this.store.db.transaction((): { event_id: number; hash: string; prev: string } => {
      const row = this.selectLatestHash.get() as { hash: string } | undefined;
      const prev = row?.hash ?? GENESIS_HASH;
      const hash = computeRowHash(prev, ts, kind, envJson, payloadJson);
      const result = this.insertEvent.run(ts, kind, envJson, payloadJson, prev, hash);
      return { event_id: result.lastInsertRowid as number, hash, prev };
    });
    const { event_id, hash, prev } = txn.immediate();

    // Mirror to today's jsonl file (durable, grep-able). Outside the txn — a
    // crash between INSERT and append leaves SQLite as the source of truth,
    // which is what `eights audit:repair` already relies on.
    const day = ts.slice(0, 10);
    const file = join(this.eventsDir, `${day}.jsonl`);
    appendFileSync(file,
      JSON.stringify({ event_id, ts, kind, envelope, payload, prev_hash: prev, hash }) + "\n",
    );

    return { event_id, hash };
  }

  /** Verifies the hash chain end-to-end. Run at startup. */
  verifyChain(): { ok: true } | { ok: false; broken_at: number } {
    const rows = this.store.db
      .prepare("SELECT event_id, ts, kind, envelope_json, payload_json, prev_hash, hash FROM events ORDER BY event_id")
      .all() as Array<{ event_id: number; ts: string; kind: string; envelope_json: string; payload_json: string; prev_hash: string; hash: string }>;

    let prev = GENESIS_HASH;
    for (const row of rows) {
      if (row.prev_hash !== prev) return { ok: false, broken_at: row.event_id };
      const expected = computeRowHash(row.prev_hash, row.ts, row.kind, row.envelope_json, row.payload_json);
      if (expected !== row.hash) return { ok: false, broken_at: row.event_id };
      prev = row.hash;
    }
    return { ok: true };
  }
}
