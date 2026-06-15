/**
 * Cross-project pattern miner with Phase 5 pattern→proposal pipeline.
 *
 * Surfaces patterns as semantic memories (existing behavior), then attempts
 * to translate each pattern into an evolution proposal against any
 * non-frozen resource whose scopes overlap the pattern's scopes. The
 * proposal flows through the normal evaluate → commit | HITL path.
 */
import type { Logger } from "pino";
import type { SqliteStore } from "../stores/sqlite.js";
import type { MemoryEngine } from "./memory.js";
import type { AuditEngine } from "./audit.js";
import type { EvolutionEngine } from "./evolution.js";
import type { Completer } from "./eval/completer.js";
import type { CompletionBudget } from "../completer.js";
import type { Envelope } from "../schemas/envelope.js";
import type { Resource } from "../schemas/resource.js";

export class Miner {
  private timer: NodeJS.Timeout | null = null;
  private readonly pollMs: number;
  private readonly budget?: CompletionBudget;

  constructor(
    private readonly sql: SqliteStore,
    private readonly memory: MemoryEngine,
    private readonly audit: AuditEngine,
    private readonly log: Logger,
    private readonly evolution?: EvolutionEngine,
    private readonly llm?: Completer,
    opts: { pollMs?: number; budget?: CompletionBudget } = {},
  ) {
    this.pollMs = opts.pollMs ?? 3600_000;
    this.budget = opts.budget;
  }

