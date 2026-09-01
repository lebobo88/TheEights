/**
 * E2-4 — readiness gate shape.
 *
 * A gated tool called while the audit chain is still being verified must refuse
 * with a structured, machine-checkable `not_ready` (plus a retry hint), not a
 * bare error string that a caller can mistake for a successful result. A gate
 * that FAILED verification is terminal and refuses with a distinct `failed`.
 * `eights.health` is exempt from the gate so a health probe can read readiness
 * without calling a business tool.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  createToolCallHandler,
  readinessRefusal,
  type ReadinessState,
  type ToolMap,
} from "../src/mcp/server.js";
import { registerHealthTools } from "../src/mcp/health.js";

function parseBody(res: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

function gatedTools(): ToolMap {
  return {
    "eights.governance.hitl.list": {
      schema: z.object({}).passthrough(),
      handler: () => ({ requests: [], count: 0 }),
    },
  };
}

describe("readiness gate refusal shape", () => {
  it("refuses a gated tool with not_ready + retry hint while verification is pending", async () => {
    const state: ReadinessState = {
      ok: false,
      reason: "audit verification in progress",
      failed: false,
      verify_ms_so_far: 1234,
    };
    const onCall = createToolCallHandler(gatedTools(), { ready: () => state });

    const res = await onCall({ params: { name: "eights.governance.hitl.list", arguments: {} } });

    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.status).toBe("not_ready");
    expect(body.ready).toBe(false);
    expect(body.reason).toBe("audit verification in progress");
    expect(body.retry_after_ms).toBe(2000);
    expect(body.verify_ms_so_far).toBe(1234);
    // The old shape leaked a bare error string that read as data.
    expect(body.error).toBeUndefined();
  });

  it("refuses with a distinct failed status when the chain is broken", async () => {
    const state: ReadinessState = {
      ok: false,
      reason: "AUDIT CHAIN BROKEN at 4711",
      failed: true,
    };
    const onCall = createToolCallHandler(gatedTools(), { ready: () => state });

    const res = await onCall({ params: { name: "eights.governance.hitl.list", arguments: {} } });

    expect(res.isError).toBe(true);
    const body = parseBody(res);
    expect(body.status).toBe("failed");
    expect(body.ready).toBe(false);
    expect(body.error).toBe("audit verification failed: AUDIT CHAIN BROKEN at 4711");
    expect(body.retry_after_ms).toBeUndefined();
  });

  it("the same gated call succeeds once the gate passes", async () => {
    let ready = false;
    const onCall = createToolCallHandler(gatedTools(), {
      ready: () => ({ ok: ready, reason: ready ? undefined : "audit verification in progress" }),
    });
    const req = { params: { name: "eights.governance.hitl.list", arguments: {} } };

    expect(parseBody(await onCall(req)).status).toBe("not_ready");

    ready = true;  // auditGate.pass()
    const res = await onCall(req);
    expect(res.isError).toBeUndefined();
    expect(parseBody(res)).toEqual({ requests: [], count: 0 });
  });

  it("honors an explicit retry_after_ms hint from the gate", () => {
    const body = readinessRefusal({ ok: false, reason: "still verifying", retry_after_ms: 500 });
    expect(body).toEqual({
      status: "not_ready",
      ready: false,
      reason: "still verifying",
      retry_after_ms: 500,
    });
  });

  it("logs the refusal so an operator can attribute a stalled caller", async () => {
    const log = { info: vi.fn(), warn: vi.fn() } as unknown as import("pino").Logger;
    const onCall = createToolCallHandler(gatedTools(), {
      ready: () => ({ ok: false, reason: "audit verification in progress" }),
      log,
    });
    await onCall({ params: { name: "eights.governance.hitl.list", arguments: {} } });
    expect((log.info as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "eights.governance.hitl.list", status: "not_ready" }),
      expect.any(String),
    );
  });
});

describe("eights.health", () => {
  function handlerFor(gate: () => ReadinessState) {
    const tools = { ...gatedTools(), ...registerHealthTools(gate) };
    return createToolCallHandler(tools, { ready: gate });
  }

  it("answers while the gate is closed (ungated) and reports pending state", async () => {
    const onCall = handlerFor(() => ({
      ok: false,
      reason: "audit verification in progress",
      failed: false,
      verify_ms_so_far: 900,
    }));

    const res = await onCall({ params: { name: "eights.health", arguments: {} } });

    expect(res.isError).toBeUndefined();
    expect(parseBody(res)).toEqual({
      ready: false,
      status: "not_ready",
      audit_reason: "audit verification in progress",
      verify_ms_so_far: 900,
      retry_after_ms: 2000,
    });
  });

  it("reports ready once the gate passes", async () => {
    const onCall = handlerFor(() => ({ ok: true }));

    const res = await onCall({ params: { name: "eights.health", arguments: {} } });

    expect(res.isError).toBeUndefined();
    expect(parseBody(res)).toEqual({
      ready: true,
      status: "ready",
      audit_reason: null,
      verify_ms_so_far: null,
    });
  });

  it("reports a broken chain as failed", async () => {
    const onCall = handlerFor(() => ({ ok: false, failed: true, reason: "AUDIT CHAIN BROKEN at 9" }));

    const body = parseBody(await onCall({ params: { name: "eights.health", arguments: {} } }));
    expect(body.status).toBe("failed");
    expect(body.ready).toBe(false);
    expect(body.audit_reason).toBe("AUDIT CHAIN BROKEN at 9");
  });
});
