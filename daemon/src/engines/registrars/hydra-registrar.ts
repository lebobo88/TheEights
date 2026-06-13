import { join } from "node:path";
import type { EvolutionEngine } from "../evolution.js";
import type { Envelope } from "../../schemas/envelope.js";
import type { Logger } from "pino";
import { walk, registerFile, basenameNoExt, existsDir, type RegistrationResult } from "./common.js";
import { siblingRoot } from "../../paths.js";

const HYDRA_ROOT = siblingRoot("Hydra");

export class HydraRegistrar {
  constructor(private readonly engine: EvolutionEngine, private readonly log: Logger) {}

  run(env: Envelope): RegistrationResult {
    const r: RegistrationResult = { consumer: "hydra", registered: 0, updated: 0, skipped: 0, errors: [] };
    const squadsDir = join(HYDRA_ROOT, "squads");
    if (existsDir(squadsDir)) {
      for (const p of walk(squadsDir, (f) => f.endsWith("squad.yaml") || f.endsWith("squad.yml"), 3)) {
        const slug = p.split(/[\\/]/).slice(-2, -1)[0] ?? basenameNoExt(p);
        // Executive + legal-compliance + governance squads are frozen.
        // Everything else is high (HITL) by default; operators can demote via evolution.unfreeze.
        const risk = ["executive", "legal-compliance", "governance"].includes(slug) ? "critical" : "high";
        this.regOne(env, r, {
          source_path: p, kind: "squad", risk_class: risk, consumer: "hydra",
          rid: `resource:hydra.squad.${slug}`,
        });
      }
    }
    this.log.info({ ...r, errors: r.errors.length }, "hydra-registrar complete");
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
