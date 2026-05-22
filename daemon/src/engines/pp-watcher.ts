/**
 * Non-invasive pair-programmer watcher.
 *
 * Reads ~/.pair-programmer/state.db (read-only) and ingests finalized runs,
 * verdicts, and missability outcomes via the PpBridge. Uses a watermark stored
 * in TheEights' daemon_meta so we never re-ingest a row.
 *
 * Polling interval is 5s by default; can be driven manually via syncNow().
 */
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Logger } from "pino";
import type { PpBridge } from "../adapters/pp-bridge.js";
import type { SqliteStore } from "../stores/sqlite.js";
import type { Envelope } from "../schemas/envelope.js";

interface PpRunRow {
  id: string;
  request_text: string;
  status: string;
  profile_snapshot_json: string | null;
  taxonomy_mapping_json: string | null;
  finished_at: string | null;
}

interface PpVerdictRow {
  id: string;
  run_id: string;          // derived via JOIN attempts -> stages
  attempt_id: string;      // pp verdicts.attempt_id (verdicts attach to attempts, not stages)
  judge_producer: string;
  judge_model_id: string;  // pp column is judge_model_id, not judge_model
  rubric_id: string;
  outcome: string;
  critique_md: string | null;
  score_json: string | null;
  cross_vendor: number;
  created_at: string;      // pp column is created_at, not recorded_at
}

export interface PpWatcherOptions {
  ppStatePath?: string;
  pollMs?: number;
}

export class PpWatcher {
  private timer: NodeJS.Timeout | null = null;
  private readonly ppStatePath: string;
  private readonly pollMs: number;
  private ppDb: Database.Database | null = null;
  private running = false;

  constructor(
    private readonly store: SqliteStore,
    private readonly bridge: PpBridge,
    private readonly log: Logger,
    opts: PpWatcherOptions = {},
  ) {
    this.ppStatePath = opts.ppStatePath ?? join(homedir(), ".pair-programmer", "state.db");
    this.pollMs = opts.pollMs ?? 5000;
  }

  start(): void {
    if (this.running) return;
    if (!existsSync(this.ppStatePath)) {
      this.log.info({ ppStatePath: this.ppStatePath }, "pp-watcher: pair-programmer state.db not found — watcher idle");
      return;
    }
    try {
      this.ppDb = new Database(this.ppStatePath, { readonly: true, fileMustExist: true });
    } catch (err) {
      this.log.warn({ err: String(err) }, "pp-watcher: cannot open pp state.db — watcher idle");
      return;
    }
    this.running = true;
    this.log.info({ ppStatePath: this.ppStatePath, pollMs: this.pollMs }, "pp-watcher started");
    // D2c — defer the first tick by pollMs instead of firing it immediately on
    // start. The boot-time tick used to dominate the event loop for tens of
    // seconds (rejected memory writes against the consistency gate, each one
    // taking the IMMEDIATE write lock on the audit log) which starved the MCP
    // stdio transport's stdin reads and caused Claude Code's 30s connection
    // timeout. Letting the first tick run after pollMs gives the MCP handshake
    // (initialize + tools/list) plenty of room to land first.
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ppDb?.close();
    this.ppDb = null;
    this.running = false;
  }

  /** Manually drive one polling cycle and return how many events were ingested. */
  async syncNow(): Promise<{ runs: number; verdicts: number }> {
    return this.tick();
  }

  private getWatermark(key: string): string {
    const row = this.store.db
      .prepare("SELECT value FROM daemon_meta WHERE key = ?")
      .get(`pp-watcher:${key}`) as { value: string } | undefined;
    return row?.value ?? "1970-01-01T00:00:00Z";
  }

