/**
 * MCP stdio server wiring.
 *
 * The @modelcontextprotocol/sdk shape changes between minor versions; this file
 * is the single seam that owns that coupling. Engines, schemas, and tools
 * elsewhere are SDK-agnostic.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ZodTypeAny } from "zod";
import type { Logger } from "pino";
import { performance } from "node:perf_hooks";
import { zodToJsonSchema } from "./zod-to-json.js";

/**
 * Per-call context handed to a tool handler. `signal` aborts when the per-tool
 * deadline elapses; cancellable handlers (those that forward into a cloud
 * completion) thread it down so the in-flight fetch is cancelled. Handlers that
 * do only synchronous work simply ignore it.
 */
export interface ToolCtx {
  signal: AbortSignal;
  deadlineMs: number;
}

export interface ToolDef<T extends ZodTypeAny = ZodTypeAny> {
  schema: T;
  handler: (args: ReturnType<T["parse"]>, ctx?: ToolCtx) => unknown | Promise<unknown>;
  description?: string;
  /**
   * Exempt from the fail-closed readiness gate (E2-4). Only tools that touch
   * NO audited state may set this — today that is `eights.health`, which reads
   * the gate itself so a gateway health probe can see the not-ready state
   * instead of inferring it from a refused business call.
   */
  ungated?: boolean;
}

export type ToolMap = Record<string, ToolDef>;

/** Best-effort extraction of a trace id from a tool's envelope, for log correlation. */
function traceIdOf(args: unknown): string | undefined {
  if (args && typeof args === "object") {
    const env = (args as { envelope?: unknown }).envelope;
    if (env && typeof env === "object") {
      const tid = (env as { trace_id?: unknown }).trace_id;
      if (typeof tid === "string") return tid;
    }
  }
  return undefined;
}

/**
 * Fail-closed readiness gate. The daemon brings the stdio transport up before
 * the audit chain has been verified (so the MCP handshake completes fast and
 * the Hydra gateway doesn't time out connecting). Until `ready()` returns
 * `{ ok: true }`, every tool call is refused. No audited read/write ever runs
 * on an unverified chain — only the protocol handshake completes first, which
 * keeps AGENTS.md hard rule #1 intact.
 */
export interface ReadinessState {
  ok: boolean;
  /** Human-readable reason the gate is closed. Undefined once `ok` is true. */
  reason?: string;
  /**
   * `true` when verification ran and FAILED (broken hash chain, bootstrap
   * error) rather than still being in flight. A failed gate is terminal for
   * this process — retrying will not help — so it refuses with a distinct
   * `status: "failed"` instead of `not_ready`.
   */
  failed?: boolean;
  /** Milliseconds elapsed since verification started. */
  verify_ms_so_far?: number;
  /** Hint for how long a caller should wait before retrying a pending gate. */
  retry_after_ms?: number;
}

export type ReadinessGate = () => ReadinessState;

/** Default retry hint handed to callers while verification is still running. */
export const DEFAULT_RETRY_AFTER_MS = 2_000;

/**
 * Build the refusal body for a closed readiness gate.
 *
 * Deliberately NOT `{ error: "<string>" }`: a bare error string inside an
 * otherwise successful-looking envelope reads as data to callers that only
 * inspect the outer status (E2-4). A pending gate is an operational state, not
 * a result, so it carries a machine-checkable `status` plus a retry hint.
 */
export function readinessRefusal(gate: ReadinessState): Record<string, unknown> {
  if (gate.failed) {
    return {
      status: "failed",
      ready: false,
      error: `audit verification failed: ${gate.reason ?? "unknown reason"}`,
    };
  }
  return {
    status: "not_ready",
    ready: false,
    reason: gate.reason ?? "audit verification in progress",
    retry_after_ms: gate.retry_after_ms ?? DEFAULT_RETRY_AFTER_MS,
    ...(gate.verify_ms_so_far === undefined ? {} : { verify_ms_so_far: gate.verify_ms_so_far }),
  };
}

