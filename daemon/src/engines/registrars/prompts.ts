/**
 * PromptRegistrar — bulk-register every agent system prompt across the four
 * consumer repos as `kind: "prompt"` resources so they all flow through the
 * RSPL/SEPL gate. Manifesto §"Procedural Spine".
 *
 * Scans:
 *   <repo>/.claude/agents/*.md
 *   <repo>/.claude/skills/* /SKILL.md
 *   <repo>/.claude/commands/*.md
 *   <repo>/.codex/agents/*.md            (optional, glob-tolerant)
 *   <repo>/.gemini/agents/*.md           (optional)
 *
 * Risk default: "high" → hitl-only. Operators may demote individual prompts
 * to "low" via evolution.unfreeze + override.
 */
import { join } from "node:path";
import type { EvolutionEngine } from "../evolution.js";
import type { Envelope } from "../../schemas/envelope.js";
import type { Consumer } from "../../schemas/resource.js";
import type { Logger } from "pino";
import { walk, registerFile, basenameNoExt, existsDir, type RegistrationResult } from "./common.js";

interface RepoRoot { consumer: Consumer; root: string }

const REPOS: RepoRoot[] = [
  { consumer: "hydra", root: "C:/AiAppDeployments/Hydra" },
  { consumer: "pp", root: "C:/AiAppDeployments/pair-programmer" },
  { consumer: "execsuite", root: "C:/AiAppDeployments/ExecutiveSuite" },
  { consumer: "rlm", root: "C:/AiAppDeployments/RLM-CLI-Starter" },
];

export class PromptRegistrar {
  constructor(private readonly engine: EvolutionEngine, private readonly log: Logger) {}

  run(env: Envelope): RegistrationResult[] {
    return REPOS.map((repo) => this.runOne(env, repo));
  }

  private runOne(env: Envelope, repo: RepoRoot): RegistrationResult {
    const r: RegistrationResult = { consumer: repo.consumer, registered: 0, updated: 0, skipped: 0, errors: [] };
    const scopes: Array<{ dir: string; tag: string }> = [
      { dir: join(repo.root, ".claude", "agents"), tag: "agent" },
      { dir: join(repo.root, ".claude", "commands"), tag: "command" },
      { dir: join(repo.root, ".codex", "agents"), tag: "agent" },
      { dir: join(repo.root, ".gemini", "agents"), tag: "agent" },
    ];
    for (const s of scopes) {
      if (!existsDir(s.dir)) continue;
      for (const p of walk(s.dir, (f) => f.endsWith(".md"), 3)) {
        const slug = basenameNoExt(p);
        const rid = `resource:${repo.consumer}.prompt.${s.tag}.${slug}`;
        this.regOne(env, r, {
          source_path: p, kind: "prompt",
          risk_class: "high", consumer: repo.consumer, rid,
          writeback_mode: "in-place+branch",
        });
      }
    }
    // .claude/skills/<name>/SKILL.md
    const skillsDir = join(repo.root, ".claude", "skills");
    if (existsDir(skillsDir)) {
      for (const p of walk(skillsDir, (f) => f.toUpperCase().endsWith("SKILL.MD") || f.endsWith("skill.md"), 4)) {
        const skillSlug = p.split(/[\\/]/).slice(-2, -1)[0] ?? basenameNoExt(p);
        const rid = `resource:${repo.consumer}.prompt.skill.${skillSlug}`;
        this.regOne(env, r, {
          source_path: p, kind: "prompt", risk_class: "high",
          consumer: repo.consumer, rid, writeback_mode: "in-place+branch",
        });
      }
    }
    this.log.info({ ...r, errors: r.errors.length }, "prompt-registrar complete");
    return r;
  }

  private regOne(env: Envelope, r: RegistrationResult, spec: Parameters<typeof registerFile>[2]): void {
    try {
      const result = registerFile(this.engine, env, spec);
      if (result.kind === "registered") r.registered += 1;
      else if (result.kind === "updated") r.updated += 1;
      else r.skipped += 1;
    } catch (err) {
      r.errors.push({ path: spec.source_path, error: (err as Error).message });
    }
  }
}
