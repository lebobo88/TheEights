/**
 * Cross-project pattern miner.
 *
 * Scheduled job that scans recent episodic memories for repeated patterns —
 * recurring rubric failures, repeated dissents on similar topics, persistent
 * missability check failures — and surfaces them as new *semantic* memories
 * tagged with `type:Pattern`. These patterns can be cited later as
 * `evidence_memory_ids` on evolution proposals.
 *
 * v1: simple frequency-based; LLM-backed clustering lands in Phase 4 follow-on.
 */
import type { Logger } from "pino";
import type { SqliteStore } from "../stores/sqlite.js";
import type { MemoryEngine } from "./memory.js";
import type { AuditEngine } from "./audit.js";
import type { Envelope } from "../schemas/envelope.js";

export class Miner {
  private timer: NodeJS.Timeout | null = null;
  private readonly pollMs: number;

  constructor(
    private readonly sql: SqliteStore,
    private readonly memory: MemoryEngine,
    private readonly audit: AuditEngine,
    private readonly log: Logger,
    opts: { pollMs?: number } = {},
  ) {
    this.pollMs = opts.pollMs ?? 3600_000; // hourly
  }

  startScheduled(): void {
    this.log.info({ pollMs: this.pollMs }, "miner scheduled");
    this.timer = setInterval(() => void this.runOnce(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<{ patterns_surfaced: number }> {
    const env: Envelope = {
      tenant_id: "local",
      actor_id: "miner",
      project_id: "TheEights",
      domain: "infra",
      scope: ["type:Pattern"],
      trace_id: `miner_${Date.now()}`,
    };
    let surfaced = 0;
    try {
      surfaced += await this.mineRecurringRubricFailures(env);
      surfaced += await this.mineMissabilityFailures(env);
    } catch (err) {
      this.log.warn({ err: String(err) }, "miner: runOnce failed");
    }
    this.audit.record("miner.run", env, { patterns_surfaced: surfaced });
    return { patterns_surfaced: surfaced };
  }

  private async mineRecurringRubricFailures(env: Envelope): Promise<number> {
    // Find rubric failures that have happened 3+ times in the last 30 days across runs.
    const rows = this.sql.db.prepare(`
      SELECT
        json_extract(scopes_json, '$') as scopes,
        COUNT(*) as n
      FROM memories
      WHERE type = 'episodic'
        AND domain = 'code'
        AND content LIKE '%failed%'
        AND datetime(created_at) > datetime('now', '-30 days')
        AND EXISTS (
          SELECT 1 FROM json_each(memories.scopes_json) WHERE value LIKE 'rubric:%'
        )
      GROUP BY scopes_json
      HAVING n >= 3
      LIMIT 25
    `).all() as Array<{ scopes: string; n: number }>;

    let count = 0;
    for (const r of rows) {
      const rubric = extractScope(r.scopes, /^rubric:/);
      if (!rubric) continue;
      await this.memory.add(env, {
        type: "semantic",
        content: `Pattern: ${rubric} has failed ${r.n} times in the last 30 days across runs. Candidate for rubric retuning or team-composition change.`,
        summary: `pattern: ${rubric} ×${r.n} fails / 30d`,
        scopes: ["type:Pattern", `pattern:rubric-recurring-failure`, rubric],
        provenance: { actor: "miner" },
        confidence: 0.6,
      });
      count += 1;
    }
    return count;
  }

  private async mineMissabilityFailures(env: Envelope): Promise<number> {
    const rows = this.sql.db.prepare(`
      SELECT content, COUNT(*) as n FROM memories
      WHERE type = 'episodic' AND content LIKE '%Missability failures:%'
        AND content NOT LIKE '%Missability failures: 0%'
        AND datetime(created_at) > datetime('now', '-30 days')
      GROUP BY substr(content, 1, 200)
      HAVING n >= 2
      LIMIT 25
    `).all() as Array<{ content: string; n: number }>;
    let count = 0;
    for (const r of rows) {
      await this.memory.add(env, {
        type: "semantic",
        content: `Pattern: repeated missability failure cluster (×${r.n}). Sample: ${r.content.slice(0, 280)}`,
        summary: `pattern: missability cluster ×${r.n}`,
        scopes: ["type:Pattern", "pattern:missability-cluster"],
        provenance: { actor: "miner" },
        confidence: 0.55,
      });
      count += 1;
    }
    return count;
  }
}

function extractScope(scopesJson: string, re: RegExp): string | null {
  try {
    const arr = JSON.parse(scopesJson) as string[];
    return arr.find((s) => re.test(s)) ?? null;
  } catch { return null; }
}
