/**
 * Per-tool deadline + latency telemetry in the MCP server seam. A tool that
 * runs past the deadline returns a typed `tool_deadline_exceeded` error (so an
 * opaque gateway 120s timeout becomes a fast, attributable daemon error), the
 * handler's abort signal fires, and a fast tool returns normally with a
 * `duration_ms` log line.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { createToolCallHandler, type ToolMap } from "../src/mcp/server.js";

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn() } as unknown as import("pino").Logger;
}

function parseBody(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

describe("MCP server per-tool deadline", () => {
  it("returns typed tool_deadline_exceeded and fires the abort signal", async () => {
    let captured: AbortSignal | undefined;
    const tools: ToolMap = {
      "slow.tool": {
        schema: z.object({}).passthrough(),
        handler: (_args, ctx) => {
          captured = ctx?.signal;
          return new Promise(() => { /* never resolves — ignores the signal */ });
        },
      },
    };
    const log = fakeLog();
    const onCall = createToolCallHandler(tools, { log, deadlineMs: 50, slowWarnMs: 10 });
    const res = await onCall({ params: { name: "slow.tool", arguments: {} } });

    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.error).toBe("tool_deadline_exceeded");
    expect(body.tool).toBe("slow.tool");
    expect(typeof body.elapsed_ms).toBe("number");
    expect(captured?.aborted).toBe(true);                 // signal threaded + fired
    expect((log.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalled(); // slow → warn
  });

  it("a fast tool returns normally and logs duration_ms", async () => {
    const tools: ToolMap = {
      "fast.tool": {
        schema: z.object({}).passthrough(),
        handler: () => ({ ok: true }),
      },
    };
    const log = fakeLog();
    const onCall = createToolCallHandler(tools, { log, deadlineMs: 5_000, slowWarnMs: 10_000 });
    const res = await onCall({ params: { name: "fast.tool", arguments: {} } });

    expect(res.isError).toBeUndefined();
    expect(parseBody(res)).toEqual({ ok: true });
    const infoMock = log.info as ReturnType<typeof vi.fn>;
    expect(infoMock).toHaveBeenCalled();
    const fields = infoMock.mock.calls[0][0] as { tool: string; duration_ms: number };
    expect(fields.tool).toBe("fast.tool");
    expect(typeof fields.duration_ms).toBe("number");
  });

  it("refuses an unknown tool", async () => {
    const onCall = createToolCallHandler({}, {});
    const res = await onCall({ params: { name: "nope", arguments: {} } });
    expect(res.isError).toBe(true);
    expect(parseBody(res).error).toContain("unknown tool");
  });

  // E2-4: the refusal is a structured operational status, not a bare error
  // string. Full coverage lives in readiness-gate.test.ts.
  it("refuses when the readiness gate is closed", async () => {
    const tools: ToolMap = { "x.y": { schema: z.object({}).passthrough(), handler: () => ({ ok: true }) } };
    const onCall = createToolCallHandler(tools, { ready: () => ({ ok: false, reason: "audit verification in progress" }) });
    const res = await onCall({ params: { name: "x.y", arguments: {} } });
    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.status).toBe("not_ready");
    expect(body.ready).toBe(false);
    expect(body.reason).toBe("audit verification in progress");
  });
});