  private setWatermark(key: string, value: string): void {
    this.store.db
      .prepare(
        `INSERT INTO daemon_meta(key, value, updated_at) VALUES (?,?,datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .run(`pp-watcher:${key}`, value);
  }

  private async tick(): Promise<{ runs: number; verdicts: number }> {
    if (!this.ppDb) return { runs: 0, verdicts: 0 };
    let runs = 0;
    let verdicts = 0;
    try {
      runs = await this.ingestFinalizedRuns();
      verdicts = await this.ingestVerdicts();
    } catch (err) {
      this.log.warn({ err: String(err) }, "pp-watcher tick failed");
    }
    return { runs, verdicts };
  }

  private async ingestFinalizedRuns(): Promise<number> {
    if (!this.ppDb) return 0;
    const watermark = this.getWatermark("runs");
    // pp schema: runs(id, request_text, status, profile_snapshot_json, taxonomy_mapping_json, finished_at, ...)
    // RunStatus enum (pp/daemon/src/config.ts:79): "pending" | "running" | "surfaced" | "complete" | "crashed" | "aborted".
    // We ingest any TERMINAL run — complete (clean), surfaced (HITL gate), aborted (B7 supervisor crash drain), crashed.
    const rows = this.ppDb
      .prepare(
        `SELECT id, request_text, status, profile_snapshot_json, taxonomy_mapping_json, finished_at
         FROM runs
         WHERE status IN ('complete','surfaced','aborted','crashed') AND finished_at IS NOT NULL AND finished_at > ?
         ORDER BY finished_at ASC
         LIMIT 200`,
      )
      .all(watermark) as PpRunRow[];
    if (!rows.length) return 0;

    let highWater = watermark;
    for (const r of rows) {
      const taxonomy = r.taxonomy_mapping_json ? safeJson(r.taxonomy_mapping_json) : {};
      const env: Envelope = {
        tenant_id: "local",
        actor_id: "pp-watcher",
        project_id: inferProjectId(r) ?? "pair-programmer",
        domain: "code",
        scope: [`run:${r.id}`, `pp.status:${r.status}`],
        trace_id: `pp_run_${r.id}`,
      };
      await this.bridge.ingest(env, {
        kind: "pp.finalize_run",
        run_id: r.id,
        project_id: env.project_id,
        taxonomy_mapping: taxonomy as Record<string, unknown>,
        verdict_summary: this.summarizeVerdicts(r.id),
        missability: this.collectMissability(r.id),
        artifacts: this.collectArtifacts(r.id),
      });
      if (r.finished_at && r.finished_at > highWater) highWater = r.finished_at;
      // D2c — yield to the macrotask queue between rows so MCP stdin reads
      // don't starve when ingesting a backlog.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.setWatermark("runs", highWater);
    this.log.info({ count: rows.length, watermark: highWater }, "pp-watcher: ingested finalized runs");
    return rows.length;
  }

  private async ingestVerdicts(): Promise<number> {
    if (!this.ppDb) return 0;
    const watermark = this.getWatermark("verdicts");
    // pp schema topology: runs -> stages -> attempts -> verdicts. verdicts have
    // `attempt_id` (NOT stage_id); to derive run_id + stage_kind we hop through
    // attempts -> stages. Field names: judge_model_id (not judge_model),
    // created_at (not recorded_at). See pair-programmer/daemon/src/db/schema.ts.
    const rows = this.ppDb
      .prepare(
        `SELECT v.id, v.attempt_id, s.run_id, v.judge_producer, v.judge_model_id,
                v.rubric_id, v.outcome, v.critique_md, v.score_json,
                v.cross_vendor, v.created_at, s.kind as stage_kind
         FROM verdicts v
         JOIN attempts a ON a.id = v.attempt_id
         JOIN stages s ON s.id = a.stage_id
         WHERE v.created_at > ?
         ORDER BY v.created_at ASC
         LIMIT 500`,
      )
      .all(watermark) as Array<PpVerdictRow & { stage_kind: string }>;
    if (!rows.length) return 0;

    let highWater = watermark;
    for (const r of rows) {
      const env: Envelope = {
        tenant_id: "local",
        actor_id: "pp-watcher",
        project_id: "pair-programmer",
        domain: "code",
        scope: [`run:${r.run_id}`, `rubric:${r.rubric_id}`, `stage:${r.stage_kind}`],
        trace_id: `pp_verdict_${r.id}`,
      };
      const score = r.score_json ? extractNumericScore(safeJson(r.score_json)) : 0;
      await this.bridge.ingest(env, {
        kind: "pp.record_verdict",
        run_id: r.run_id,
        stage_kind: r.stage_kind,
        rubric_id: r.rubric_id,
        outcome: r.outcome as "passed" | "failed" | "surfaced",
        score,
        critique_md: r.critique_md ?? "",
      });
      if (r.created_at > highWater) highWater = r.created_at;
      // D2c — yield (see ingestFinalizedRuns).
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.setWatermark("verdicts", highWater);
    this.log.info({ count: rows.length, watermark: highWater }, "pp-watcher: ingested verdicts");
    return rows.length;
  }

  private summarizeVerdicts(runId: string): { passed: number; failed: number; surfaced: number } {
    if (!this.ppDb) return { passed: 0, failed: 0, surfaced: 0 };
    // Same topology fix as ingestVerdicts — verdicts -> attempts -> stages.
    const rows = this.ppDb
      .prepare(
        `SELECT v.outcome, COUNT(*) as n FROM verdicts v
         JOIN attempts a ON a.id = v.attempt_id
         JOIN stages s ON s.id = a.stage_id
         WHERE s.run_id = ? GROUP BY v.outcome`,
      )
      .all(runId) as Array<{ outcome: string; n: number }>;
    const out = { passed: 0, failed: 0, surfaced: 0 };
    for (const r of rows) {
      if (r.outcome in out) (out as Record<string, number>)[r.outcome] = r.n;
    }
    return out;
  }

  private collectMissability(runId: string): Array<{ check_id: string; status: "passed" | "failed" }> {
    if (!this.ppDb) return [];
    try {
      const rows = this.ppDb
        .prepare(`SELECT check_id, status FROM missability_checks WHERE run_id = ?`)
        .all(runId) as Array<{ check_id: string; status: string }>;
      return rows.map((r) => ({ check_id: r.check_id, status: r.status === "passed" ? "passed" : "failed" }));
    } catch {
      return [];
    }
  }

  private collectArtifacts(runId: string): Array<{ path: string; sha256: string; kind: string; taxonomy_section: string }> {
    if (!this.ppDb) return [];
    try {
      const rows = this.ppDb
        .prepare(`SELECT path, sha256, kind, taxonomy_section FROM artifacts WHERE run_id = ?`)
        .all(runId) as Array<{ path: string; sha256: string; kind: string; taxonomy_section: string }>;
      return rows;
    } catch {
      return [];
    }
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return {}; }
}

function inferProjectId(_r: PpRunRow): string | null {
  // pp doesn't store an explicit project_id; the request text + profile snapshot
  // are the only signal. For now, group everything under "pair-programmer";
  // Phase 4 miner can split by HEAD repo name if needed.
  return null;
}

function extractNumericScore(obj: unknown): number {
  if (typeof obj !== "object" || obj === null) return 0;
  const o = obj as Record<string, unknown>;
  if (typeof o.score === "number") return o.score;
  if (typeof o.overall === "number") return o.overall;
  return 0;
}
