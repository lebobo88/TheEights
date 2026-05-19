import { mkdirSync } from "node:fs";

/**
 * Graph store — LadybugDB by default, Kuzu 0.11.x as fallback.
 * See ADR-0002. Single-writer enforced by a write queue at the engine layer.
 *
 * v0.1: dynamic import + thin wrapper. The driver module is loaded lazily so
 * the daemon boots even if native bindings aren't compiled yet (dev convenience).
 */
export class GraphStore {
  private impl: GraphImpl | null = null;

  constructor(
    private readonly path: string,
    private readonly driver: "ladybug" | "kuzu" = "ladybug",
  ) {}

  async open(): Promise<void> {
    mkdirSync(this.path, { recursive: true });
    // Lazy import to keep startup tolerant of missing native binaries during scaffolding.
    const mod = this.driver === "kuzu"
      ? await import("kuzu").catch(() => null)
      : await import("kuzu").catch(() => null); // LadybugDB exposes the same API surface
    if (!mod) {
      throw new Error(
        `Graph driver "${this.driver}" not available. Install kuzu/ladybug native bindings or run with EIGHTS_GRAPH_DRIVER=stub.`,
      );
    }
    // Real driver wiring goes here; left as a stub in v0.1.
    this.impl = new StubGraphImpl();
  }

  async runCypher(stmt: string, params: Record<string, unknown> = {}): Promise<unknown[]> {
    if (!this.impl) throw new Error("GraphStore not opened");
    return this.impl.runCypher(stmt, params);
  }

  async close(): Promise<void> {
    await this.impl?.close();
  }

  async ensureSchema(): Promise<void> {
    if (!this.impl) throw new Error("GraphStore not opened");
    await this.impl.runCypher(SCHEMA_CYPHER);
  }
}

interface GraphImpl {
  runCypher(stmt: string, params?: Record<string, unknown>): Promise<unknown[]>;
  close(): Promise<void>;
}

class StubGraphImpl implements GraphImpl {
  async runCypher(): Promise<unknown[]> {
    // Stub returns empty; full impl in Phase 0 follow-up commit.
    return [];
  }
  async close(): Promise<void> {}
}

const SCHEMA_CYPHER = `
// Node tables — see ARCHITECTURE.md §4.4 (Agent-BOM)
CREATE NODE TABLE IF NOT EXISTS Run(run_id STRING, project_id STRING, started_at STRING, PRIMARY KEY(run_id));
CREATE NODE TABLE IF NOT EXISTS Memory(mem_id STRING, type STRING, PRIMARY KEY(mem_id));
CREATE NODE TABLE IF NOT EXISTS Resource(rid STRING, kind STRING, PRIMARY KEY(rid));
CREATE NODE TABLE IF NOT EXISTS ResourceVersion(rid STRING, version STRING, PRIMARY KEY(rid, version));
CREATE NODE TABLE IF NOT EXISTS Decision(decision_id STRING, PRIMARY KEY(decision_id));
CREATE NODE TABLE IF NOT EXISTS Assumption(assumption_id STRING, PRIMARY KEY(assumption_id));
CREATE NODE TABLE IF NOT EXISTS Outcome(outcome_id STRING, PRIMARY KEY(outcome_id));
CREATE NODE TABLE IF NOT EXISTS Dissent(dissent_id STRING, PRIMARY KEY(dissent_id));
CREATE NODE TABLE IF NOT EXISTS Actor(actor_id STRING, kind STRING, PRIMARY KEY(actor_id));
CREATE NODE TABLE IF NOT EXISTS EvolutionProposal(proposal_id STRING, PRIMARY KEY(proposal_id));

// Edges
CREATE REL TABLE IF NOT EXISTS PRODUCED(FROM Run TO Memory);
CREATE REL TABLE IF NOT EXISTS WROTE(FROM Run TO Memory);
CREATE REL TABLE IF NOT EXISTS LINKS_TO(FROM Memory TO Memory, relation STRING);
CREATE REL TABLE IF NOT EXISTS SUPERSEDES(FROM Memory TO Memory);
CREATE REL TABLE IF NOT EXISTS ASSUMES(FROM Decision TO Assumption);
CREATE REL TABLE IF NOT EXISTS OUTCOME_OF(FROM Outcome TO Assumption);
CREATE REL TABLE IF NOT EXISTS HAD_VERSION(FROM Resource TO ResourceVersion);
CREATE REL TABLE IF NOT EXISTS PROPOSES(FROM EvolutionProposal TO ResourceVersion);
CREATE REL TABLE IF NOT EXISTS APPROVED_BY(FROM EvolutionProposal TO Actor);
CREATE REL TABLE IF NOT EXISTS REJECTED_BY(FROM EvolutionProposal TO Actor);
CREATE REL TABLE IF NOT EXISTS RAISED_BY(FROM Dissent TO Actor);
CREATE REL TABLE IF NOT EXISTS CALIBRATED_BY(FROM Dissent TO Outcome);
`;
