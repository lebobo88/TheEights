/**
 * Tiny stdio MCP client for the read-only Atlas bridge.
 *
 * This is a faithful copy of `cli/src/mcp-client.ts` (the EightsClient the CLI
 * talks through), kept self-contained so `web/` is a standalone consumer-style
 * package with no cross-package build dependency. It spawns the daemon as a
 * child and shuttles JSON-RPC over stdio — exactly the existing MCP boundary.
 * The Atlas bridge is therefore JUST ANOTHER MCP CLIENT, like the CLI.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { Writable, Readable } from "node:stream";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const DEFAULT_DAEMON =
  process.env.EIGHTS_DAEMON_JS ??
  join(process.cwd(), "..", "daemon", "dist", "index.js");

/**
 * Anchor-relative daemon path: walk up from this module (web/server) to the
 * repo root (dir holding a daemon/dist/index.js), then return it. Removes the
 * machine-specific hardcoded fallback.
 */
function repoDaemonFallback(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "daemon", "dist", "index.js"))) {
      return join(dir, "daemon", "dist", "index.js").replace(/\\/g, "/");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const FALLBACKS = [
  join(homedir(), "..", "..", "AiAppDeployments", "TheEights", "daemon", "dist", "index.js"),
  repoDaemonFallback(),
].filter((p): p is string => Boolean(p));

export class EightsClient {
  private proc: (ChildProcess & { stdin: Writable; stdout: Readable }) | null = null;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  static daemonPath(): string {
    if (existsSync(DEFAULT_DAEMON)) return DEFAULT_DAEMON;
    for (const p of FALLBACKS) if (existsSync(p)) return p;
    return DEFAULT_DAEMON;
  }

  async connect(daemonPath: string = EightsClient.daemonPath()): Promise<void> {
    if (!existsSync(daemonPath)) {
      throw new Error(
        `eights-daemon not found at ${daemonPath}. Build it first: cd daemon && npm run build`,
      );
    }
    // Spawn a READ-PATH daemon instance for this bridge. We use the daemon's
    // OWN existing config escape hatches (no daemon/src change) to make it a
    // clean reader that does not fight itself on the single sqlite connection:
    //   - EIGHTS_DISABLE_WATCHERS=1 : skip pp/exec/rlm watchers + scheduled jobs
    //     (their periodic synchronous queries otherwise collide with tool-call
    //     reads on the shared better-sqlite3 connection → "database connection
    //     is busy executing a query").
    //   - EIGHTS_SKIP_AUDIT_CHECK=1 : skip the boot full-chain verify so reads
    //     are not blocked behind a 658k-event walk. The on-demand audit.verify
    //     tool still runs the chain check when /api/chain/status asks for it.
    // These are operator-style toggles the daemon already exposes; the bridge
    // is read-only/loopback regardless, so disabling write-side jobs is correct.
    const p = spawn("node", [daemonPath], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        EIGHTS_DISABLE_WATCHERS: "1",
        EIGHTS_SKIP_AUDIT_CHECK: "1",
      },
    });
    if (!p.stdin || !p.stdout) throw new Error("failed to attach stdio to eights-daemon");
    this.proc = p as ChildProcess & { stdin: Writable; stdout: Readable };
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onChunk(chunk));
    this.proc.on("exit", () => {
      this.proc = null;
      for (const { reject } of this.pending.values()) reject(new Error("daemon exited"));
      this.pending.clear();
    });
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "eights-atlas", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  get connected(): boolean {
    return this.proc !== null;
  }

  async call<T = unknown>(tool: string, args: Record<string, unknown>): Promise<T> {
    const result = (await this.send("tools/call", {
      name: tool,
      arguments: stripNulls(args),
    })) as { content?: Array<{ text?: string }>; isError?: boolean };
    const text = result.content?.[0]?.text ?? "{}";
    const parsed = JSON.parse(text);
    if (result.isError) {
      throw new Error(
        typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed),
      );
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
    if (!this.proc) return Promise.reject(new Error("client not connected"));
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
        const msg = JSON.parse(line) as {
          id?: number;
          result?: unknown;
          error?: { message: string };
        };
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const handler = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) handler.reject(new Error(msg.error.message));
          else handler.resolve(msg.result);
        }
      } catch {
        /* not JSON — skip */
      }
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

/**
 * The FIXED read-only Envelope for the Atlas bridge.
 *
 * Invariant #1 (no broadening of tenant/scope access): this envelope is
 * hard-coded — actor "eights-atlas", project "TheEights", domain "infra",
 * EMPTY scope. No request path can widen it.
 */
export function atlasEnvelope(): {
  tenant_id: string;
  actor_id: string;
  project_id: string;
  domain: string;
  scope: string[];
  trace_id: string;
} {
  return {
    tenant_id: "local",
    actor_id: "eights-atlas",
    project_id: "TheEights",
    domain: "infra",
    scope: [],
    trace_id: `atlas_${Date.now()}`,
  };
}
