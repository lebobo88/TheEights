import { join, basename, dirname } from "node:path";
import type { EvolutionEngine } from "../evolution.js";
import type { Envelope } from "../../schemas/envelope.js";
import type { Logger } from "pino";
import { walk, registerFile, basenameNoExt, existsDir, type RegistrationResult } from "./common.js";
import type { RiskClass } from "../../schemas/resource.js";
import { siblingRoot } from "../../paths.js";

const EXEC_ROOT = siblingRoot("ExecutiveSuite");

const CRITICAL_SKILLS = new Set([
  "executive-protocol",
  "ai-governance",
  "financial-frameworks",
]);

export class ExecSuiteRegistrar {
  constructor(private readonly engine: EvolutionEngine, private readonly log: Logger) {}

  run(env: Envelope): RegistrationResult {
    const r: RegistrationResult = { consumer: "execsuite", registered: 0, updated: 0, skipped: 0, errors: [] };
    const claudeDir = join(EXEC_ROOT, ".claude");

    // Agents (20 + 4 orchestrators).
    const agentsDir = join(claudeDir, "agents");
    if (existsDir(agentsDir)) {
      for (const p of walk(agentsDir, (f) => f.endsWith(".md"), 2)) {
        const slug = basenameNoExt(p);
        this.regOne(env, r, { source_path: p, kind: "agent", risk_class: "high", consumer: "execsuite", rid: `resource:execsuite.agent.${slug}` });
      }
    }

    // Skills (9). Critical for governance/finance/AI-controls skills.
    const skillsDir = join(claudeDir, "skills");
    if (existsDir(skillsDir)) {
      for (const p of walk(skillsDir, (f) => /SKILL\.md$/i.test(f), 3)) {
        const skillSlug = basename(dirname(p));
        const risk: RiskClass = CRITICAL_SKILLS.has(skillSlug) ? "critical" : "high";
        this.regOne(env, r, { source_path: p, kind: "skill", risk_class: risk, consumer: "execsuite", rid: `resource:execsuite.skill.${skillSlug}` });
      }
    }

    // Slash commands.
    const cmdsDir = join(claudeDir, "commands");
    if (existsDir(cmdsDir)) {
      for (const p of walk(cmdsDir, (f) => f.endsWith(".md"), 1)) {
        const slug = basenameNoExt(p);
        this.regOne(env, r, { source_path: p, kind: "command", risk_class: "high", consumer: "execsuite", rid: `resource:execsuite.command.${slug}` });
      }
    }

    this.log.info({ ...r, errors: r.errors.length }, "execsuite-registrar complete");
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
