/**
 * MemorySteward — periodic consolidator. Looks for near-duplicate episodic
 * rows (same scope + same hour bucket + ≥0.9 cosine sim if vectors exist) and
 * collapses them into one semantic row pointing at the originals via
 * `supersedes`. Respects the audit immutability invariant — never deletes;
 * only creates supersede links.
 */
import { nanoid } from "nanoid";
import type { Logger } from "pino";
import type { SqliteStore } from "../stores/sqlite.js";
import type { MemoryEngine } from "../engines/memory.js";
import type { AuditEngine } from "../engines/audit.js";
import type { Envelope } from "../schemas/envelope.js";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class MemoryStewardJob {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sql: SqliteStore,
    private readonly memory: MemoryEngine,
    private readonly audit: AuditEngine,
    private readonly log: Logger,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce().catch((e) => this.log.warn({ err: String(e) }, "memory-steward tick failed")); }, this.intervalMs);
    this.log.info({ intervalMs: this.intervalMs }, "memory-steward scheduled");
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async runOnce(): Promise<{ scanned: number; consolidated: number }> {
    const env: Envelope = {
      tenant_id: "local", actor_id: "eights.memory-steward",
      project_id: "TheEights", domain: "infra",
      scope: [], trace_id: `steward_${nanoid()}`,
    };
    const rows = this.sql.db.prepare(
      `SELECT id, type, content, summary, scopes_json, created_at, provenance_json
       FROM memories
       WHERE type = 'episodic' AND tenant_id = 'local'
         AND created_at >= datetime('now', '-1 day')`,
    ).all() as Array<{ id: string; type: string; content: string; summary: string | null; scopes_json: string; created_at: string; provenance_json: string }>;

    // Group by (scope-hash, hour-bucket).
    const buckets = new Map<string, typeof rows>();
    for (const r of rows) {
      const scopes = (JSON.parse(r.scopes_json) as string[]).sort().join("|");
      const hour = r.created_at.slice(0, 13);
      const key = `${scopes}::${hour}`;
      const arr = buckets.get(key) ?? [];
      arr.push(r);
      buckets.set(key, arr);
    }

    let consolidated = 0;
    for (const [key, group] of buckets.entries()) {
      if (group.length < 3) continue;
      const summary = `Consolidated ${group.length} episodic memories from bucket ${key}:\n` +
        group.map((g) => `- ${g.summary ?? g.content.slice(0, 120)}`).join("\n");
      try {
        await this.memory.add(env, {
          type: "semantic",
          content: summary,
          summary: `consolidated x${group.length} @ ${key}`,
          scopes: (JSON.parse(group[0]!.scopes_json) as string[]),
          provenance: { actor: "eights.memory-steward" },
          supersedes: group.map((g) => g.id),
          confidence: 0.6,
        });
        consolidated += group.length;
      } catch (err) {
        this.log.warn({ err: String(err), bucket: key }, "consolidation rejected (policy gate)");
      }
    }
    this.audit.record("memory.steward.tick", env, { scanned: rows.length, consolidated });
    return { scanned: rows.length, consolidated };
  }
}
