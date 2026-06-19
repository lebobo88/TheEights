#!/usr/bin/env node
/**
 * compact-mem-vec — reclaim dead vec0 chunk storage after a large mem_vec delete.
 *
 * sqlite-vec's vec0 virtual table keeps deleted vectors' chunk pages allocated
 * (`mem_vec_vector_chunks00` does not shrink on DELETE, and VACUUM cannot compact
 * a virtual table's shadow store). After reclaim-memory-dups.mjs removed ~954k
 * duplicate embeddings, ~1.65GB of dead chunk storage remained. This rebuilds
 * mem_vec from ONLY the surviving, referenced embeddings.
 *
 * Atomic: reads all live vectors first, then drops+recreates+reinserts inside a
 * single transaction (DDL is transactional in SQLite), remapping memories.embedding_id
 * to the new rowids. Any error rolls back, leaving the original table intact. The
 * pre-dedup snapshot in ~/.eights/backups/ is the outer restore point.
 *
 * Usage: node scripts/compact-mem-vec.mjs            (after stopping all eights daemons)
 *        node scripts/compact-mem-vec.mjs --dry-run
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DRY = process.argv.includes("--dry-run");
const home = join(homedir(), ".eights");
const dbPath = join(home, "state.db");

const pidFile = join(home, "eights.pid");
if (existsSync(pidFile)) {
  const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  if (pid) { try { process.kill(pid, 0); if (!DRY) { console.error(`REFUSING: eights daemon pid ${pid} alive. Stop all eights daemons first.`); process.exit(2); } } catch { /* dead */ } }
}

const db = new Database(dbPath);
sqliteVec.load(db);
const fmt = (b) => `${(b / 1e6).toFixed(1)}MB`;
const sizeBefore = statSync(dbPath).size;

// Detect vector dim from a live row (bytes / 4 float32 lanes).
const dimRow = db.prepare(
  "SELECT length(v.embedding) blen FROM memories m JOIN mem_vec v ON v.rowid = m.embedding_id WHERE m.embedding_id IS NOT NULL LIMIT 1",
).get();
if (!dimRow) { console.log("no linked embeddings — nothing to compact."); db.close(); process.exit(0); }
const dim = dimRow.blen / 4;

// Read every surviving (memory_id, vector-blob) pair up front.
const live = db.prepare(
  `SELECT m.id AS mem_id, v.embedding AS vec
   FROM memories m JOIN mem_vec v ON v.rowid = m.embedding_id
   WHERE m.embedding_id IS NOT NULL`,
).all();
const vecRows = db.prepare("SELECT COUNT(*) n FROM mem_vec").get().n;
console.log(`dim=${dim}  live linked embeddings=${live.length}  current mem_vec rows=${vecRows}  db=${fmt(sizeBefore)}`);

if (DRY) { console.log(`[dry-run] would rebuild mem_vec with ${live.length} vectors and VACUUM. No changes made.`); db.close(); process.exit(0); }

const rebuild = db.transaction((rows) => {
  db.exec("DROP TABLE mem_vec;");
  db.exec(`CREATE VIRTUAL TABLE mem_vec USING vec0(embedding float[${dim}]);`);
  const ins = db.prepare("INSERT INTO mem_vec(embedding) VALUES (?)");
  const upd = db.prepare("UPDATE memories SET embedding_id = ? WHERE id = ?");
  for (const r of rows) {
    const newRowid = Number(ins.run(r.vec).lastInsertRowid);
    upd.run(newRowid, r.mem_id);
  }
});
rebuild(live);

db.pragma("wal_checkpoint(TRUNCATE)");
db.exec("VACUUM");

const after = db.prepare("SELECT COUNT(*) n FROM mem_vec").get().n;
const linked = db.prepare("SELECT COUNT(*) n FROM memories WHERE embedding_id IS NOT NULL").get().n;
const orphan = db.prepare("SELECT COUNT(*) n FROM memories m WHERE m.embedding_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mem_vec v WHERE v.rowid = m.embedding_id)").get().n;
const quick = db.prepare("PRAGMA quick_check(1)").get();
db.close();
const sizeAfter = statSync(dbPath).size;
console.log(`DONE. mem_vec rows ${vecRows} → ${after}; linked memories=${linked}; orphaned fk=${orphan}; db ${fmt(sizeBefore)} → ${fmt(sizeAfter)}; quick_check=${JSON.stringify(quick)}`);