  startScheduled(): void {
    this.log.info({ pollMs: this.pollMs }, "miner scheduled");
    this.timer = setInterval(() => void this.runOnce(), this.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<{ patterns_surfaced: number; proposals_drafted: number }> {
    const env: Envelope = {
      tenant_id: "local", actor_id: "miner",
      project_id: "TheEights", domain: "infra",
      scope: ["type:Pattern"], trace_id: `miner_${Date.now()}`,
    };
    let surfaced = 0;
    let drafted = 0;
    try {
      const a = await this.mineRecurringRubricFailures(env);
      const b = await this.mineMissabilityFailures(env);
      surfaced = a.surfaced + b.surfaced;
      drafted = a.drafted + b.drafted;
    } catch (err) {
      this.log.warn({ err: String(err) }, "miner: runOnce failed");
    }
    this.audit.record("miner.run", env, { patterns_surfaced: surfaced, proposals_drafted: drafted });
    return { patterns_surfaced: surfaced, proposals_drafted: drafted };
  }

  private async mineRecurringRubricFailures(env: Envelope): Promise<{ surfaced: number; drafted: number }> {
    const rows = this.sql.db.prepare(`
      SELECT json_extract(scopes_json, '$') as scopes, COUNT(*) as n
      FROM memories
      WHERE type = 'episodic' AND domain = 'code'
        AND content LIKE '%failed%'
        AND datetime(created_at) > datetime('now', '-30 days')
        AND EXISTS (SELECT 1 FROM json_each(memories.scopes_json) WHERE value LIKE 'rubric:%')
      GROUP BY scopes_json HAVING n >= 3 LIMIT 25
    `).all() as Array<{ scopes: string; n: number }>;

    let surfaced = 0;
    let drafted = 0;
    for (const r of rows) {
      const rubric = extractScope(r.scopes, /^rubric:/);
      if (!rubric) continue;
      const pat = await this.memory.add(env, {
        type: "semantic",
        content: `Pattern: ${rubric} has failed ${r.n} times in the last 30 days across runs. Candidate for rubric retuning.`,
        summary: `pattern: ${rubric} ×${r.n} fails / 30d`,
        scopes: ["type:Pattern", "pattern:rubric-recurring-failure", rubric],
        provenance: { actor: "miner" },
        confidence: 0.6,
      });
      surfaced += 1;
      // Try to draft a proposal against the resource backing this rubric.
      if (this.evolution) {
        const ok = await this.tryDraftProposal(env, { rubric_scope: rubric, evidence_memory_ids: [pat.id], pattern_summary: `rubric ${rubric} failing ${r.n}× in last 30 days` });
        if (ok) drafted += 1;
      }
    }
    return { surfaced, drafted };
  }

  private async mineMissabilityFailures(env: Envelope): Promise<{ surfaced: number; drafted: number }> {
    const rows = this.sql.db.prepare(`
      SELECT content, COUNT(*) as n FROM memories
      WHERE type = 'episodic' AND content LIKE '%Missability failures:%'
        AND content NOT LIKE '%Missability failures: 0%'
        AND datetime(created_at) > datetime('now', '-30 days')
      GROUP BY substr(content, 1, 200) HAVING n >= 2 LIMIT 25
    `).all() as Array<{ content: string; n: number }>;
    let surfaced = 0;
    for (const r of rows) {
      await this.memory.add(env, {
        type: "semantic",
        content: `Pattern: repeated missability failure cluster (×${r.n}). Sample: ${r.content.slice(0, 280)}`,
        summary: `pattern: missability cluster ×${r.n}`,
        scopes: ["type:Pattern", "pattern:missability-cluster"],
        provenance: { actor: "miner" }, confidence: 0.55,
      });
      surfaced += 1;
    }
    return { surfaced, drafted: 0 };
  }

  /** Look up a candidate resource for the pattern, draft a candidate via LLM, propose. */
  private async tryDraftProposal(env: Envelope, ctx: { rubric_scope: string; evidence_memory_ids: string[]; pattern_summary: string }): Promise<boolean> {
    if (!this.evolution || !this.llm) return false;
    // rubric_scope looks like "rubric:R-foo" — look for a registered pp rubric resource.
    const rubricId = ctx.rubric_scope.replace(/^rubric:/, "");
    const candidates = this.evolution.listResources({ consumer: "pp", kind: "rubric" });
    const target = candidates.find((r) => r.rid.endsWith(`.${rubricId}`));
    if (!target) return false;
    if (target.evolution_policy === "frozen") {
      this.audit.record("miner.proposal.skipped_frozen", env, { rid: target.rid, pattern: ctx.pattern_summary });
      return false;
    }
    const current = this.evolution.readVersion(target.rid, target.current_version) ?? "";
    if (!(await this.llm.available())) return false;

    const system = [
      "You are TheEights' miner-proposer. You produce a revised version of a project artifact in response to an observed failure pattern.",
      "Keep the artifact's structure. Keep all normative MUST/SHOULD rules. Tighten only — never loosen safety boundaries.",
      "Output the full revised artifact verbatim, no preamble, no markdown code fence.",
    ].join("\n");
    const user = [
      `Pattern: ${ctx.pattern_summary}`,
      "",
      "=== CURRENT ARTIFACT ===",
      current.slice(0, 6000),
      "",
      "Revise the artifact to better catch the pattern above. Preserve formatting.",
    ].join("\n");
    const candidate = await this.llm.complete(system, user, { temperature: 0.2, maxTokens: 1200, timeoutMs: this.budget?.timeoutMs, maxRetries: this.budget?.maxRetries });
    if (!candidate || candidate.trim() === current.trim()) return false;
    try {
      const prop = this.evolution.propose(env, {
        rid: target.rid,
        candidate_content: candidate,
        justification: `auto-drafted from miner pattern: ${ctx.pattern_summary}`,
        evidence_memory_ids: ctx.evidence_memory_ids,
      });
      // Evaluate immediately so the auto path can commit if the resource is auto + delta>=0.
      await this.evolution.evaluate(env, prop.proposal_id);
      const commit = await this.evolution.commit(env, prop.proposal_id);
      this.audit.record("miner.proposal.drafted", env, { rid: target.rid, proposal_id: prop.proposal_id, committed: commit.committed, reason: commit.reason });
      return true;
    } catch (err) {
      this.audit.record("miner.proposal.failed", env, { rid: target.rid, error: (err as Error).message });
      return false;
    }
  }
}

function extractScope(scopesJson: string, re: RegExp): string | null {
  try {
    const arr = JSON.parse(scopesJson) as string[];
    return arr.find((s) => re.test(s)) ?? null;
  } catch { return null; }
}
