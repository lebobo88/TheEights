import { z } from "zod";
import type { SqliteStore } from "../stores/sqlite.js";
import type { AuditEngine } from "../engines/audit.js";

export const TraceArgs = z.object({
  trace_id: z.string().optional(),
  run_id: z.string().optional(),
  kind: z.string().optional(),
  limit: z.number().int().positive().max(500).default(100),
});

/**
 * VerifyArgs — args for eights.audit.verify.
 *
 * `full` (default: false / absent):
 *   false → incremental verification: resumes from the last persisted
 *           audit checkpoint and only re-hashes events after it, then
 *           advances the checkpoint to the new tip. This is O(new events)
 *           and is safe for routine gateway/governance health probes.
 *   true  → full from-genesis deep verify: ignores the checkpoint and
 *           re-hashes the entire ledger from event_id 1. Slow on large
 *           ledgers (~3 GB / 658k events). Use for the periodic
 *           AuditVerifierJob or operator-initiated forensic checks only.
 *
 * NOTE: if no checkpoint has ever been written (first run, or checkpoint
 * reset), incremental verify falls back to scanning from genesis — same
 * cost as full. The operator should run `eights-audit-repair` once to
 * establish a current checkpoint so that subsequent incremental verifies
 * are fast.
 */
export const VerifyArgs = z.object({
  full: z.boolean().optional(),
});

export function registerAuditTools(audit: AuditEngine, sql: SqliteStore) {
  return {
    "eights.audit.trace": {
      schema: TraceArgs,
      handler: (a: z.infer<typeof TraceArgs>) => {
        const filters: string[] = [];
        const params: unknown[] = [];
        if (a.kind) { filters.push("kind = ?"); params.push(a.kind); }
        if (a.trace_id) {
          filters.push("json_extract(envelope_json, '$.trace_id') = ?");
          params.push(a.trace_id);
        }
        if (a.run_id) {
          filters.push("json_extract(payload_json, '$.run_id') = ?");
          params.push(a.run_id);
        }
        const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
        const sqlStmt = `SELECT event_id, ts, kind, envelope_json, payload_json, hash
                         FROM events ${where}
                         ORDER BY event_id DESC LIMIT ?`;
        params.push(a.limit);
        return sql.db.prepare(sqlStmt).all(...params);
      },
    },
    /**
     * eights.audit.verify — verify the append-only audit hash chain.
     *
     * Incremental by default (no args / full:false): resumes from the
     * persisted audit checkpoint, re-hashes only new events, and advances
     * the checkpoint. O(new events) — safe for frequent health probes.
     *
     * Pass { full: true } for a from-genesis deep verify (slow on large
     * ledgers). Prefer the scheduled AuditVerifierJob for that path.
     */
    "eights.audit.verify": {
      schema: VerifyArgs,
      handler: (args: z.infer<typeof VerifyArgs>) =>
        audit.verifyChain({ full: args?.full === true }),
    },
  } as const;
}
