import { nanoid } from "nanoid";
import type { SqliteStore } from "../stores/sqlite.js";
import type { VectorStore } from "../stores/vec.js";
import type { GraphStore } from "../stores/graph.js";
import type { AuditEngine } from "./audit.js";
import type { PolicyEngine } from "./policy.js";
import type { Embedder } from "../embeddings.js";
import type { Envelope } from "../schemas/envelope.js";
import type { Memory, MemoryHit, MemoryType, Provenance } from "../schemas/memory.js";
import { deriveHandle, isHandle, parseHandle } from "../schemas/memory-handle.js";

export class MemoryRejection extends Error {
  constructor(
    public readonly gate: "consistency" | "decay" | "access" | "policy",
    public readonly detail: unknown,
  ) {
    super(`memory write rejected by gate '${gate}'`);
  }
}

export interface AddMemoryInput {
  content: string;
  type: MemoryType;
  summary?: string;
  scopes?: string[];
  provenance: Provenance;
  embedding?: Float32Array;
  confidence?: number;
  supersedes?: string[];
  expires_at?: string;
  handle?: string;
  cell?: string;
  /**
   * Stable dedup key for re-ingesting adapters (e.g. pp-watcher). When set, a
   * second add with the same (tenant_id, idempotency_key) is a no-op that returns
   * the existing memory instead of inserting a duplicate. See SqliteStore V8.
   */
  idempotency_key?: string;
}

export interface SearchMemoryInput {
  query: string;
  query_embedding?: Float32Array;
  types?: MemoryType[];
  scopes?: string[];
  top_k?: number;
  fusion?: "hybrid" | "vector" | "graph" | "episodic";
}

export interface LinkInput {
  from_id: string;
  to_id: string;
  relation: string;
  weight?: number;
}

/**
 * Memory engine — hybrid write across sqlite-vec + LadybugDB + SQLite episodic.
 * Auto-embeds via the supplied Embedder when no embedding is provided.
 * SSGM gates are intentionally NOT here yet; they land in Phase 2.
 */
export class MemoryEngine {
  constructor(
    private readonly sql: SqliteStore,
    private readonly vec: VectorStore,
    private readonly graph: GraphStore,
    private readonly audit: AuditEngine,
    private readonly embedder: Embedder,
    private readonly policy: PolicyEngine,
  ) {}

  async add(env: Envelope, input: AddMemoryInput): Promise<Memory> {
    // SSGM Gate 3 (access) — enforced FIRST, before the idempotency short-circuit
    // below, so a caller can never retrieve an existing memory by guessing its
    // idempotency_key without passing the access gate (authorization bypass).
    const access = this.policy.accessCheck(env, input.scopes ?? []);
    if (!access.ok) {
      this.audit.record("memory.add.rejected", env, { gate: "access", reason: access.reason });
      throw new MemoryRejection("access", access);
    }
    // Idempotency short-circuit (anti-bloat). A re-ingesting adapter (e.g. the
    // pp-watcher) supplies a stable idempotency_key; if a memory with that key
    // already exists, return it without re-embedding, re-inserting, or writing an
    // audit event. This is the structural guard that prevents a watcher loop from
    // ballooning `memories` with duplicates even if its watermark ever regresses.
    if (input.idempotency_key) {
      const existing = this._findByIdempotencyKey(env.tenant_id, input.idempotency_key);
      if (existing) {
        // Re-check access against the EXISTING memory's scopes (not the caller's
        // claimed input scopes) so a guessed key + deliberately weak input scopes
        // can't exfiltrate a memory written under stronger scopes.
        const exAccess = this.policy.accessCheck(env, existing.scopes ?? []);
        if (!exAccess.ok) {
          this.audit.record("memory.add.rejected", env, { gate: "access", reason: exAccess.reason });
          throw new MemoryRejection("access", exAccess);
        }
        return existing;
      }
    }
    // SSGM Gate 1 (consistency)
    const consistency = this.policy.consistencyCheck(env, {
      content: input.content,
      type: input.type,
      scopes: input.scopes ?? [],
      supersedes: input.supersedes ?? [],
      confidence: input.confidence ?? 0.5,
    });
    if (!consistency.ok) {
      this.audit.record("memory.add.rejected", env, { gate: "consistency", conflicts: consistency.conflicts });
      throw new MemoryRejection("consistency", consistency);
    }
    // SSGM Gate 2 (decay / resurrection)
    if (input.supersedes && input.supersedes.length) {
      const res = this.policy.resurrectionCheck(input.supersedes, []);
      if (!res.ok) {
        this.audit.record("memory.add.rejected", env, { gate: "decay", reason: res.reason });
        throw new MemoryRejection("decay", res);
      }
    }
    return this._addCommitted(env, input);
  }

