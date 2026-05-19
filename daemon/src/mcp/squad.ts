import { z } from "zod";
import { Envelope } from "../schemas/envelope.js";
import type { EvolutionEngine } from "../engines/evolution.js";

export const ListArgs = z.object({
  envelope: Envelope,
  active_only: z.boolean().default(true),
  consumer: z.enum(["hydra"]).default("hydra"),
});

export const GetArgs = z.object({
  envelope: Envelope,
  squad_id: z.string(),
});

export function registerSquadTools(engine: EvolutionEngine) {
  return {
    "eights.squad.list": {
      description: "List Hydra squad resources (kind=squad). Each entry includes rid, slug, risk_class, evolution_policy, current_version.",
      schema: ListArgs,
      handler: async (a: z.infer<typeof ListArgs>) => {
        const all = engine.listResources({ consumer: a.consumer, kind: "squad" });
        return all.map((r) => ({
          rid: r.rid,
          slug: r.rid.split(".").pop(),
          risk_class: r.risk_class,
          evolution_policy: r.evolution_policy,
          current_version: r.current_version,
          source_path: r.sources[0]?.source_path,
        }));
      },
    },
    "eights.squad.get": {
      description: "Fetch a squad resource by rid (e.g. resource:hydra.squad.engineering) — returns YAML content + version + risk class.",
      schema: GetArgs,
      handler: async (a: z.infer<typeof GetArgs>) => {
        const r = engine.getResource(a.squad_id);
        if (!r) return null;
        const content = engine.readVersion(r.rid, r.current_version) ?? "";
        return {
          rid: r.rid,
          risk_class: r.risk_class,
          evolution_policy: r.evolution_policy,
          current_version: r.current_version,
          content,
          source_path: r.sources[0]?.source_path,
        };
      },
    },
  } as const;
}