/** Result envelope returned to the MCP transport for a tool call. */
export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolCallOpts {
  ready?: ReadinessGate;
  log?: Logger;
  /** Per-tool wall-clock deadline. Fires before the gateway's ~120s. */
  deadlineMs?: number;
  /** Above this duration a COMPLETED call logs at warn. */
  slowWarnMs?: number;
}

/**
 * Build the CallTool handler. Extracted from `startMcpServer` so the deadline +
 * telemetry behavior is unit-testable without a live stdio transport.
 *
 * The AbortController fires at `deadlineMs`; cancellable handlers (those that
 * forward into a cloud completion) thread `ctx.signal` down so the in-flight
 * fetch is cancelled. Purely synchronous handlers can't be interrupted mid-loop
 * — the race only resolves once they yield — so heavy sync scans are chunked
 * elsewhere (drift pagination) to give the deadline a chance to win.
 * `clearTimeout` in `finally` so a completed call's signal never fires late.
 */
export function createToolCallHandler(
  tools: ToolMap,
  opts: ToolCallOpts = {},
): (req: { params: { name: string; arguments?: unknown } }) => Promise<ToolCallResult> {
  const deadlineMs = opts.deadlineMs ?? 90_000;
  const slowWarnMs = opts.slowWarnMs ?? 2_000;
  const log = opts.log;

  return async (req) => {
    const name = req.params.name;
    const def = tools[name];
    if (!def) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `unknown tool: ${name}` }) }],
        isError: true,
      };
    }
    if (opts.ready && !def.ungated) {
      const gate = opts.ready();
      if (!gate.ok) {
        const body = readinessRefusal(gate);
        log?.info({ tool: name, status: body.status }, "mcp tool refused — readiness gate closed");
        return {
          content: [{ type: "text", text: JSON.stringify(body) }],
          isError: true,
        };
      }
    }

    const start = performance.now();
    const trace_id = traceIdOf(req.params.arguments);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), deadlineMs);
    timer.unref?.();
    let isError = false;
    try {
      const parsed = def.schema.parse(req.params.arguments ?? {});
      const handlerResult = Promise.resolve(def.handler(parsed, { signal: ac.signal, deadlineMs }));
      const deadline = new Promise<never>((_, reject) => {
        const onAbort = (): void => reject(new Error("tool_deadline_exceeded"));
        if (ac.signal.aborted) onAbort();
        else ac.signal.addEventListener("abort", onAbort, { once: true });
      });
      const result = await Promise.race([handlerResult, deadline]);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (err) {
      isError = true;
      if (ac.signal.aborted) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error: "tool_deadline_exceeded",
            tool: name,
            deadline_ms: deadlineMs,
            elapsed_ms: Math.round(performance.now() - start),
          }) }],
          isError: true,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    } finally {
      clearTimeout(timer);
      const duration_ms = Math.round(performance.now() - start);
      if (log) {
        const fields = { tool: name, trace_id, duration_ms, isError };
        if (duration_ms > slowWarnMs) log.warn(fields, "mcp tool slow");
        else log.info(fields, "mcp tool call");
      }
    }
  };
}

export async function startMcpServer(
  tools: ToolMap,
  opts: {
    name: string;
    version: string;
    ready?: ReadinessGate;
    log?: Logger;
    /** Per-tool wall-clock deadline. Fires before the gateway's ~120s so an
     * opaque gateway timeout becomes a fast, attributable daemon error. */
    deadlineMs?: number;
    /** Above this duration a COMPLETED call logs at warn (slow-call telemetry). */
    slowWarnMs?: number;
  },
): Promise<void> {
  const server = new Server(
    { name: opts.name, version: opts.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools).map(([name, def]) => ({
      name,
      description: def.description ?? "",
      inputSchema: zodToJsonSchema(def.schema),
    })),
  }));

  const onCall = createToolCallHandler(tools, {
    ready: opts.ready,
    log: opts.log,
    deadlineMs: opts.deadlineMs,
    slowWarnMs: opts.slowWarnMs,
  });
  // Re-emit as a fresh object literal so it matches the SDK's CallToolResult
  // union member (a named interface flowing through trips union resolution).
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const r = await onCall(req);
    return r.isError ? { content: r.content, isError: true } : { content: r.content };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