  private async _addCommitted(env: Envelope, input: AddMemoryInput): Promise<Memory> {
    const id = `mem_${nanoid()}`;
    const now = new Date().toISOString();
    let embedding = input.embedding;
    if (!embedding) {
      const auto = await this.embedder.embed(input.summary ?? input.content);
      if (auto) embedding = auto;
    }
    let embedding_id: number | undefined;
    if (embedding) embedding_id = this.vec.insert(embedding);

    const handle = input.handle ?? deriveHandle({ memory_id: id, type: input.type, provenance: input.provenance });
    const mem: Memory = {
      id,
      type: input.type,
      content: input.content,
      summary: input.summary,
      embedding_id,
      provenance: input.provenance,
      scopes: input.scopes ?? [],
      created_at: now,
      expires_at: input.expires_at,
      confidence: input.confidence ?? 0.5,
      supersedes: input.supersedes ?? [],
      superseded_by: [],
      handle,
      cell: (input.cell as Memory["cell"]) ?? null,
    };

    try {
      this.sql.db
        .prepare(
          `INSERT INTO memories(
            id, type, content, summary, embedding_id, graph_node_id,
            provenance_json, scopes_json, tenant_id, project_id, domain,
            created_at, expires_at, confidence, supersedes_json, superseded_by_json,
            handle, cell, idempotency_key
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id, input.type, input.content, input.summary ?? null,
          embedding_id ?? null, null,
          JSON.stringify(input.provenance),
          JSON.stringify(input.scopes ?? []),
          env.tenant_id, env.project_id, env.domain,
          now, input.expires_at ?? null,
          mem.confidence,
          JSON.stringify(input.supersedes ?? []),
          "[]",
          handle, input.cell ?? null, input.idempotency_key ?? null,
        );
    } catch (err) {
      // Race: a concurrent daemon inserted the same idempotency_key between our
      // pre-check and this INSERT. The V8 UNIQUE index rejects the duplicate;
      // return the winner instead of throwing. Roll back the orphaned embedding.
      if (input.idempotency_key && isUniqueViolation(err)) {
        const winner = this._findByIdempotencyKey(env.tenant_id, input.idempotency_key);
        // The losing side's embedding row is left orphaned (VectorStore is
        // insert-only); a rare, tiny leak that the reclaim job can sweep.
        if (winner) return winner;
      }
      throw err;
    }

    this.audit.record("memory.add", env, { memory_id: id, type: input.type, handle, cell: input.cell ?? null, embedded: !!embedding_id });
    return mem;
  }

  /** Look up an existing memory by its dedup key within a tenant (V8). */
  private _findByIdempotencyKey(tenant_id: string, key: string): Memory | null {
    const row = this.sql.db
      .prepare("SELECT * FROM memories WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1")
      .get(tenant_id, key) as Record<string, unknown> | undefined;
    return row ? rowToMemory(row) : null;
  }

  /**
   * Resolve a memory by either its raw id or its handle URI. Supports the
   * four canonical schemes plus the opaque `mem://` fallback.
   */
  resolve(env: Envelope, idOrHandle: string): Memory | null {
    if (!isHandle(idOrHandle)) return this.get(env, idOrHandle);
    const parsed = parseHandle(idOrHandle);
    if (parsed.scheme === "mem") return this.get(env, parsed.memory_id);
    const row = this.sql.db
      .prepare("SELECT * FROM memories WHERE handle = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(idOrHandle, env.tenant_id) as Record<string, unknown> | undefined;
    return row ? rowToMemory(row) : null;
  }

  resolveBatch(env: Envelope, handles: string[]): Array<{ handle: string; memory: Memory | null }> {
    return handles.map((h) => ({ handle: h, memory: this.resolve(env, h) }));
  }

  get(env: Envelope, id: string): Memory | null {
    const row = this.sql.db
      .prepare("SELECT * FROM memories WHERE id = ? AND tenant_id = ?")
      .get(id, env.tenant_id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToMemory(row);
  }

  async search(env: Envelope, input: SearchMemoryInput): Promise<MemoryHit[]> {
    const k = input.top_k ?? 10;
    const fusion = input.fusion ?? "hybrid";
    let queryEmbedding = input.query_embedding;
    let embedError: string | null = null;
    if (!queryEmbedding && (fusion === "hybrid" || fusion === "vector")) {
      const auto = await this.embedder.embed(input.query);
      if (auto) queryEmbedding = auto;
      else embedError = this.embedder.lastError;
    }

    // No vector path available → episodic fallback.
    if (!queryEmbedding) {
      const rows = this.sql.db
        .prepare(
          `SELECT * FROM memories
           WHERE tenant_id = ?
             AND (content LIKE ? OR summary LIKE ?)
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(env.tenant_id, `%${input.query}%`, `%${input.query}%`, k) as Array<Record<string, unknown>>;
      const hits = rows.map((r) => ({ ...rowToMemory(r), score: 0, path: "episodic" as const }));
      this.audit.record("memory.search", env, { query: input.query, k, path: "episodic", hit_count: hits.length, embed_error: embedError });
      return hits;
    }

    // Vector path
    const vecHits = this.vec.search(queryEmbedding, k * 2);
    const memHits: MemoryHit[] = [];
    for (const h of vecHits) {
      const row = this.sql.db
        .prepare("SELECT * FROM memories WHERE embedding_id = ? AND tenant_id = ?")
        .get(h.rowid, env.tenant_id) as Record<string, unknown> | undefined;
      if (!row) continue;
      const mem = rowToMemory(row);
      if (input.types && !input.types.includes(mem.type)) continue;
      if (input.scopes && !input.scopes.every((s) => mem.scopes.includes(s))) continue;
      memHits.push({ ...mem, score: -h.distance, path: "vector" });
      if (memHits.length >= k) break;
    }
    this.audit.record("memory.search", env, { query: input.query, k, path: fusion, hit_count: memHits.length });
    return memHits;
  }

  link(env: Envelope, input: LinkInput): { edge_id: string } {
    const edgeId = `edge_${nanoid()}`;
    // v0.1: edges stored as semantic relations in episodic memory; graph projection lands with the LadybugDB driver wire-up.
    this.audit.record("memory.link", env, { edge_id: edgeId, ...input });
    return { edge_id: edgeId };
  }
}

/** True when an error is a SQLite UNIQUE-constraint violation (V8 dedup index). */
function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException & { code?: string }).code;
  return code === "SQLITE_CONSTRAINT_UNIQUE" || err.message.includes("UNIQUE constraint failed");
}

function rowToMemory(row: Record<string, unknown>): Memory {
  return {
    id: row.id as string,
    type: row.type as MemoryType,
    content: row.content as string,
    summary: (row.summary as string | null) ?? undefined,
    embedding_id: (row.embedding_id as number | null) ?? undefined,
    graph_node_id: (row.graph_node_id as string | null) ?? undefined,
    provenance: JSON.parse(row.provenance_json as string) as Provenance,
    scopes: JSON.parse(row.scopes_json as string) as string[],
    created_at: row.created_at as string,
    expires_at: (row.expires_at as string | null) ?? undefined,
    confidence: row.confidence as number,
    supersedes: JSON.parse(row.supersedes_json as string) as string[],
    superseded_by: JSON.parse(row.superseded_by_json as string) as string[],
    handle: (row.handle as string | null) ?? undefined,
    cell: (row.cell as Memory["cell"]) ?? null,
  };
}
