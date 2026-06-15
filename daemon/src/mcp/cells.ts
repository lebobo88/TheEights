import { z } from "zod";
import { Envelope } from "../schemas/envelope.js";
import { Cell } from "../schemas/memory.js";
import type { SqliteStore } from "../stores/sqlite.js";
import type { CellClassifier } from "../cognitive/cell-classifier.js";
import type { AuditEngine } from "../engines/audit.js";

export const DistributionArgs = z.object({
  envelope: Envelope,
  scope: z.object({
    workflow_id: z.string().optional(),
    project_id: z.string().optional(),
    actor: z.string().optional(),
    since: z.string().optional(),
  }).optional(),
});

export const QueryArgs = z.object({
  envelope: Envelope,
  cell: Cell,
  top_k: z.number().int().positive().max(100).default(20),
});

export const ClassifyArgs = z.object({
  envelope: Envelope,
  text: z.string(),
  summary: z.string().optional(),
});

export function registerCellTools(sql: SqliteStore, classifier: CellClassifier, audit: AuditEngine) {
  return {
    "eights.cells.distribution": {
      description: "Count memories per cell within an optional scope. Drives the manifesto 4-vs-8-cell A/B test.",
      schema: DistributionArgs,
      handler: async (a: z.infer<typeof DistributionArgs>) => {
        const where: string[] = ["tenant_id = ?"];
        const params: unknown[] = [a.envelope.tenant_id];
        if (a.scope?.project_id) { where.push("project_id = ?"); params.push(a.scope.project_id); }
        if (a.scope?.since) { where.push("created_at >= ?"); params.push(a.scope.since); }
        if (a.scope?.workflow_id) {
          where.push("provenance_json LIKE ?");
          params.push(`%"run_id":"${a.scope.workflow_id}"%`);
        }
        const rows = sql.db.prepare(
          `SELECT cell, COUNT(*) AS n FROM memories WHERE ${where.join(" AND ")} GROUP BY cell`,
        ).all(...params) as Array<{ cell: string | null; n: number }>;
        const dist: Record<string, number> = {
          vision: 0, context: 0, triggers: 0, influence: 0,
          risk: 0, focus: 0, constraints: 0, delight: 0, untagged: 0,
        };
        for (const r of rows) dist[r.cell ?? "untagged"] = r.n;
        audit.record("cells.distribution", a.envelope, { scope: a.scope, dist });
        return dist;
      },
    },
    "eights.cells.query": {
      description: "Retrieve recent memories matching a single cell.",
      schema: QueryArgs,
      handler: async (a: z.infer<typeof QueryArgs>) => {
        const rows = sql.db.prepare(
          `SELECT id, type, summary, content, handle, created_at FROM memories
           WHERE tenant_id = ? AND cell = ?
           ORDER BY created_at DESC LIMIT ?`,
        ).all(a.envelope.tenant_id, a.cell, a.top_k) as Array<{ id: string; type: string; summary: string | null; content: string; handle: string | null; created_at: string }>;
        return rows;
      },
    },
    "eights.cells.classify": {
      description: "Classify a text into the 8-cell vocabulary. Keyword-first; falls back to local Ollama completer when keywords are ambiguous.",
      schema: ClassifyArgs,
      handler: async (a: z.infer<typeof ClassifyArgs>, ctx?: { signal: AbortSignal }) => {
        const cell = await classifier.classifyAsync(a.text, a.summary, ctx?.signal);
        return { cell };
      },
    },
  } as const;
}
