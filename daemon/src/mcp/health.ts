/**
 * Readiness probe (E2-4).
 *
 * The daemon brings the stdio transport up before the audit hash chain is
 * verified, and the gate is re-armed on every fresh stdio spawn. Without an
 * ungated probe the only way to discover the not-ready state is to call a
 * business tool and read its refusal, which is exactly the conflation E2-4
 * describes. `eights.health` is the one tool exempt from the gate: it reads
 * the gate and touches no audited state, so gateway health and `hydra doctor`
 * can see readiness directly.
 */
import { z } from "zod";
import type { ReadinessGate, ToolMap } from "./server.js";
import { DEFAULT_RETRY_AFTER_MS } from "./server.js";

const HealthArgs = z.object({}).passthrough();

export function registerHealthTools(ready: ReadinessGate): ToolMap {
  return {
    "eights.health": {
      description:
        "Ungated readiness probe. Returns { ready, status, audit_reason, verify_ms_so_far } " +
        "so a health/doctor probe can distinguish 'audit verification in progress' from a " +
        "broken chain without calling a gated tool.",
      schema: HealthArgs,
      ungated: true,
      handler: () => {
        const gate = ready();
        const status = gate.ok ? "ready" : gate.failed ? "failed" : "not_ready";
        return {
          ready: gate.ok,
          status,
          audit_reason: gate.reason ?? null,
          verify_ms_so_far: gate.verify_ms_so_far ?? null,
          ...(gate.ok || gate.failed
            ? {}
            : { retry_after_ms: gate.retry_after_ms ?? DEFAULT_RETRY_AFTER_MS }),
        };
      },
    },
  };
}
