/**
 * CostAnalystJob — daily aggregator over governance_ledger. Produces a
 * semantic memo (semantic ring) of overruns + projected burn so operators
 * can search "yesterday's most expensive run" via memory.search.
 */
import { nanoid } from "nanoid";
import type { Logger } from "pino";
import type { SqliteStore } from "../stores/sqlite.js";
import type { MemoryEngine } from "../engines/memory.js";
import type { AuditEngine } from "../engines/audit.js";
import type { Envelope } from "../schemas/envelope.js";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class CostAnalystJob {
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
    this.timer = setInterval(() => { void this.runOnce().catch((e) => this.log.warn({ err: String(e) }, "cost-analyst tick failed")); }, this.intervalMs);
    this.log.info({ intervalMs: this.intervalMs }, "cost-analyst scheduled");
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async runOnce(): Promise<{ runs: number; total_usd: number; over_budget: number }> {
    const env: Envelope = {
      tenant_id: "local", actor_id: "eights.cost-analyst",
      project_id: "TheEights", domain: "infra",
      scope: [], trace_id: `cost_${nanoid()}`,
    };

    const sinceISO = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const rows = this.sql.db.prepare(
      `SELECT run_id, SUM(delta) AS spent, MAX(cap) AS cap, MAX(action) AS action
       FROM governance_ledger
       WHERE kind = 'budget' AND at >= ?
       GROUP BY run_id
       ORDER BY spent DESC`,
    ).all(sinceISO) as Array<{ run_id: string; spent: number; cap: number; action: string }>;

    const total_usd = rows.reduce((s, r) => s + (r.spent || 0), 0);
    const over_budget = rows.filter((r) => r.action === "block").length;
    const top = rows.slice(0, 10);

    const memo = [
      `Cost report — 24h to ${new Date().toISOString()}`,
      `runs=${rows.length} total=$${total_usd.toFixed(2)} over_budget=${over_budget}`,
      ``,
      `Top runs by spend:`,
      ...top.map((r) => `  - ${r.run_id}: $${(r.spent || 0).toFixed(2)} (cap $${r.cap.toFixed(2)}, action=${r.action})`),
    ].join("\n");

    try {
      await this.memory.add(env, {
        type: "semantic",
        content: memo,
        summary: `cost report 24h: runs=${rows.length} total=$${total_usd.toFixed(2)}`,
        scopes: ["public", "cost"],
        provenance: { actor: "eights.cost-analyst" },
        confidence: 0.9,
        cell: "constraints",
      });
    } catch (err) {
      this.log.warn({ err: String(err) }, "cost memo rejected by policy");
    }

    this.audit.record("cost.analyst.tick", env, { runs: rows.length, total_usd, over_budget });
    return { runs: rows.length, total_usd, over_budget };
  }
}
