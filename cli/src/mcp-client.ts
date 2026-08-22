/**
 * Tiny stdio MCP client for the `eights` CLI.
 *
 * Spawns the daemon as a child and shuttles JSON-RPC messages. Same wire shape
 * as the Hydra Python helper, just in TS.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Writable, Readable } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

// Resolve the daemon relative to this module, not the caller's cwd. The compiled
// file lives at <repo>/cli/dist/mcp-client.js, so the daemon is two levels up.
const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULT_DAEMON = process.env.EIGHTS_DAEMON_JS
  ?? join(HERE, "..", "..", "daemon", "dist", "index.js");

const FALLBACKS = [
  join(HERE, "..", "..", "daemon", "dist", "index.js"),
];

export class EightsClient {
  private proc: (ChildProcess & { stdin: Writable; stdout: Readable }) | null = null;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  static daemonPath(): string {
    if (existsSync(DEFAULT_DAEMON)) return DEFAULT_DAEMON;
    for (const p of FALLBACKS) if (existsSync(p)) return p;
    return DEFAULT_DAEMON;
  }

  async connect(daemonPath: string = EightsClient.daemonPath()): Promise<void> {
    if (!existsSync(daemonPath)) {
      throw new Error(`eights-daemon not found at ${daemonPath}. Build it first: cd daemon && npm run build`);
    }
    const p = spawn("node", [daemonPath], { stdio: ["pipe", "pipe", "inherit"] });
    if (!p.stdin || !p.stdout) throw new Error("failed to attach stdio to eights-daemon");
    this.proc = p as ChildProcess & { stdin: Writable; stdout: Readable };
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onChunk(chunk));
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "eights-cli", version: "0.2.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.send("tools/call", { name: tool, arguments: stripNulls(args) }) as {
      content?: Array<{ text?: string }>;
      isError?: boolean;
    };
    const text = result.content?.[0]?.text ?? "{}";
    const parsed = JSON.parse(text);
    if (result.isError) {
      throw new Error(typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed));
    }
    return parsed as T;
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    this.proc.stdin.end();
    this.proc.kill();
    this.proc = null;
  }

  private send(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.proc) throw new Error("client not connected");
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.proc) return;
    const payload = { jsonrpc: "2.0", method, params };
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const handler = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) handler.reject(new Error(msg.error.message));
          else handler.resolve(msg.result);
        }
      } catch { /* not JSON — skip */ }
    }
  }
}

function stripNulls(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      out[k] = stripNulls(v);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(stripNulls);
  return value;
}

export function defaultEnvelope(actor = "eights-cli", project = "TheEights", domain = "infra"): Record<string, unknown> {
  return {
    tenant_id: "local",
    actor_id: actor,
    project_id: project,
    domain,
    scope: [],
    trace_id: `cli_${Date.now()}`,
  };
}
