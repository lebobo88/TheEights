/**
 * Pair-programmer registrar.
 *
 * Walks the known glob roots for pp behavior artifacts and idempotently
 * registers each as an RSPL resource with rule-based risk_class assignment.
 *
 * NOTE on rubrics: pp's rubrics are mostly hardcoded in
 * `daemon/src/rubrics/registry.ts`, but pp supports a disk-override path at
 * `C:/.claude/rubrics/*.md`. We register against the override path; if the
 * file is absent, we still mint the resource with empty initial content so
 * the override slot is reserved and edits will be tracked.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { EvolutionEngine } from "../evolution.js";
import type { Envelope } from "../../schemas/envelope.js";
import type { Logger } from "pino";
import { walk, registerFile, basenameNoExt, existsDir, type RegistrationResult } from "./common.js";
import { siblingRoot } from "../../paths.js";

const PP_ROOT = siblingRoot("pair-programmer");
// pp installs into the user-level Claude Code dir (~/.claude/), not C:/.claude
const CLAUDE_ROOT = join(homedir(), ".claude").replace(/\\/g, "/");

const CRITICAL_RUBRIC_RE = /^(security|contract|spec|owasp|slsa|nist|hipaa|gdpr|coppa|wcag)/i;

export class PpRegistrar {
  constructor(private readonly engine: EvolutionEngine, private readonly log: Logger) {}

  run(env: Envelope): RegistrationResult {
    const r: RegistrationResult = { consumer: "pp", registered: 0, updated: 0, skipped: 0, errors: [] };

    // 1. Sub-agents under C:/.claude/agents/*.md (pp installs 39 of these).
    const agentsDir = join(CLAUDE_ROOT, "agents");
    if (existsDir(agentsDir)) {
      for (const p of walk(agentsDir, (f) => f.endsWith(".md"), 2)) {
        const slug = basenameNoExt(p);
        this.regOne(env, r, { source_path: p, kind: "agent", risk_class: "high", consumer: "pp", rid: `resource:pp.agent.${slug}` });
      }
    }

    // 2. Teams under C:/.claude/teams/*.yaml.
    const teamsDir = join(CLAUDE_ROOT, "teams");
    if (existsDir(teamsDir)) {
      for (const p of walk(teamsDir, (f) => f.endsWith(".yaml") || f.endsWith(".yml"), 1)) {
        const slug = basenameNoExt(p);
        this.regOne(env, r, { source_path: p, kind: "team", risk_class: "high", consumer: "pp", rid: `resource:pp.team.${slug}` });
      }
    }

    // 3. Slash commands under C:/.claude/commands/pp/*.md.
    const cmdsDir = join(CLAUDE_ROOT, "commands", "pp");
    if (existsDir(cmdsDir)) {
      for (const p of walk(cmdsDir, (f) => f.endsWith(".md"), 1)) {
        const slug = basenameNoExt(p);
        this.regOne(env, r, { source_path: p, kind: "command", risk_class: "high", consumer: "pp", rid: `resource:pp.command.${slug}` });
      }
    }

    // 4. Rubric disk-overrides under C:/.claude/rubrics/*.md. Critical for safety-class rubrics.
    const rubricsDir = join(CLAUDE_ROOT, "rubrics");
    if (existsDir(rubricsDir)) {
      for (const p of walk(rubricsDir, (f) => f.endsWith(".md"), 1)) {
        const slug = basenameNoExt(p);
        const isCritical = CRITICAL_RUBRIC_RE.test(slug);
        this.regOne(env, r, {
          source_path: p, kind: "rubric",
          risk_class: isCritical ? "critical" : "medium",
          consumer: "pp", rid: `resource:pp.rubric.${slug}`,
        });
      }
    }

    // 5. AGENTS.md / CLAUDE.md class.
    for (const fname of ["AGENTS.md", "CLAUDE.md"]) {
      const p = join(CLAUDE_ROOT, fname);
      if (existsSync(p)) {
        this.regOne(env, r, { source_path: p, kind: "contract", risk_class: "high", consumer: "pp", rid: `resource:pp.contract.${fname.toLowerCase()}` });
      }
      // Also check pp project root.
      const pp = join(PP_ROOT, fname);
      if (existsSync(pp)) {
        this.regOne(env, r, { source_path: pp, kind: "contract", risk_class: "high", consumer: "pp", rid: `resource:pp.project.contract.${fname.toLowerCase()}` });
      }
    }

    this.log.info({ ...r, errors: r.errors.length }, "pp-registrar complete");
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
