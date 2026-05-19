import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { VectorStore } from "../src/stores/vec.js";

describe("VectorStore wrapper", () => {
  it("inserts via wrapper and finds via wrapper", () => {
    const db = new Database(":memory:");
    sqliteVec.load(db);
    const vec = new VectorStore(db, 4);
    vec.load();

    const v1 = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
    const rowid = vec.insert(v1);
    // eslint-disable-next-line no-console
    console.log("insert returned rowid:", rowid);

    const countRow = db.prepare("SELECT COUNT(*) as c FROM mem_vec").get() as { c: number };
    // eslint-disable-next-line no-console
    console.log("mem_vec count:", countRow.c);

    const hits = vec.search(v1, 5);
    // eslint-disable-next-line no-console
    console.log("hits:", hits);
    expect(hits.length).toBe(1);
  });
});
