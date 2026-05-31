import type { AuditEngine } from "../engines/audit.js";
import type { Logger } from "pino";

/**
 * Mutable readiness gate shared with the MCP server's fail-closed tool guard
 * (see mcp/server.ts `ReadinessGate`). The daemon brings the transport up
 * before the audit chain is verified; `pass()`/`fail()` flip whether tool
 * calls are allowed once verification resolves.
 */
export interface AuditGate {
  pass(): void;
  fail(reason: string): void;
}

/**
 * AuditVerifierJob — periodic FULL re-verification of the audit hash chain.
 *
 * Boot only verifies the tail past the persisted checkpoint (fast). Historical
 * tamper of already-checkpointed rows is caught here, off the critical path.
 * On failure it flips the gate fail-closed so every audited tool is refused —
 * the audit engine is never disabled or muted (AGENTS.md hard rule #1).
 * `EIGHTS_SKIP_AUDIT_CHECK=1` is the documented operator override.
 *
 * Triad: start() / stop() / runOnce(). Never blocks daemon shutdown.
 */
export class AuditVerifierJob {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly audit: AuditEngine,
    private readonly gate: AuditGate,
    private readonly log: Logger,
    private readonly intervalMs = 24 * 60 * 60 * 1000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.log.info({ intervalMs: this.intervalMs }, "audit-verifier scheduled");
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    const skip = process.env.EIGHTS_SKIP_AUDIT_CHECK === "1";
    try {
      const result = await this.audit.verifyChain({ full: true });
      if (result.ok) {
        this.gate.pass();
        this.log.info("audit chain verified (full)");
      } else if (skip) {
        this.gate.pass();
        this.log.warn(
          { broken_at: result.broken_at },
          "audit chain broken — continuing per EIGHTS_SKIP_AUDIT_CHECK=1",
        );
      } else {
        this.gate.fail(`AUDIT CHAIN BROKEN at ${result.broken_at}`);
        this.log.error({ broken_at: result.broken_at }, "audit chain broken — tools fail-closed");
      }
    } catch (err) {
      this.log.error({ err: String(err) }, "audit-verifier run failed");
    }
  }
}
