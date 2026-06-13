import { join, basename } from "node:path";
import { readdirSync, existsSync } from "node:fs";
import type { EvolutionEngine } from "../evolution.js";
import type { Envelope } from "../../schemas/envelope.js";
import type { Logger } from "pino";
import { walk, registerFile, basenameNoExt, existsDir, type RegistrationResult } from "./common.js";
import type { RiskClass } from "../../schemas/resource.js";
import { aiappBase } from "../../paths.js";

const BASE = aiappBase();

const SAFETY_HOOK_PATTERNS: RegExp[] = [
  /pre-tool-safety/i,
  /session-(start|end)/i,
  /stop-checkpoint/i,
  /post-state-write-verify/i,
];

function isSafetyHook(filename: string): boolean {
  return SAFETY_HOOK_PATTERNS.some((re) => re.test(filename));
}

function discoverRlmRoots(filter?: string): string[] {
  const roots: string[] = [];
  try {
    for (const e of readdirSync(BASE, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (!/^RLM/.test(e.name) && e.name !== "RLM-CLI-Starter") continue;
      if (filter && e.name !== filter) continue;
      const p = join(BASE, e.name);
      if (existsSync(p)) roots.push(p);
    }
  } catch { /* ignore */ }
  return roots;
}

export class RlmRegistrar {
  constructor(private readonly engine: EvolutionEngine, private readonly log: Logger) {}

  run(env: Envelope, sibling?: string): RegistrationResult {
    const r: RegistrationResult = { consumer: "rlm", registered: 0, updated: 0, skipped: 0, errors: [] };
    const roots = discoverRlmRoots(sibling);
    if (!roots.length) {
      this.log.warn({ filter: sibling }, "rlm-registrar: no RLM* roots discovered");
      return r;
    }
    for (const root of roots) {
      const slug = basename(root).toLowerCase();

      // Phase prompts: RLM/prompts/{NN}-*.md
      const promptsDir = join(root, "RLM", "prompts");
      if (existsDir(promptsDir)) {
        for (const p of walk(promptsDir, (f) => f.endsWith(".md"), 2)) {
          const name = basenameNoExt(p);
          // Low-risk prompts: detect, report; non-orchestration documentation
          const isLow = /^(00-detect|08-report|09-verify|10-)/i.test(name) || /docs|changelog|formatting/i.test(name);
          this.regOne(env, r, {
            source_path: p, kind: "prompt",
            risk_class: isLow ? "low" : "medium",
            consumer: "rlm", rid: `resource:rlm.${slug}.prompt.${name}`,
          });
        }
      }

      // Agents across claude/gemini/copilot CLIs.
      for (const subdir of [".claude/agents", ".gemini/agents", ".github/agents"]) {
        const d = join(root, subdir);
        if (existsDir(d)) {
          for (const p of walk(d, (f) => f.endsWith(".md"), 2)) {
            const name = basenameNoExt(p);
            const cli = subdir.split(/[\\/]/)[0]!.replace(/^\./, "");
            this.regOne(env, r, {
              source_path: p, kind: "agent",
              risk_class: "high",
              consumer: "rlm", rid: `resource:rlm.${slug}.agent.${cli}.${name}`,
            });
          }
        }
      }

      // Hooks — safety hooks critical, the rest medium.
      // Keep the file extension in the rid since .ps1/.sh siblings are distinct resources.
      const hooksDir = join(root, ".claude", "hooks");
      if (existsDir(hooksDir)) {
        for (const p of walk(hooksDir, (f) => /\.(sh|ps1|js|ts|py)$/i.test(f), 3)) {
          const name = basename(p);
          const risk: RiskClass = isSafetyHook(name) ? "critical" : "medium";
          const idTail = name.replace(/[^a-zA-Z0-9._-]/g, "_");
          this.regOne(env, r, {
            source_path: p, kind: "hook",
            risk_class: risk,
            consumer: "rlm", rid: `resource:rlm.${slug}.hook.${idTail}`,
          });
        }
      }
    }

    this.log.info({ ...r, errors: r.errors.length, roots_scanned: roots.length }, "rlm-registrar complete");
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
