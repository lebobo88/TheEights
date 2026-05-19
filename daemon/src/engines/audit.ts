import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SqliteStore } from "../stores/sqlite.js";
import type { Envelope } from "../schemas/envelope.js";

/**
 * Audit engine — append-only event log with running hash chain for tamper evidence.
 * Every MCP call lands here. See ARCHITECTURE.md §6.5.
 */
export class AuditEngine {
  private prevHash: string = "0".repeat(64);

  constructor(
    private readonly store: SqliteStore,
    private readonly eventsDir: string,
  ) {
    mkdirSync(eventsDir, { recursive: true });
    this.bootstrapHash();
  }

  private bootstrapHash(): void {
    const row = this.store.db
      .prepare("SELECT hash FROM events ORDER BY event_id DESC LIMIT 1")
      .get() as { hash: string } | undefined;
    if (row) this.prevHash = row.hash;
  }

  record(kind: string, envelope: Envelope, payload: unknown): { event_id: number; hash: string } {
    const ts = new Date().toISOString();
    const envJson = JSON.stringify(envelope);
    const payloadJson = JSON.stringify(payload);
    const hash = createHash("sha256")
      .update(this.prevHash)
      .update(ts)
      .update(kind)
      .update(envJson)
      .update(payloadJson)
      .digest("hex");

    const result = this.store.db
      .prepare(
        `INSERT INTO events(ts, kind, envelope_json, payload_json, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ts, kind, envJson, payloadJson, this.prevHash, hash);

    // Mirror to today's jsonl file (durable, grep-able).
    const day = ts.slice(0, 10);
    const file = join(this.eventsDir, `${day}.jsonl`);
    appendFileSync(file,
      JSON.stringify({ event_id: result.lastInsertRowid, ts, kind, envelope, payload, prev_hash: this.prevHash, hash }) + "\n",
    );

    this.prevHash = hash;
    return { event_id: result.lastInsertRowid as number, hash };
  }

  /** Verifies the hash chain end-to-end. Run at startup. */
  verifyChain(): { ok: true } | { ok: false; broken_at: number } {
    const rows = this.store.db
      .prepare("SELECT event_id, ts, kind, envelope_json, payload_json, prev_hash, hash FROM events ORDER BY event_id")
      .all() as Array<{ event_id: number; ts: string; kind: string; envelope_json: string; payload_json: string; prev_hash: string; hash: string }>;

    let prev = "0".repeat(64);
    for (const row of rows) {
      if (row.prev_hash !== prev) return { ok: false, broken_at: row.event_id };
      const expected = createHash("sha256")
        .update(row.prev_hash)
        .update(row.ts)
        .update(row.kind)
        .update(row.envelope_json)
        .update(row.payload_json)
        .digest("hex");
      if (expected !== row.hash) return { ok: false, broken_at: row.event_id };
      prev = row.hash;
    }
    return { ok: true };
  }
}
