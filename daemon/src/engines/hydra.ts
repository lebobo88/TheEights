/**
 * HydraEngine — durable, audited, semantically-indexed home for Hydra
 * envelopes. Replaces the Phase-4 stub in adapters/hydra-bridge.ts.
 *
 * Every recorded envelope produces:
 *   1. A row in hydra_envelopes (durable, queryable by workflow/type/squad).
 *   2. A semantic memory row containing the envelope's `objective` /
 *      `summary` / `description` (whichever the type exposes) so future
 *      similar requests can retrieve precedent via memory.search.
 *   3. An audit event chained into the hash log.
 */
import { nanoid } from "nanoid";
import type { SqliteStore } from "../stores/sqlite.js";
import type { AuditEngine } from "./audit.js";
import type { MemoryEngine } from "./memory.js";
import type { Envelope } from "../schemas/envelope.js";
import type { HydraEnvelope } from "../schemas/hydra-envelope.js";

export interface RecordResult {
  envelope_id: string;
  memory_id: string | null;
  workflow_id: string;
  type: string;
}

export interface EnvelopeQuery {
  workflow_id?: string;
  type?: string;
  target_squad?: string;
  origin_squad?: string;
  since?: string;
  limit?: number;
}

export class HydraEngine {
  constructor(
    private readonly sql: SqliteStore,
    private readonly audit: AuditEngine,
    private readonly memory: MemoryEngine,
  ) {}

  async record(env: Envelope, hydra: HydraEnvelope): Promise<RecordResult> {
    const envelope_id = hydra.id || `hydraenv_${nanoid()}`;
    const recorded_at = new Date().toISOString();
    const summary = extractSummary(hydra);

    let memory_id: string | null = null;
    if (summary) {
      try {
        const mem = await this.memory.add(env, {
          type: "semantic",
          content: summary,
          summary,
          scopes: [`workflow:${hydra.workflow_id}`, `squad:${hydra.origin_squad}`],
          provenance: {
            run_id: hydra.workflow_id,
            actor: hydra.origin_squad,
            source_uri: `hydra-envelope://${hydra.type}/${envelope_id}`,
          },
          confidence: 0.7,
        });
        memory_id = mem.id;
      } catch {
        // policy gates may reject; envelope still recorded below
      }
    }

    this.sql.db.prepare(
      `INSERT INTO hydra_envelopes(
        envelope_id, workflow_id, type, origin_squad, target_squad,
        payload_json, context_refs_json, tenant_id, project_id, recorded_at, memory_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      envelope_id, hydra.workflow_id, hydra.type, hydra.origin_squad, hydra.target_squad ?? null,
      JSON.stringify(hydra), JSON.stringify(hydra.context_refs ?? []),
      env.tenant_id, env.project_id, recorded_at, memory_id,
    );

    this.audit.record("hydra.envelope.record", env, {
      envelope_id, workflow_id: hydra.workflow_id, type: hydra.type,
      origin_squad: hydra.origin_squad, target_squad: hydra.target_squad ?? null,
      memory_id,
    });

    return { envelope_id, memory_id, workflow_id: hydra.workflow_id, type: hydra.type };
  }

  query(env: Envelope, q: EnvelopeQuery): Array<Record<string, unknown>> {
    const where: string[] = ["tenant_id = ?"];
    const params: unknown[] = [env.tenant_id];
    if (q.workflow_id) { where.push("workflow_id = ?"); params.push(q.workflow_id); }
    if (q.type) { where.push("type = ?"); params.push(q.type); }
    if (q.target_squad) { where.push("target_squad = ?"); params.push(q.target_squad); }
    if (q.origin_squad) { where.push("origin_squad = ?"); params.push(q.origin_squad); }
    if (q.since) { where.push("recorded_at >= ?"); params.push(q.since); }
    const limit = Math.max(1, Math.min(500, q.limit ?? 100));
    const rows = this.sql.db.prepare(
      `SELECT envelope_id, workflow_id, type, origin_squad, target_squad,
              payload_json, recorded_at, memory_id
       FROM hydra_envelopes
       WHERE ${where.join(" AND ")}
       ORDER BY recorded_at DESC
       LIMIT ?`,
    ).all(...params, limit) as Array<{
      envelope_id: string; workflow_id: string; type: string;
      origin_squad: string; target_squad: string | null;
      payload_json: string; recorded_at: string; memory_id: string | null;
    }>;
    this.audit.record("hydra.envelope.query", env, { ...q, returned: rows.length });
    return rows.map((r) => ({
      envelope_id: r.envelope_id,
      workflow_id: r.workflow_id,
      type: r.type,
      origin_squad: r.origin_squad,
      target_squad: r.target_squad,
      recorded_at: r.recorded_at,
      memory_id: r.memory_id,
      payload: JSON.parse(r.payload_json) as unknown,
    }));
  }

  /** Every cross-squad delegation in a workflow, oldest first. */
  listHandoffs(env: Envelope, workflow_id: string): Array<Record<string, unknown>> {
    const rows = this.sql.db.prepare(
      `SELECT envelope_id, type, origin_squad, target_squad, recorded_at, payload_json
       FROM hydra_envelopes
       WHERE tenant_id = ? AND workflow_id = ? AND type = 'HANDOFF'
       ORDER BY recorded_at ASC`,
    ).all(env.tenant_id, workflow_id) as Array<{ envelope_id: string; type: string; origin_squad: string; target_squad: string | null; recorded_at: string; payload_json: string }>;
    return rows.map((r) => ({
      envelope_id: r.envelope_id,
      origin_squad: r.origin_squad,
      target_squad: r.target_squad,
      recorded_at: r.recorded_at,
      payload: JSON.parse(r.payload_json) as unknown,
    }));
  }
}

function extractSummary(h: HydraEnvelope): string | null {
  const candidates: Array<unknown> = [
    (h as Record<string, unknown>).objective,
    (h as Record<string, unknown>).summary,
    (h as Record<string, unknown>).description,
    (h as Record<string, unknown>).goal,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.slice(0, 4000);
  }
  return null;
}
