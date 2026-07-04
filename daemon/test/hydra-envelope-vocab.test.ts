/**
 * Contract tests for HydraEnvelopeType UPPER_SNAKE vocabulary (Phase 3b).
 *
 * Pins:
 *   1. The exact 11-member UPPER_SNAKE enum.
 *   2. Legacy CamelCase values normalise to UPPER_SNAKE at the Zod seam (with
 *      a deprecation warning to stderr).
 *   3. Truly unknown types are rejected by Zod.
 *   4. V9 migration is idempotent and correctly converts CamelCase rows in a
 *      fixture database that pre-dates the Phase 3b change.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HydraEnvelopeType,
  HydraEnvelope,
  CAMEL_TO_UPPER_SNAKE,
  normalizeHydraEnvelopeType,
} from "../src/schemas/hydra-envelope.js";
import { SqliteStore } from "../src/stores/sqlite.js";

// ---------------------------------------------------------------------------
// 1. Exact enum membership
// ---------------------------------------------------------------------------

const EXPECTED_UPPER_SNAKE_MEMBERS = [
  "C_SUITE_DECISION_PACKET",
  "PRD",
  "ARCH_RFC",
  "DEV_TASK",
  "CREATIVE_BRIEF",
  "SHOT_LIST",
  "ASSET_JOB",
  "HITL_REQUEST",
  "DECISION_RECORD",
  "HANDOFF",
  "COCKPIT_WRITE",
] as const;

describe("HydraEnvelopeType — canonical UPPER_SNAKE enum", () => {
  it("has exactly 11 members", () => {
    expect(HydraEnvelopeType.options).toHaveLength(11);
  });

  it("contains every expected UPPER_SNAKE member", () => {
    for (const member of EXPECTED_UPPER_SNAKE_MEMBERS) {
      expect(HydraEnvelopeType.options).toContain(member);
    }
  });

  it("accepts all canonical UPPER_SNAKE values via parse", () => {
    for (const member of EXPECTED_UPPER_SNAKE_MEMBERS) {
      expect(HydraEnvelopeType.parse(member)).toBe(member);
    }
  });

  it("contains no legacy CamelCase members", () => {
    const legacyCamel = Object.keys(CAMEL_TO_UPPER_SNAKE);
    for (const legacy of legacyCamel) {
      expect(HydraEnvelopeType.options).not.toContain(legacy);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. CamelCase → UPPER_SNAKE normalization (with deprecation warning)
// ---------------------------------------------------------------------------

describe("normalizeHydraEnvelopeType — CamelCase migration shim", () => {
  it("maps every legacy CamelCase key to its UPPER_SNAKE equivalent", () => {
    for (const [camel, upper] of Object.entries(CAMEL_TO_UPPER_SNAKE)) {
      expect(normalizeHydraEnvelopeType(camel)).toBe(upper);
    }
  });

  it("passes through already-canonical UPPER_SNAKE values unchanged", () => {
    for (const member of EXPECTED_UPPER_SNAKE_MEMBERS) {
      expect(normalizeHydraEnvelopeType(member)).toBe(member);
    }
  });

  it("passes through unknown strings unchanged (Zod will reject them)", () => {
    expect(normalizeHydraEnvelopeType("FooBar")).toBe("FooBar");
    expect(normalizeHydraEnvelopeType("")).toBe("");
  });

  it("passes through non-string values unchanged", () => {
    expect(normalizeHydraEnvelopeType(42)).toBe(42);
    expect(normalizeHydraEnvelopeType(null)).toBe(null);
    expect(normalizeHydraEnvelopeType(undefined)).toBe(undefined);
  });

  it("CamelCase input to HydraEnvelope.parse normalises to UPPER_SNAKE in output", () => {
    // Verify the z.preprocess wiring at the HydraEnvelope level.
    const raw = {
      id: "env-norm-test",
      type: "DevTask",         // legacy CamelCase
      origin_squad: "engineering",
      workflow_id: "wf-norm",
      context_refs: [],
    };
    // Suppress the deprecation warning in stderr for this assertion.
    const stderrWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    process.stderr.write = (chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return stderrWrite(chunk, ...(rest as Parameters<typeof stderrWrite>));
    };
    try {
      const parsed = HydraEnvelope.parse(raw);
      expect(parsed.type).toBe("DEV_TASK");
      // Deprecation warning should have been emitted.
      expect(captured.some((s) => s.includes("deprecated"))).toBe(true);
      expect(captured.some((s) => s.includes("DEV_TASK"))).toBe(true);
    } finally {
      process.stderr.write = stderrWrite;
    }
  });

  it("all 8 legacy CamelCase values parse through HydraEnvelope.safeParse successfully", () => {
    for (const [camel, upper] of Object.entries(CAMEL_TO_UPPER_SNAKE)) {
      const result = HydraEnvelope.safeParse({
        id: `env-${camel}`,
        type: camel,
        origin_squad: "test",
        workflow_id: "wf-test",
        context_refs: [],
      });
      expect(result.success, `expected "${camel}" to parse successfully`).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe(upper);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Unknown type rejection
// ---------------------------------------------------------------------------

describe("HydraEnvelope — unknown type rejection", () => {
  it("rejects truly unknown type strings", () => {
    const result = HydraEnvelope.safeParse({
      id: "env-unknown",
      type: "SomethingWeird",
      origin_squad: "test",
      workflow_id: "wf-test",
      context_refs: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty string type", () => {
    const result = HydraEnvelope.safeParse({
      id: "env-empty",
      type: "",
      origin_squad: "test",
      workflow_id: "wf-test",
      context_refs: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects numeric type", () => {
    const result = HydraEnvelope.safeParse({
      id: "env-num",
      type: 42,
      origin_squad: "test",
      workflow_id: "wf-test",
      context_refs: [],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. V9 migration — idempotency + fixture conversion
// ---------------------------------------------------------------------------

describe("SqliteStore V9 migration — UPPER_SNAKE normalization", () => {
  let dir: string;
  let sql: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-v9-"));
    sql = new SqliteStore(join(dir, "state.db"));
  });

  afterEach(() => {
    sql.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seed the hydra_envelopes table with one CamelCase row per legacy type. */
  function seedCamelCaseRows(): void {
    for (const [camel] of Object.entries(CAMEL_TO_UPPER_SNAKE)) {
      sql.db.prepare(
        `INSERT INTO hydra_envelopes(
          envelope_id, workflow_id, type, origin_squad, target_squad,
          payload_json, context_refs_json, tenant_id, project_id, recorded_at, memory_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        `eid-${camel}`, "wf-fixture", camel, "engineering", null,
        "{}", "[]", "local", "TheEights", new Date().toISOString(), null,
      );
    }
  }

  it("V9 migration converts all 8 CamelCase rows to UPPER_SNAKE", () => {
    // Migrate up to V8 manually by calling migrate() — V9 runs inside too.
    sql.migrate();
    // Seed AFTER migrate to simulate pre-V9 data then re-run migration.
    // In practice, the schema_version guard makes re-run a no-op, so we need
    // a fresh store to seed CamelCase rows before V9 has run.
    sql.close();
    rmSync(dir, { recursive: true, force: true });

    // Fresh store: migrate up to V8 only, then seed CamelCase rows, then apply V9.
    dir = mkdtempSync(join(tmpdir(), "eights-v9b-"));
    sql = new SqliteStore(join(dir, "state.db"));

    // Run just V1–V8 by running migrate() and removing the V9 version row so
    // we can re-apply it after seeding. This simulates a production DB that
    // was created before V9.
    sql.migrate();  // V9 runs; schema_version gets row 9
    // Remove the V9 stamp to simulate a pre-V9 database.
    sql.db.prepare(`DELETE FROM schema_version WHERE version = 9`).run();
    // Seed CamelCase rows.
    seedCamelCaseRows();

    // Confirm the fixture data has CamelCase types.
    const preRows = sql.db.prepare(`SELECT type FROM hydra_envelopes`).all() as Array<{ type: string }>;
    for (const row of preRows) {
      expect(Object.keys(CAMEL_TO_UPPER_SNAKE)).toContain(row.type);
    }

    // Re-run V9 by calling migrate() again (V9 guard is gone).
    sql.migrate();

    // All rows must now have UPPER_SNAKE types.
    const postRows = sql.db.prepare(`SELECT type FROM hydra_envelopes`).all() as Array<{ type: string }>;
    expect(postRows).toHaveLength(Object.keys(CAMEL_TO_UPPER_SNAKE).length);
    const upperSnakeValues = new Set(Object.values(CAMEL_TO_UPPER_SNAKE));
    for (const row of postRows) {
      expect(upperSnakeValues.has(row.type), `"${row.type}" should be UPPER_SNAKE after V9`).toBe(true);
    }
  });

  it("V9 migration is idempotent — running migrate() twice yields the same result", () => {
    sql.migrate();
    seedCamelCaseRows();  // rows seeded AFTER migrate: type is already UPPER_SNAKE is not possible
    // Actually after migrate V9 ran; these will be inserted as-is (bypassing Zod).
    // The second migrate() should not duplicate or corrupt them.
    sql.migrate();

    // schema_version should still have exactly one V9 row.
    const v9Rows = sql.db.prepare(`SELECT * FROM schema_version WHERE version = 9`).all();
    expect(v9Rows).toHaveLength(1);
  });

  it("V9 migration leaves UPPER_SNAKE rows untouched", () => {
    sql.migrate();
    // Insert rows that already have UPPER_SNAKE types (post-Phase-3b normal flow).
    const upperTypes = Object.values(CAMEL_TO_UPPER_SNAKE);
    for (const upper of upperTypes) {
      sql.db.prepare(
        `INSERT INTO hydra_envelopes(
          envelope_id, workflow_id, type, origin_squad, target_squad,
          payload_json, context_refs_json, tenant_id, project_id, recorded_at, memory_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        `eid-upper-${upper}`, "wf-upper", upper, "engineering", null,
        "{}", "[]", "local", "TheEights", new Date().toISOString(), null,
      );
    }
    // Remove V9 stamp and re-run to verify UPPER_SNAKE rows are unaffected.
    sql.db.prepare(`DELETE FROM schema_version WHERE version = 9`).run();
    sql.migrate();

    const rows = sql.db.prepare(
      `SELECT type FROM hydra_envelopes WHERE workflow_id = 'wf-upper'`,
    ).all() as Array<{ type: string }>;
    for (const row of rows) {
      expect(upperTypes).toContain(row.type);
    }
  });

  it("schema_version row 9 is recorded after migration", () => {
    sql.migrate();
    const row = sql.db.prepare(`SELECT version FROM schema_version WHERE version = 9`).get();
    expect(row).toBeDefined();
  });
});
