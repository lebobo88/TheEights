/**
 * pp-bridge — pair-programmer adapter.
 *
 * Translates pair-programmer daemon events into eights memory operations.
 * Phase 1.5 wires this against a non-invasive PpWatcher (see engines/pp-watcher.ts).
 */
import type { MemoryEngine } from "../engines/memory.js";
import type { Envelope } from "../schemas/envelope.js";

export interface PpFinalizeRunEvent {
  kind: "pp.finalize_run";
  run_id: string;
  project_id: string;
  taxonomy_mapping: Record<string, unknown>;
  verdict_summary: { passed: number; failed: number; surfaced: number };
  missability: Array<{ check_id: string; status: "passed" | "failed" }>;
  artifacts: Array<{ path: string; sha256: string; kind: string; taxonomy_section: string }>;
}

export interface PpRecordVerdictEvent {
  kind: "pp.record_verdict";
  run_id: string;
  /** pp verdicts.id — the stable per-verdict idempotency anchor. */
  verdict_id: string;
  stage_kind: string;
  rubric_id: string;
  outcome: "passed" | "failed" | "surfaced";
  score: number;
  critique_md: string;
}

export type PpEvent = PpFinalizeRunEvent | PpRecordVerdictEvent;

export class PpBridge {
  constructor(private readonly memory: MemoryEngine) {}

  async ingest(env: Envelope, event: PpEvent): Promise<void> {
    switch (event.kind) {
      case "pp.finalize_run": {
        const missFailed = event.missability.filter((m) => m.status === "failed").length;
        const summary = `pair-programmer run ${event.run_id} (${event.project_id}) ${event.verdict_summary.passed}P/${event.verdict_summary.failed}F/${event.verdict_summary.surfaced}S; missability ${missFailed} failed; artifacts ${event.artifacts.length}`;
        await this.memory.add(env, {
          type: "episodic",
          content: `pair-programmer run ${event.run_id} finalized.\n\nVerdict summary: ${JSON.stringify(event.verdict_summary)}\nMissability failures: ${missFailed}\nTaxonomy mapping: ${JSON.stringify(event.taxonomy_mapping).slice(0, 500)}`,
          summary,
          scopes: [`project:${event.project_id}`, "domain:code", `run:${event.run_id}`],
          provenance: { run_id: event.run_id, actor: "pp-bridge", source_uri: "pp://daemon" },
          confidence: 0.9,
          idempotency_key: `pp:run:${event.run_id}`,
        });
        break;
      }
      case "pp.record_verdict":
        await this.memory.add(env, {
          type: "episodic",
          content: `verdict on ${event.stage_kind}/${event.rubric_id}: ${event.outcome} (score ${event.score})\n\n${event.critique_md}`,
          summary: `${event.stage_kind}/${event.rubric_id} → ${event.outcome}`,
          scopes: [`run:${event.run_id}`, `rubric:${event.rubric_id}`, `stage:${event.stage_kind}`, "domain:code"],
          provenance: { run_id: event.run_id, actor: "pp-bridge" },
          confidence: 0.8,
          idempotency_key: `pp:verdict:${event.verdict_id}`,
        });
        break;
    }
  }
}
