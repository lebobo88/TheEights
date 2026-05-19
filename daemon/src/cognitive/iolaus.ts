/**
 * Iolaus — the cauterizer. Daily sweep for deprecation candidates so heads
 * don't grow back where they shouldn't (manifesto §"Iolaus").
 *
 * Heuristics:
 *   - Resource hasn't been read or written in N days (default 60).
 *   - No inbound audit edges referencing it in that window.
 *   - Not a critical-frozen resource (those are immortal by design).
 *
 * For each candidate Iolaus proposes a `# DEPRECATED` annotation via the
 * normal Evolution Engine flow (HITL on anything non-low). Operators see the
 * weekly digest as a memory of cell=focus.
 */
import { nanoid } from "nanoid";
import type { Logger } from "pino";
import type { SqliteStore } from "../stores/sqlite.js";
import type { EvolutionEngine } from "../engines/evolution.js";
import type { MemoryEngine } from "../engines/memory.js";
import type { AuditEngine } from "../engines/audit.js";
import type { Envelope } from "../schemas/envelope.js";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STALE_DAYS = 60;

export class IolausJob {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sql: SqliteStore,
    private readonly evolution: EvolutionEngine,
    private readonly memory: MemoryEngine,
    private readonly audit: AuditEngine,
    private readonly log: Logger,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    private readonly staleDays: number = STALE_DAYS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce().catch((e) => this.log.warn({ err: String(e) }, "iolaus tick failed")); }, this.intervalMs);
    this.log.info({ intervalMs: this.intervalMs, staleDays: this.staleDays }, "iolaus scheduled");
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async runOnce(): Promise<{ scanned: number; proposed: number; candidates: string[] }> {
    const env: Envelope = {
      tenant_id: "local", actor_id: "eights.iolaus",
      project_id: "TheEights", domain: "infra",
      scope: [], trace_id: `iolaus_${nanoid()}`,
    };
    const cutoff = new Date(Date.now() - this.staleDays * 86400 * 1000).toISOString();
    const stale = this.sql.db.prepare(
      `SELECT rid, kind, risk_class, evolution_policy, updated_at
       FROM resources
       WHERE updated_at < ?
         AND evolution_policy != 'frozen'
         AND risk_class != 'critical'`,
    ).all(cutoff) as Array<{ rid: string; kind: string; risk_class: string; evolution_policy: string; updated_at: string }>;

    const candidates: string[] = [];
    let proposed = 0;
    for (const s of stale) {
      const refs = this.sql.db.prepare(
        `SELECT COUNT(*) AS n FROM events WHERE payload_json LIKE ? AND ts > ?`,
      ).get(`%"${s.rid}"%`, cutoff) as { n: number };
      if (refs.n > 0) continue;
      candidates.push(s.rid);
      try {
        const r = this.evolution.getResource(s.rid);
        if (!r) continue;
        const current = this.evolution.readVersion(r.rid, r.current_version) ?? "";
        const candidate_content = `# DEPRECATED — proposed by Iolaus ${new Date().toISOString()}\n# Reason: no reads/writes in ${this.staleDays} days.\n\n${current}`;
        this.evolution.propose(env, {
          rid: s.rid,
          candidate_content,
          justification: `iolaus sweep: stale > ${this.staleDays} days`,
        });
        proposed += 1;
      } catch (err) {
        this.log.warn({ rid: s.rid, err: String(err) }, "iolaus propose failed");
      }
    }

    const memo = `Iolaus sweep ${new Date().toISOString().slice(0, 10)}:\n  scanned=${stale.length}\n  candidates=${candidates.length}\n  proposed=${proposed}\n\n` +
      candidates.slice(0, 50).map((c) => `  - ${c}`).join("\n");
    try {
      await this.memory.add(env, {
        type: "semantic",
        content: memo,
        summary: `iolaus sweep: ${candidates.length} candidates`,
        scopes: ["public", "lifecycle"],
        provenance: { actor: "eights.iolaus" },
        cell: "focus",
        confidence: 0.85,
      });
    } catch { /* ignore policy reject */ }

    this.audit.record("iolaus.tick", env, { scanned: stale.length, proposed, candidate_count: candidates.length });
    return { scanned: stale.length, proposed, candidates };
  }
}
