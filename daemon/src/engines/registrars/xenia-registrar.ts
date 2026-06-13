import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import type { EvolutionEngine } from "../evolution.js";
import type { Envelope } from "../../schemas/envelope.js";
import type { Logger } from "pino";
import { walk, registerFile, basenameNoExt, existsDir, type RegistrationResult } from "./common.js";
import type { RiskClass } from "../../schemas/resource.js";
import { siblingRoot } from "../../paths.js";

const DEFAULT_ROOT = siblingRoot("Xenia");

// Xenia's enforcement hooks are all safety-relevant; the redaction and
// privilege gates are critical (they enforce constitution Articles IV/V).
const CRITICAL_HOOK_PATTERNS: RegExp[] = [
  /pre-response-redaction/i,
  /pre-tool-privilege/i,
];

function hookRisk(filename: string): RiskClass {
  return CRITICAL_HOOK_PATTERNS.some((re) => re.test(filename)) ? "critical" : "medium";
}

export class XeniaRegistrar {
  constructor(private readonly engine: EvolutionEngine, private readonly log: Logger) {}

  run(env: Envelope): RegistrationResult {
    const r: RegistrationResult = { consumer: "xenia", registered: 0, updated: 0, skipped: 0, errors: [] };
    const root = process.env.EIGHTS_XENIA_ROOT ?? DEFAULT_ROOT;
    if (!existsSync(root)) {
      this.log.warn({ root }, "xenia-registrar: Xenia root not present");
      return r;
    }

    // Agents (incl. soteria-crew/ sub-agents) — high risk (squad authority).
    const agentsDir = join(root, ".claude", "agents");
    if (existsDir(agentsDir)) {
      for (const p of walk(agentsDir, (f) => f.endsWith(".md"), 3)) {
        this.regOne(env, r, {
          source_path: p, kind: "agent",
          risk_class: "high",
          consumer: "xenia", rid: `resource:xenia.agent.${basenameNoExt(p)}`,
        });
      }
    }

    // Skills — low risk (reference material).
    const skillsDir = join(root, ".claude", "skills");
    if (existsDir(skillsDir)) {
      for (const p of walk(skillsDir, (f) => basename(f) === "SKILL.md", 3)) {
        const slug = basename(join(p, ".."));
        this.regOne(env, r, {
          source_path: p, kind: "skill",
          risk_class: "low",
          consumer: "xenia", rid: `resource:xenia.skill.${slug}`,
        });
      }
    }

    // Commands — medium risk (operator entry points).
    const commandsDir = join(root, ".claude", "commands");
    if (existsDir(commandsDir)) {
      for (const p of walk(commandsDir, (f) => f.endsWith(".md"), 2)) {
        this.regOne(env, r, {
          source_path: p, kind: "command",
          risk_class: "medium",
          consumer: "xenia", rid: `resource:xenia.command.${basenameNoExt(p)}`,
        });
      }
    }

    // Rubrics — low risk (judging surface).
    const rubricsDir = join(root, "rubrics");
    if (existsDir(rubricsDir)) {
      for (const p of walk(rubricsDir, (f) => f.endsWith(".yaml"), 2)) {
        this.regOne(env, r, {
          source_path: p, kind: "rubric",
          risk_class: "low",
          consumer: "xenia", rid: `resource:xenia.rubric.${basenameNoExt(p)}`,
        });
      }
    }

    // Squad manifest — high risk (routing + authority bundle).
    const squadYaml = join(root, "squad.yaml");
    if (existsSync(squadYaml)) {
      this.regOne(env, r, {
        source_path: squadYaml, kind: "squad",
        risk_class: "high",
        consumer: "xenia", rid: "resource:xenia.squad.customer-support",
      });
    }

    // Hooks — redaction/privilege gates critical, telemetry medium.
    const hooksDir = join(root, ".claude", "hooks");
    if (existsDir(hooksDir)) {
      for (const p of walk(hooksDir, (f) => /\.(sh|ps1|js|ts|py)$/i.test(f), 2)) {
        const name = basename(p);
        const idTail = name.replace(/[^a-zA-Z0-9._-]/g, "_");
        this.regOne(env, r, {
          source_path: p, kind: "hook",
          risk_class: hookRisk(name),
          consumer: "xenia", rid: `resource:xenia.hook.${idTail}`,
        });
      }
    }

    this.log.info({ ...r, errors: r.errors.length }, "xenia-registrar complete");
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
