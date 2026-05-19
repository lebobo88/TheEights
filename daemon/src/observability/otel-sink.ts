/**
 * Optional OTEL exporter for audit events. Off by default. Hard-gated to a
 * localhost endpoint to preserve AGENTS.md hard rule #5 (no outbound HTTP).
 *
 * Enable via `~/.eights/config.yaml`:
 *   otel:
 *     enabled: true
 *     endpoint: http://localhost:4318/v1/traces   # MUST be localhost / 127.* / ::1
 *     service_name: eights-daemon
 *
 * Anything other than localhost is refused at startup with a hard error.
 */
import type { AuditEngine } from "../engines/audit.js";
import type { Logger } from "pino";

export interface OtelSinkConfig {
  enabled: boolean;
  endpoint: string;
  service_name: string;
}

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class OtelSink {
  private flushTimer: NodeJS.Timeout | null = null;
  private queue: Array<{ ts: string; kind: string; envelope: unknown; payload: unknown; trace_id?: string }> = [];

  constructor(
    private readonly cfg: OtelSinkConfig,
    private readonly log: Logger,
  ) {
    if (cfg.enabled) this.validateEndpoint(cfg.endpoint);
  }

  private validateEndpoint(endpoint: string): void {
    let url: URL;
    try { url = new URL(endpoint); }
    catch { throw new Error(`otel-sink: invalid endpoint URL: ${endpoint}`); }
    if (!LOCALHOST_HOSTS.has(url.hostname)) {
      throw new Error(`otel-sink: endpoint must be localhost (got ${url.hostname}) — AGENTS.md hard rule #5 forbids outbound HTTP`);
    }
  }

  attach(audit: AuditEngine): void {
    if (!this.cfg.enabled) return;
    const originalRecord = audit.record.bind(audit);
    audit.record = (kind: string, envelope: unknown, payload: unknown) => {
      const r = originalRecord(kind, envelope as Parameters<AuditEngine["record"]>[1], payload);
      try {
        this.queue.push({ ts: new Date().toISOString(), kind, envelope, payload, trace_id: (envelope as { trace_id?: string }).trace_id });
        if (this.queue.length >= 64) void this.flush();
      } catch { /* never let telemetry break the daemon */ }
      return r;
    };
    this.flushTimer = setInterval(() => { void this.flush(); }, 5_000);
    this.log.info({ endpoint: this.cfg.endpoint }, "otel-sink attached");
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const body = {
      resourceSpans: [{
        resource: { attributes: [{ key: "service.name", value: { stringValue: this.cfg.service_name } }] },
        scopeSpans: [{
          scope: { name: "eights-daemon" },
          spans: batch.map((e) => ({
            traceId: hexTrace(e.trace_id ?? "no-trace"),
            spanId: hexSpan(e.kind + e.ts),
            name: e.kind,
            startTimeUnixNano: Date.parse(e.ts) * 1_000_000,
            endTimeUnixNano: Date.parse(e.ts) * 1_000_000 + 1_000_000,
            attributes: [
              { key: "eights.kind", value: { stringValue: e.kind } },
              { key: "eights.envelope", value: { stringValue: safeStr(e.envelope) } },
              { key: "eights.payload", value: { stringValue: safeStr(e.payload) } },
            ],
          })),
        }],
      }],
    };
    try {
      await fetch(this.cfg.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.log.warn({ err: String(err), batched: batch.length }, "otel flush failed");
    }
  }

  stop(): void {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    void this.flush();
  }
}

function safeStr(v: unknown): string { try { return JSON.stringify(v).slice(0, 4000); } catch { return String(v).slice(0, 4000); } }
function hexTrace(s: string): string { return Buffer.from(s.repeat(4)).toString("hex").slice(0, 32); }
function hexSpan(s: string): string { return Buffer.from(s.repeat(2)).toString("hex").slice(0, 16); }
