import { z } from "zod";

export const MemoryType = z.enum([
  "working",
  "episodic",
  "semantic",
  "procedural",
  "meta",
]);
export type MemoryType = z.infer<typeof MemoryType>;

export const Provenance = z.object({
  run_id: z.string().optional(),
  actor: z.string(),
  model: z.string().optional(),
  seed: z.union([z.string(), z.number()]).optional(),
  source_uri: z.string().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

export const Cell = z.enum([
  "vision", "context", "triggers", "influence",
  "risk", "focus", "constraints", "delight",
]);
export type Cell = z.infer<typeof Cell>;

export const Memory = z.object({
  id: z.string(),
  type: MemoryType,
  content: z.string(),
  summary: z.string().optional(),
  embedding_id: z.number().optional(),
  graph_node_id: z.string().optional(),
  provenance: Provenance,
  scopes: z.array(z.string()).default([]),
  created_at: z.string(),       // ISO 8601
  expires_at: z.string().optional(),
  confidence: z.number().min(0).max(1).default(0.5),
  supersedes: z.array(z.string()).default([]),
  superseded_by: z.array(z.string()).default([]),
  handle: z.string().optional(),
  cell: Cell.nullable().default(null),
});
export type Memory = z.infer<typeof Memory>;

export const MemoryHit = Memory.extend({
  score: z.number(),
  path: z.enum(["vector", "graph", "hybrid", "episodic"]),
});
export type MemoryHit = z.infer<typeof MemoryHit>;
