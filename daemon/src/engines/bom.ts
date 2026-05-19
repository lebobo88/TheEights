/**
 * BomEngine — emits a CycloneDX ML-BOM v1.7 export of the active eights
 * footprint: MCP servers, models, tools, memory stores, and adapters.
 *
 * Per ADR-update (research May 2026): no dedicated Agent-BOM standard exists;
 * CycloneDX ML-BOM is the de-facto vehicle. This is a minimal, valid-shape
 * document — extensions for cryptographic provenance live in Phase 4 follow-on.
 */
import type { SqliteStore } from "../stores/sqlite.js";

export class BomEngine {
  constructor(private readonly sql: SqliteStore) {}

  emit(opts: { project_id?: string; since?: string } = {}): Record<string, unknown> {
    const now = new Date().toISOString();
    const components: Array<Record<string, unknown>> = [
      {
        type: "application",
        "bom-ref": "eights-daemon@0.2.0",
        name: "eights-daemon",
        version: "0.2.0",
        description: "TheEights — persistent self-evolving agent fabric daemon",
        properties: [
          { name: "eights:layer", value: "substrate" },
          { name: "eights:transport", value: "mcp-stdio" },
        ],
      },
      {
        type: "data",
        "bom-ref": "store:sqlite-vec",
        name: "sqlite-vec",
        version: "0.1.9",
        properties: [{ name: "eights:role", value: "vector-store" }],
      },
      {
        type: "data",
        "bom-ref": "store:ladybugdb",
        name: "LadybugDB",
        version: "0.11+",
        properties: [{ name: "eights:role", value: "graph-store" }],
      },
      {
        type: "machine-learning-model",
        "bom-ref": "model:nomic-embed-text",
        name: "nomic-embed-text",
        version: "v1.5",
        properties: [
          { name: "eights:role", value: "embedder" },
          { name: "eights:dim", value: "768" },
          { name: "eights:runtime", value: "ollama" },
        ],
      },
    ];

    // Resources as components.
    const resourceRows = this.sql.db.prepare(`SELECT rid, kind, risk_class, current_version, evolution_policy FROM resources`).all() as Array<{ rid: string; kind: string; risk_class: string; current_version: string; evolution_policy: string }>;
    for (const r of resourceRows) {
      components.push({
        type: "file",
        "bom-ref": r.rid,
        name: r.rid,
        version: r.current_version,
        properties: [
          { name: "eights:kind", value: r.kind },
          { name: "eights:risk_class", value: r.risk_class },
          { name: "eights:evolution_policy", value: r.evolution_policy },
        ],
      });
    }

    // Projects as services.
    const projectRows = this.sql.db.prepare(`SELECT project_id, domain FROM projects`).all() as Array<{ project_id: string; domain: string }>;
    const services = projectRows.map((p) => ({
      "bom-ref": `project:${p.project_id}`,
      name: p.project_id,
      properties: [{ name: "eights:domain", value: p.domain }],
    }));

    const bom = {
      bomFormat: "CycloneDX",
      specVersion: "1.7",
      serialNumber: `urn:uuid:${cryptoRandomUuid()}`,
      version: 1,
      metadata: {
        timestamp: now,
        tools: { components: [{ name: "eights-daemon", version: "0.2.0" }] },
        component: {
          type: "application",
          "bom-ref": "root:TheEights",
          name: opts.project_id ?? "TheEights",
        },
      },
      components,
      services,
    } as Record<string, unknown>;
    return bom;
  }
}

function cryptoRandomUuid(): string {
  // Native crypto.randomUUID() is available in Node 20+.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.() ?? `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, "0")}`;
}
