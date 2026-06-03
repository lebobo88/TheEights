/**
 * Xenia watcher — tails <XENIA_ROOT>/hearth/progress/events.jsonl.
 *
 * Single-project sibling of rlm-watcher with two hardening upgrades the
 * Xenia event contract requires:
 *   1. Partial-line safety: the watermark only advances past the last
 *      complete newline, so a mid-write line is re-read next tick instead
 *      of being half-ingested.
 *   2. Truncation/rotation recovery + event_id dedupe: if the file shrinks
 *      below the watermark, the offset resets to 0 and a persisted
 *      recently-seen event_id ring (daemon_meta) suppresses replays.
 */
import { existsSync, statSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { SqliteStore } from "../stores/sqlite.js";
import type { XeniaBridge } from "../adapters/xenia-bridge.js";

export interface XeniaWatcherOptions {
  root?: string;
  pollMs?: number;
}

const DEFAULT_ROOT = "C:/AiAppDeployments/Xenia";
const SEEN_CAP = 500;

export class XeniaWatcher {
  private timer: NodeJS.Timeout | null = null;
  private readonly root: string;
  private readonly pollMs: number;
  private running = false;

  constructor(
    private readonly store: SqliteStore,
    private readonly bridge: XeniaBridge,
    private readonly log: Logger,
    opts: XeniaWatcherOptions = {},
  ) {
    this.root = opts.root ?? process.env.EIGHTS_XENIA_ROOT ?? DEFAULT_ROOT;
    this.pollMs = opts.pollMs ?? 20000;
  }

  start(): void {
    if (this.running) return;
    if (!existsSync(this.root)) {
      this.log.info({ root: this.root }, "xenia-watcher: root not present — idle");
      return;
    }
    this.running = true;
    this.log.info({ root: this.root, pollMs: this.pollMs }, "xenia-watcher started");
    // First tick deferred by pollMs (same D2c rationale as pp-watcher).
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

  private metaGet(key: string): string | undefined {
    const row = this.store.db.prepare("SELECT value FROM daemon_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }
  private metaSet(key: string, value: string): void {
    this.store.db.prepare(
      `INSERT INTO daemon_meta(key, value, updated_at) VALUES (?,?,datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(key, value);
  }

  private getWatermark(): number {
    return Number(this.metaGet("xenia-watcher:xenia:offset") ?? 0);
  }
  private setWatermark(offset: number): void {
    this.metaSet("xenia-watcher:xenia:offset", String(offset));
  }

  private getSeen(): string[] {
    try {
      return JSON.parse(this.metaGet("xenia-watcher:xenia:seen") ?? "[]") as string[];
    } catch {
      return [];
    }
  }
  private setSeen(ids: string[]): void {
    this.metaSet("xenia-watcher:xenia:seen", JSON.stringify(ids.slice(-SEEN_CAP)));
  }

  private async tick(): Promise<{ projects: number; events: number }> {
    let events = 0;
    try {
      const eventsPath = join(this.root, "hearth", "progress", "events.jsonl");
      if (!existsSync(eventsPath)) return { projects: 0, events: 0 };

      const st = statSync(eventsPath);
      let offset = this.getWatermark();
      if (st.size < offset) {
        // Truncation / rotation: start over; the seen-ring suppresses replays.
        this.log.warn({ size: st.size, offset }, "xenia-watcher: events.jsonl shrank — resetting watermark");
        offset = 0;
      }
      if (st.size === offset) return { projects: 1, events: 0 };

      const chunk = this.readSlice(eventsPath, offset, st.size - offset);
      // Partial-line safety: only consume through the last complete newline.
      const lastNl = chunk.lastIndexOf("\n");
      if (lastNl < 0) return { projects: 1, events: 0 }; // a lone partial line — wait
      const complete = chunk.slice(0, lastNl + 1);
      const consumedBytes = Buffer.byteLength(complete, "utf8");

      const seen = this.getSeen();
      const seenSet = new Set(seen);
      for (const line of complete.split(/\r?\n/).filter(Boolean)) {
        try {
          const evt = JSON.parse(line) as Record<string, unknown>;
          const eid = String(evt.event_id ?? "");
          if (eid && seenSet.has(eid)) continue; // replay after truncation reset
          await this.bridge.ingestEvent("xenia", evt);
          events += 1;
          if (eid) {
            seen.push(eid);
            seenSet.add(eid);
          }
        } catch {
          /* malformed line — skip */
        }
      }
      this.setWatermark(offset + consumedBytes);
      this.setSeen(seen);
      if (events) this.log.info({ events }, "xenia-watcher: ingested events");
    } catch (err) {
      this.log.warn({ err: String(err) }, "xenia-watcher tick failed");
    }
    return { projects: 1, events };
  }

  /** Read `length` bytes at `position` without loading the whole file. */
  private readSlice(path: string, position: number, length: number): string {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(length);
      const read = readSync(fd, buf, 0, length, position);
      return buf.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  }
}
