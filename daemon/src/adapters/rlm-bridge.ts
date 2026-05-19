/**
 * rlm-bridge — RLM-CLI family adapter.
 *
 * Normalizes events.jsonl events into episodic memories under
 * `domain=<rlm-inferred-domain>` so the 14+ RLM siblings finally share recall.
 */
import type { MemoryEngine } from "../engines/memory.js";
import type { Envelope } from "../schemas/envelope.js";

export class RlmBridge {
  constructor(private readonly memory: MemoryEngine) {}

  async ingestEvent(project: string, evt: Record<string, unknown>): Promise<void> {
    const kind = String(evt.kind ?? "rlm.event");
    const phase = typeof evt.phase === "number" ? evt.phase : undefined;
    const ts = typeof evt.ts === "string" ? evt.ts : new Date().toISOString();
    const domain = inferDomain(project);
    const env: Envelope = {
      tenant_id: "local",
      actor_id: "rlm-watcher",
      project_id: project,
      domain,
      scope: [`project:${project}`, `domain:${domain}`, `phase:${phase ?? "?"}`, `kind:${kind}`],
      trace_id: `rlm_${project}_${ts}`,
    };
    await this.memory.add(env, {
      type: "episodic",
      content: JSON.stringify(evt, null, 2),
      summary: `[${project} P${phase ?? "?"}] ${kind}`,
      scopes: env.scope,
      provenance: { actor: "rlm-bridge", source_uri: `rlm://${project}` },
      confidence: 0.7,
    });
  }
}

function inferDomain(project: string): string {
  if (project === "RLM-CLI-Starter") return "rlm.meta";
  const m = project.match(/^RLM(.+)$/);
  if (!m || !m[1]) return "rlm.unknown";
  return "rlm." + m[1].toLowerCase();
}
