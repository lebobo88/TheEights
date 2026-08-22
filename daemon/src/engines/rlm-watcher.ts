/**
 * RLM watcher — tails RLM/progress/events.jsonl across all RLM* sibling projects.
 *
 * Auto-discovers projects under the RLM scan root (EIGHTS_RLM_ROOT, default:
 * the parent dir of the TheEights clone via config.rlmScanRoot) matching ^RLM
 * (RLMauth, RLMbackend, ..., RLM-CLI-Starter).
 */
import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { Logger } from "pino";
import type { SqliteStore } from "../stores/sqlite.js";
import type { RlmBridge } from "../adapters/rlm-bridge.js";
import { loadConfig } from "../config.js";

export interface RlmWatcherOptions {
  root?: string;
  pollMs?: number;
}

const DEFAULT_ROOT = loadConfig().rlmScanRoot;

export class RlmWatcher {
  private timer: NodeJS.Timeout | null = null;
  private readonly root: string;
  private readonly pollMs: number;
  private running = false;

  constructor(
    private readonly store: SqliteStore,
    private readonly bridge: RlmBridge,
    private readonly log: Logger,
    opts: RlmWatcherOptions = {},
  ) {
    this.root = opts.root ?? process.env.EIGHTS_RLM_ROOT ?? DEFAULT_ROOT;
    this.pollMs = opts.pollMs ?? 20000;
  }

  start(): void {
    if (this.running) return;
    if (!existsSync(this.root)) {
      this.log.info({ root: this.root }, "rlm-watcher: root not present — idle");
      return;
    }
    this.running = true;
    this.log.info({ root: this.root, pollMs: this.pollMs }, "rlm-watcher started");
    // D2c — first tick deferred by pollMs; see pp-watcher.start() comment.
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  async syncNow(): Promise<{ projects: number; events: number }> {
    return this.tick();
  }

  private getWatermark(project: string): number {
    const key = `rlm-watcher:${project}:offset`;
    const row = this.store.db.prepare("SELECT value FROM daemon_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }
  private setWatermark(project: string, offset: number): void {
    const key = `rlm-watcher:${project}:offset`;
    this.store.db.prepare(
      `INSERT INTO daemon_meta(key, value, updated_at) VALUES (?,?,datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(key, String(offset));
  }

  private discoverProjects(): string[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => /^RLM/.test(n));
  }

  private async tick(): Promise<{ projects: number; events: number }> {
    let projects = 0;
    let events = 0;
    try {
      for (const proj of this.discoverProjects()) {
        const eventsPath = join(this.root, proj, "RLM", "progress", "events.jsonl");
        if (!existsSync(eventsPath)) continue;
        projects += 1;
        const st = statSync(eventsPath);
        const offset = this.getWatermark(proj);
        if (st.size <= offset) continue;
        const chunk = readFileSync(eventsPath, "utf8").slice(offset);
        const lines = chunk.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          try {
            const evt = JSON.parse(line) as Record<string, unknown>;
            await this.bridge.ingestEvent(proj, evt);
            events += 1;
          } catch { /* malformed line — skip */ }
        }
        this.setWatermark(proj, st.size);
      }
      if (events) this.log.info({ projects, events }, "rlm-watcher: ingested events");
    } catch (err) {
      this.log.warn({ err: String(err) }, "rlm-watcher tick failed");
    }
    return { projects, events };
  }
}
