import * as sqliteVec from "sqlite-vec";
import type Database from "better-sqlite3";

/**
 * Wraps a vec0 virtual table that lives alongside the episodic SQLite store.
 * See ADR-0001.
 */
export class VectorStore {
  constructor(
    private readonly db: Database.Database,
    private readonly dim: number,
  ) {}

  load(): void {
    sqliteVec.load(this.db);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS mem_vec USING vec0(
        embedding float[${this.dim}]
      );
    `);
  }

  insert(embedding: Float32Array): number {
    // sqlite-vec accepts Float32Array directly; wrapping in Buffer breaks the
    // virtual-table type sniff. RETURNING rowid doesn't fire on vec0 virtual
    // tables, so use the run() info.lastInsertRowid instead.
    const stmt = this.db.prepare("INSERT INTO mem_vec(embedding) VALUES (?)");
    const info = stmt.run(embedding);
    return Number(info.lastInsertRowid);
  }

  search(query: Float32Array, k: number): Array<{ rowid: number; distance: number }> {
    const stmt = this.db.prepare(
      `SELECT rowid, distance FROM mem_vec
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`,
    );
    return stmt.all(query, k) as Array<{ rowid: number; distance: number }>;
  }
}
