import { z } from "zod";
import { Envelope } from "../schemas/envelope.js";
import type { EvolutionEngine } from "../engines/evolution.js";

export const DiffArgs = z.object({
  envelope: Envelope,
  rid: z.string(),
  from_version: z.string().optional(),
  to_version: z.string().optional(),
});

export const ListArgs = z.object({
  envelope: Envelope,
  consumer: z.enum(["hydra", "pp", "execsuite", "rlm", "eights"]).optional(),
});

export const GetArgs = z.object({
  envelope: Envelope,
  rid: z.string(),
});

export function registerPromptTools(engine: EvolutionEngine) {
  return {
    "eights.prompt.list": {
      description: "List every registered agent prompt across the four consumers (kind=prompt). Used by HITL reviewers to scope diffs.",
      schema: ListArgs,
      handler: async (a: z.infer<typeof ListArgs>) => {
        const rows = engine.listResources({ kind: "prompt", consumer: a.consumer });
        return rows.map((r) => ({
          rid: r.rid, consumer: r.consumer, risk_class: r.risk_class,
          evolution_policy: r.evolution_policy, current_version: r.current_version,
          source_path: r.sources[0]?.source_path,
        }));
      },
    },
    "eights.prompt.get": {
      description: "Fetch current prompt text + metadata. Hydra supervisors call this to load agent prompts at run start.",
      schema: GetArgs,
      handler: async (a: z.infer<typeof GetArgs>) => {
        const r = engine.getResource(a.rid);
        if (!r) return null;
        const text = engine.readVersion(r.rid, r.current_version) ?? "";
        return {
          rid: r.rid, consumer: r.consumer, risk_class: r.risk_class,
          current_version: r.current_version, evolution_policy: r.evolution_policy, content: text,
        };
      },
    },
    "eights.prompt.diff": {
      description: "Unified diff between two versions of a prompt resource. Default: previous → current.",
      schema: DiffArgs,
      handler: async (a: z.infer<typeof DiffArgs>) => {
        const r = engine.getResource(a.rid);
        if (!r) return { error: `unknown rid ${a.rid}` };
        const versions = r.versions;
        const to = a.to_version ?? r.current_version;
        const fromIdx = a.from_version
          ? versions.findIndex((v) => v.version === a.from_version)
          : versions.findIndex((v) => v.version === to) - 1;
        const toIdx = versions.findIndex((v) => v.version === to);
        if (toIdx < 0) return { error: `unknown to_version ${to}` };
        const fromVersion = fromIdx >= 0 ? versions[fromIdx] : null;
        const toVersion = versions[toIdx];
        return {
          rid: r.rid,
          from: fromVersion ? { version: fromVersion.version, created_at: fromVersion.created_at } : null,
          to: { version: toVersion!.version, created_at: toVersion!.created_at },
          diff: unifiedDiff(fromVersion?.content ?? "", toVersion!.content),
        };
      },
    },
  } as const;
}

/** Tiny line-level unified-diff. Good enough for prompt review; not a full Myers implementation. */
function unifiedDiff(a: string, b: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < aLines.length || j < bLines.length) {
    const av = aLines[i];
    const bv = bLines[j];
    if (av === bv) {
      out.push(`  ${av ?? ""}`);
      i += 1; j += 1;
    } else if (j < bLines.length && !aLines.slice(i, i + 4).includes(bv ?? "\0")) {
      out.push(`+ ${bv ?? ""}`);
      j += 1;
    } else {
      out.push(`- ${av ?? ""}`);
      i += 1;
    }
  }
  return out.join("\n");
}
