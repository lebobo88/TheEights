import { z } from "zod";
import type { SqliteStore } from "../stores/sqlite.js";
import type { AuditEngine } from "../engines/audit.js";

export const TraceArgs = z.object({
  trace_id: z.string().optional(),
  run_id: z.string().optional(),
  kind: z.string().optional(),
  limit: z.number().int().positive().max(500).default(100),
});

export const VerifyArgs = z.object({});

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
    "eights.audit.verify": {
      schema: VerifyArgs,
      handler: () => audit.verifyChain(),
    },
  } as const;
}
