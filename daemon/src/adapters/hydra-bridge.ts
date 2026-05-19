/**
 * hydra-bridge — LangGraph adapter.
 *
 * Hydra declares a 3-tier memory fabric but doesn't implement it. TheEights *is*
 * that fabric: Hydra nodes call `eights.memory.search` for retrieval, and
 * `MemoryRef` handles point at eights memory ids.
 *
 * Phase 4. Stub left here so the contract is visible to downstream consumers.
 */
import type { MemoryEngine } from "../engines/memory.js";

export interface MemoryRef {
  tier: "ephemeral" | "episodic" | "semantic";
  key: string;       // eights memory id
  summary: string;
}

export class HydraBridge {
  constructor(private readonly memory: MemoryEngine) {}

  // Phase 4: implement MemoryRef resolution + LangGraph node hooks.
  // Intentionally empty in v0.1.
}
