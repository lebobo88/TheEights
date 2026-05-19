/**
 * ExecutiveSuite watcher.
 *
 * Tails `<project>/output/<domain>/*.md` for new decision memos / board minutes
 * / M&A dossiers / crisis logs and ingests them as episodic memories with
 * structured Decision/Assumption/Dissent/Outcome scopes.
 *
 * No file-system watcher dep — polls directory listings (Windows-friendly).
 */
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { SqliteStore } from "../stores/sqlite.js";
import type { ExecSuiteBridge } from "../adapters/execsuite-bridge.js";

export interface ExecSuiteWatcherOptions {
  outputRoot?: string;
  pollMs?: number;
}

const DEFAULT_OUTPUT_ROOT = "C:/AiAppDeployments/ExecutiveSuite/output";

export class ExecSuiteWatcher {
  private timer: NodeJS.Timeout | null = null;
  private readonly outputRoot: string;
  private readonly pollMs: number;
  private running = false;

  constructor(
    private readonly store: SqliteStore,
    private readonly bridge: ExecSuiteBridge,
    private readonly log: Logger,
    opts: ExecSuiteWatcherOptions = {},
  ) {
    this.outputRoot = opts.outputRoot ?? process.env.EIGHTS_EXEC_OUTPUT_ROOT ?? DEFAULT_OUTPUT_ROOT;
    this.pollMs = opts.pollMs ?? 15000;
  }

  start(): void {
    if (this.running) return;
    if (!existsSync(this.outputRoot)) {
      this.log.info({ outputRoot: this.outputRoot }, "execsuite-watcher: output root not present — idle");
      return;
    }
    this.running = true;
    this.log.info({ outputRoot: this.outputRoot, pollMs: this.pollMs }, "execsuite-watcher started");
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  async syncNow(): Promise<{ files: number }> {
    return this.tick();
  }

  private getWatermark(): number {
    const row = this.store.db.prepare("SELECT value FROM daemon_meta WHERE key = ?").get("exec-watcher:mtime") as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  private setWatermark(mtime: number): void {
    this.store.db.prepare(
      `INSERT INTO daemon_meta(key, value, updated_at) VALUES (?,?,datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run("exec-watcher:mtime", String(mtime));
  }

  private async tick(): Promise<{ files: number }> {
    if (!existsSync(this.outputRoot)) return { files: 0 };
    const watermark = this.getWatermark();
    let highWater = watermark;
    let processed = 0;
    try {
      const domains = readdirSync(this.outputRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const domain of domains) {
        const domainDir = join(this.outputRoot, domain);
        const entries = readdirSync(domainDir, { withFileTypes: true })
          .filter((e) => e.isFile() && e.name.endsWith(".md"));
        for (const f of entries) {
          const full = join(domainDir, f.name);
          const st = statSync(full);
          if (st.mtimeMs <= watermark) continue;
          const body = readFileSync(full, "utf8");
          await this.bridge.ingestMemo({ domain, path: full, filename: f.name, body });
          if (st.mtimeMs > highWater) highWater = st.mtimeMs;
          processed += 1;
        }
      }
      if (highWater > watermark) this.setWatermark(highWater);
      if (processed) this.log.info({ processed, highWater }, "execsuite-watcher: ingested memos");
    } catch (err) {
      this.log.warn({ err: String(err) }, "execsuite-watcher tick failed");
    }
    return { files: processed };
  }
}
