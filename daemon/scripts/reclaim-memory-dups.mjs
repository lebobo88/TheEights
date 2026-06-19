#!/usr/bin/env node
/**
 * reclaim-memory-dups — one-time reclaim of the pp-watcher duplicate-memory flood.
 *
 * Background: a pp-watcher watermark bug re-ingested every terminal pair-programmer
 * run every 5s, ballooning `memories` (+ their `mem_vec` embeddings) to ~1M rows /
 * 3.5GB. The code fix (keyset cursor + idempotency_key) stops new duplicates; this
 * script reclaims the existing ones. The append-only audit `events` chain is left
 * INTACT (AGENTS.md hard rule #1) — only the derived `memories`/`mem_vec` stores are
 * deduped.
 *
 * Safety:
 *   - REFUSES to run while an eights daemon is alive (needs exclusive access).
 *   - Snapshots the whole db (VACUUM INTO ~/.eights/backups/) before any delete.
 *   - --dry-run reports the projected reclaim WITHOUT modifying anything.
 *
 * Usage:  node scripts/reclaim-memory-dups.mjs --dry-run
 *         node scripts/reclaim-memory-dups.mjs            (after stopping all eights daemons)
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DRY = process.argv.includes("--dry-run");
const home = join(homedir(), ".eights");
const dbPath = join(home, "state.db");
const ppPath = join(homedir(), ".pair-programmer", "state.db");

function daemonAlive() {
  const pidFile = join(home, "eights.pid");
  if (!existsSync(pidFile)) return null;
  const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  if (!pid) return null;
  try { process.kill(pid, 0); return pid; } catch { return null; }
}

const alive = daemonAlive();
if (alive && !DRY) {
  console.error(`REFUSING: eights daemon pid ${alive} is alive (pidfile). Stop ALL eights daemons first, then re-run.`);
  process.exit(2);
}
if (alive && DRY) console.warn(`[dry-run] note: eights daemon pid ${alive} appears alive; numbers are a live snapshot.`);

const db = new Database(dbPath);
sqliteVec.load(db);

const fmt = (b) => `${(b / 1e6).toFixed(1)}MB`;
const sizeBefore = statSync(dbPath).size;
const before = db.prepare("SELECT COUNT(*) AS n FROM memories").get().n;

// Duplicate = identical (tenant_id, content, scopes_json). pp finalize_run/verdict
// content embeds the run/verdict id, so identical content ⇒ same upstream event ⇒
// a true re-ingest duplicate. Keep the earliest (MIN(rowid)); drop the rest.
const losers = db.prepare(`
  SELECT id, embedding_id FROM memories
  WHERE rowid NOT IN (
    SELECT MIN(rowid) FROM memories GROUP BY tenant_id, content, scopes_json
  )
`).all();

console.log(`memories before: ${before}  |  duplicate rows to remove: ${losers.length}  |  db size: ${fmt(sizeBefore)}`);

if (DRY) {
  console.log(`[dry-run] would keep ${before - losers.length} rows, drop ${losers.length}, then VACUUM. No changes made.`);
  db.close();
  process.exit(0);
}

// 1. Backup snapshot.
const backupsDir = join(home, "backups");
mkdirSync(backupsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = join(backupsDir, `state-pre-dedup-${stamp}.db`);
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
console.log(`backup written: ${backup}`);

// 2. Delete duplicate memories + their orphaned embeddings (mem_vec is vec0).
const delMem = db.prepare("DELETE FROM memories WHERE id = ?");
const delVec = db.prepare("DELETE FROM mem_vec WHERE rowid = ?");
const txn = db.transaction((rows) => {
  for (const l of rows) {
    delMem.run(l.id);
    if (l.embedding_id != null) { try { delVec.run(l.embedding_id); } catch { /* vec row may be absent */ } }
  }
});
txn(losers);

// 3. Seed the pp-watcher keyset cursors to the current tip so the restarted daemon
//    (new code) does not re-ingest the existing runs (which would re-add one memory
//    each, since survivors predate the idempotency_key column).
if (existsSync(ppPath)) {
  const pp = new Database(ppPath, { readonly: true });
  const SEP = "\u0001"; // must match PpWatcher.CURSOR_SEP
  const setCursor = db.prepare(
    `INSERT INTO daemon_meta(key, value, updated_at) VALUES (?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  );
  try {
    const r = pp.prepare(
      `SELECT id, finished_at FROM runs WHERE finished_at IS NOT NULL
       ORDER BY finished_at DESC, id DESC LIMIT 1`,
    ).get();
    if (r) setCursor.run("pp-watcher:runs", `${r.finished_at}${SEP}${r.id}`);
    const v = pp.prepare(
      `SELECT id, created_at FROM verdicts ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get();
    if (v) setCursor.run("pp-watcher:verdicts", `${v.created_at}${SEP}${v.id}`);
    console.log("seeded pp-watcher cursors to tip:", r?.finished_at, v?.created_at);
  } catch (e) {
    console.warn("could not seed pp-watcher cursors (non-fatal):", String(e));
  }
  pp.close();
}

// 4. Reclaim space.
db.pragma("wal_checkpoint(TRUNCATE)");
db.exec("VACUUM");

const after = db.prepare("SELECT COUNT(*) AS n FROM memories").get().n;
const quick = db.prepare("PRAGMA quick_check(1)").get();
db.close();
const sizeAfter = statSync(dbPath).size;
console.log(`DONE. memories ${before} → ${after} (removed ${before - after}); db ${fmt(sizeBefore)} → ${fmt(sizeAfter)}; quick_check=${JSON.stringify(quick)}`);
console.log(`backup: ${backup}`);
