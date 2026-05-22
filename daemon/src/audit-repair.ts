#!/usr/bin/env node
/**
 * audit-repair — forensic chain rebuild for ~/.eights/state.db `events` table.
 *
 * Background: a dual-spawn race during early bootstrap (AgentSmith's EightsBridge
 * child + Claude Code's MCP host) could interleave hash-chain writes, leaving
 * the chain broken at row N. The D2b singleton pidfile guard prevents new
 * occurrences; this tool repairs historical damage.
 *
 * Strategy:
 *   1. Snapshot state.db + JSONL mirrors to a timestamped backup dir.
 *   2. Dedupe rows by (ts, kind, envelope_json, payload_json).
 *   3. Recompute the SHA-256 chain forward from GENESIS in event_id order.
 *   4. UPDATE prev_hash/hash for each surviving row inside a single transaction.
 *   5. Regenerate JSONL mirrors for every affected day from the repaired rows.
 *   6. Append an `audit.chain.repaired` event via AuditEngine so the repair
 *      itself is auditable (AGENTS.md §Hard Rule 3).
 *
 * --dry-run prints the plan without mutating SQLite or the JSONL files.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import Database from "better-sqlite3";
import { loadConfig, type EightsConfig } from "./config.js";
import { SqliteStore } from "./stores/sqlite.js";
import { AuditEngine, GENESIS_HASH, computeRowHash } from "./engines/audit.js";
import type { Envelope } from "./schemas/envelope.js";

interface EventRow {
  event_id: number;
  ts: string;
  kind: string;
  envelope_json: string;
  payload_json: string;
  prev_hash: string;
  hash: string;
}

export interface RepairResult {
  ok: boolean;
  broken_at: number | null;
  rows_before: number;
  rows_after: number;
  dedup_count: number;
  rehashed_count: number;
  snapshot_dir: string | null;
  dry_run: boolean;
}

function dedupKey(r: { ts: string; kind: string; envelope_json: string; payload_json: string }): string {
  return `${r.ts}\x1f${r.kind}\x1f${r.envelope_json}\x1f${r.payload_json}`;
}

function findBrokenAt(rows: EventRow[]): number | null {
  let prev = GENESIS_HASH;
  for (const r of rows) {
    if (r.prev_hash !== prev) return r.event_id;
    const expected = computeRowHash(prev, r.ts, r.kind, r.envelope_json, r.payload_json);
    if (expected !== r.hash) return r.event_id;
    prev = r.hash;
  }
  return null;
}

function snapshot(cfg: EightsConfig): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(cfg.home, "backups", `audit-repair-${stamp}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "events"), { recursive: true });

  // SQLite live backup (handles WAL atomically).
  const src = new Database(cfg.statePath, { readonly: true });
  try {
    // better-sqlite3 backup is async-ish via VACUUM INTO for a portable snapshot.
    src.exec(`VACUUM INTO '${join(dir, "state.db").replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }

  // Copy every JSONL mirror.
  if (existsSync(cfg.eventsDir)) {
    for (const f of readdirSync(cfg.eventsDir)) {
      if (f.endsWith(".jsonl")) {
        copyFileSync(join(cfg.eventsDir, f), join(dir, "events", f));
      }
    }
  }
  return dir;
}

/** Pure repair logic — exported for tests. Operates on the live SQLite store. */
export function repairChain(store: SqliteStore, opts: { eventsDir: string; dryRun: boolean }): RepairResult {
  const rows = store.db
    .prepare("SELECT event_id, ts, kind, envelope_json, payload_json, prev_hash, hash FROM events ORDER BY event_id")
    .all() as EventRow[];

  const rowsBefore = rows.length;
  const brokenAt = findBrokenAt(rows);

  // Dedupe by content; keep the smallest event_id per content tuple.
  const seen = new Map<string, EventRow>();
  for (const r of rows) {
    const k = dedupKey(r);
    if (!seen.has(k)) seen.set(k, r);
  }
  const kept = Array.from(seen.values()).sort((a, b) => a.event_id - b.event_id);
  const dedupCount = rowsBefore - kept.length;

  // Recompute chain. Track which rows changed.
  let prev = GENESIS_HASH;
  let rehashed = 0;
  const rehashed_ids = new Set<number>();
  const dropped_ids = new Set(rows.map((r) => r.event_id));
  for (const r of kept) dropped_ids.delete(r.event_id);

  const newRows: EventRow[] = kept.map((r) => {
    const newHash = computeRowHash(prev, r.ts, r.kind, r.envelope_json, r.payload_json);
    const changed = r.prev_hash !== prev || r.hash !== newHash;
    if (changed) {
      rehashed++;
      rehashed_ids.add(r.event_id);
    }
    const out: EventRow = { ...r, prev_hash: prev, hash: newHash };
    prev = newHash;
    return out;
  });

  if (opts.dryRun) {
    return {
      ok: brokenAt === null && dedupCount === 0,
      broken_at: brokenAt,
      rows_before: rowsBefore,
      rows_after: kept.length,
      dedup_count: dedupCount,
      rehashed_count: rehashed,
      snapshot_dir: null,
      dry_run: true,
    };
  }

  // Apply: delete dropped rows + UPDATE survivors, all inside a transaction.
  const del = store.db.prepare("DELETE FROM events WHERE event_id = ?");
  const upd = store.db.prepare("UPDATE events SET prev_hash = ?, hash = ? WHERE event_id = ?");
  const tx = store.db.transaction(() => {
    for (const id of dropped_ids) del.run(id);
    for (const r of newRows) upd.run(r.prev_hash, r.hash, r.event_id);
  });
  tx();

  // Regenerate JSONL mirrors for every affected day.
  const byDay = new Map<string, EventRow[]>();
  for (const r of newRows) {
    const day = r.ts.slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push(r);
    byDay.set(day, arr);
  }
  mkdirSync(opts.eventsDir, { recursive: true });
  for (const [day, dayRows] of byDay) {
    const lines = dayRows.map((r) =>
      JSON.stringify({
        event_id: r.event_id,
        ts: r.ts,
        kind: r.kind,
        envelope: JSON.parse(r.envelope_json),
        payload: JSON.parse(r.payload_json),
        prev_hash: r.prev_hash,
        hash: r.hash,
      }),
    );
    writeFileSync(join(opts.eventsDir, `${day}.jsonl`), lines.join("\n") + (lines.length ? "\n" : ""));
  }

  return {
    ok: true,
    broken_at: brokenAt,
    rows_before: rowsBefore,
    rows_after: kept.length,
    dedup_count: dedupCount,
    rehashed_count: rehashed,
    snapshot_dir: null,
    dry_run: false,
  };
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const cfg = loadConfig();

  if (!existsSync(cfg.statePath)) {
    process.stderr.write(`[audit-repair] no state.db at ${cfg.statePath}\n`);
    process.exit(2);
  }

  const snapshotDir = dryRun ? null : snapshot(cfg);

  const store = new SqliteStore(cfg.statePath);
  store.migrate();

  const result = repairChain(store, { eventsDir: cfg.eventsDir, dryRun });
  result.snapshot_dir = snapshotDir;

  if (!dryRun) {
    // Append a self-audited repair event using the (now-healed) chain.
    const audit = new AuditEngine(store, cfg.eventsDir);
    const env: Envelope = {
      tenant_id: "local",
      actor_id: "eights.system",
      project_id: "TheEights",
      domain: "audit",
      scope: ["public"],
      trace_id: `audit-repair-${Date.now()}`,
    };
    audit.record("audit.chain.repaired", env, {
      broken_at: result.broken_at,
      rows_before: result.rows_before,
      rows_after: result.rows_after,
      dedup_count: result.dedup_count,
      rehashed_count: result.rehashed_count,
      snapshot_dir: snapshotDir ? basename(snapshotDir) : null,
    });

    // Final verify.
    const post = audit.verifyChain();
    if (!post.ok) {
      process.stderr.write(`[audit-repair] FAILED — chain still broken at ${post.broken_at}\n`);
      store.close();
      process.exit(3);
    }
  }

  store.close();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

const isDirectInvocation = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("audit-repair.js") === true ||
  process.argv[1]?.endsWith("audit-repair.ts") === true;
if (isDirectInvocation) {
  main().catch((err) => {
    process.stderr.write(`[audit-repair] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
