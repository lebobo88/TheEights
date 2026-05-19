import { z } from "zod";
import { Envelope } from "../schemas/envelope.js";
import { MemoryType } from "../schemas/memory.js";
import type { MemoryEngine } from "../engines/memory.js";

export const AddArgs = z.object({
  envelope: Envelope,
  content: z.string(),
  type: MemoryType,
  summary: z.string().optional(),
  scopes: z.array(z.string()).default([]),
  provenance: z.object({
    run_id: z.string().optional(),
    actor: z.string(),
    model: z.string().optional(),
    source_uri: z.string().optional(),
  }),
  embedding: z.array(z.number()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  supersedes: z.array(z.string()).optional(),
});

export const SearchArgs = z.object({
  envelope: Envelope,
  query: z.string(),
  query_embedding: z.array(z.number()).optional(),
  types: z.array(MemoryType).optional(),
  scopes: z.array(z.string()).optional(),
  top_k: z.number().int().positive().max(100).default(10),
  fusion: z.enum(["hybrid", "vector", "graph", "episodic"]).default("hybrid"),
});

export const GetArgs = z.object({
  envelope: Envelope,
  memory_id: z.string(),
});

export const LinkArgs = z.object({
  envelope: Envelope,
  from_id: z.string(),
  to_id: z.string(),
  relation: z.string(),
  weight: z.number().optional(),
});

export function registerMemoryTools(engine: MemoryEngine) {
  return {
    "eights.memory.add": {
      description: "Write a memory (working|episodic|semantic|procedural|meta). Auto-embeds via the local embedder.",
      schema: AddArgs,
      handler: async (a: z.infer<typeof AddArgs>) =>
        engine.add(a.envelope, {
          content: a.content,
          type: a.type,
          summary: a.summary,
          scopes: a.scopes,
          provenance: a.provenance,
          embedding: a.embedding ? Float32Array.from(a.embedding) : undefined,
          confidence: a.confidence,
          supersedes: a.supersedes,
        }),
    },
    "eights.memory.search": {
      description: "Hybrid memory search across vector + graph + episodic. Falls back to episodic when the local embedder is unavailable.",
      schema: SearchArgs,
      handler: async (a: z.infer<typeof SearchArgs>) =>
        engine.search(a.envelope, {
          query: a.query,
          query_embedding: a.query_embedding ? Float32Array.from(a.query_embedding) : undefined,
          types: a.types,
          scopes: a.scopes,
          top_k: a.top_k,
          fusion: a.fusion,
        }),
    },
    "eights.memory.get": {
      description: "Fetch a memory by id.",
      schema: GetArgs,
      handler: async (a: z.infer<typeof GetArgs>) => engine.get(a.envelope, a.memory_id),
    },
    "eights.memory.link": {
      description: "Create a typed edge between two memories.",
      schema: LinkArgs,
      handler: async (a: z.infer<typeof LinkArgs>) =>
        engine.link(a.envelope, { from_id: a.from_id, to_id: a.to_id, relation: a.relation, weight: a.weight }),
    },
  } as const;
}
