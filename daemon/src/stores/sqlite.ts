import Database from "better-sqlite3";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** Result of a `PRAGMA wal_checkpoint(<mode>)` — SQLite's three columns. */
export interface CheckpointResult {
  /** 0 if the checkpoint ran; 1 if it was blocked (BUSY) by a reader/writer. */
  busy: number;
  /** Frames in the WAL at checkpoint time (-1 if unavailable). */
  log: number;
  /** Frames moved into the main DB (-1 if unavailable). */
  checkpointed: number;
}

/**
 * Episodic + audit + KV + identity + resources backbone.
 * The same connection also loads sqlite-vec for vector ops (see vec.ts).
 */
export class SqliteStore {
  readonly db: Database.Database;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("foreign_keys = ON");
    // WAL hygiene. Concurrent persistent daemon connections (one per MCP
    // client, by design — see index.ts D2c) can starve SQLite's auto-checkpoint
    // because a reader pinning an old snapshot prevents the WAL from resetting.
    // Left unmanaged the WAL grows without bound (observed at 12.7 GB), and
    // every cold daemon open then has to recover it — blowing past the gateway's
    // 10s connect window. These pragmas + the periodic/shutdown checkpoints in
    // index.ts bound that growth and make reclamation observable.
    //
    //  - busy_timeout: wait for a lock instead of failing BUSY instantly, so a
    //    checkpoint coexists with concurrent readers/writers.
    //  - journal_size_limit: when a checkpoint resets the WAL, truncate the file
    //    back to this cap (256 MB) instead of leaving it at its high-water mark.
    //  - wal_autocheckpoint: checkpoint ~every 1000 pages (~4 MB); explicit so
    //    the default cannot drift.
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_size_limit = 268435456");
    this.db.pragma("wal_autocheckpoint = 1000");
  }

  /**
   * Run a WAL checkpoint and return SQLite's (busy, log, checkpointed) tuple.
   * PASSIVE (default) is non-disruptive: it checkpoints whatever frames it can
   * without blocking readers, and never resets the WAL while a reader holds an
   * old snapshot. TRUNCATE additionally shrinks the -wal file to zero, but only
   * succeeds when no other connection pins the log — use it on shutdown.
   */
  checkpoint(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE"): CheckpointResult {
    const rows = this.db.pragma(`wal_checkpoint(${mode})`) as Array<{
      busy?: number;
      log?: number;
      checkpointed?: number;
    }>;
    const r = rows?.[0] ?? {};
    return {
      busy: r.busy ?? 1,
      log: r.log ?? -1,
      checkpointed: r.checkpointed ?? -1,
    };
  }

  /** Current size of the -wal sidecar in bytes (0 if absent). */
  walSizeBytes(): number {
    try {
      return statSync(`${this.path}-wal`).size;
    } catch {
      return 0;
    }
  }

  migrate(): void {
    this.db.exec(MIGRATIONS_V1);
    this.applyV2();
    this.applyV3();
    this.applyV4();
    this.applyV5();
    this.applyV6();
    this.applyV7();
    this.applyV8();
  }

  /**
   * V8 — memory write idempotency key (anti-bloat).
   *
   * Adapters that re-ingest the same upstream event (e.g. the pp-watcher syncing
   * finalized pair-programmer runs every 5s) must not create a fresh memory row
   * on each pass. A nullable `idempotency_key` + a UNIQUE partial index on
   * (tenant_id, idempotency_key) makes `memory.add` an upsert-by-key no-op when a
   * memory with that key already exists — the structural defense against a
   * watcher re-ingest flood (which had grown `memories` to ~1M duplicate rows).
   *
   * Nullable + partial (WHERE idempotency_key IS NOT NULL) so legacy rows and
   * ad-hoc memories without a key are unaffected and never collide.
   */
  private applyV8(): void {
    const memCols = this.db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
    if (!memCols.some((c) => c.name === "idempotency_key")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN idempotency_key TEXT`);
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_idempotency
        ON memories(tenant_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (8, datetime('now'));
    `);
  }

  /**
   * V4 — verified high-water mark for the audit hash chain.
   *
   * Single-row table (id pinned to 1). `verifyChain` advances {event_id, hash}
   * after a successful pass so subsequent boots only re-verify the tail
   * (event_id > checkpoint.event_id) instead of re-hashing the whole ledger.
   * The on-conflict guard keeps the mark monotonic, so concurrent daemon
   * processes (each MCP client spawns its own) can only ever push it forward.
   */
  private applyV4(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_checkpoint (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        event_id INTEGER NOT NULL,
        hash TEXT NOT NULL,
        verified_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (4, datetime('now'));
    `);
  }

  /**
   * V5 — single-use capability token ledger (replay prevention).
   *
   * When a capability token is accepted, its sig.value is recorded here.
   * A second call with the same sig.value is rejected (replay prevented),
   * even if the token has not yet expired.
   * The consumed_at column enables GC of old entries (future maintenance).
   */
  private applyV5(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consumed_capabilities (
        jti TEXT PRIMARY KEY,        -- sig.value (base64url HMAC) used as one-time key
        consumed_at TEXT NOT NULL,
        op TEXT NOT NULL             -- op label for audit
      );
      CREATE INDEX IF NOT EXISTS idx_consumed_cap_at ON consumed_capabilities(consumed_at);
      INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (5, datetime('now'));
    `);
  }

  /**
   * V6 — WS10: partial index for fast active-proposal dedup lookup.
   * Originally created as non-unique. V7 upgrades it to UNIQUE.
   * This function remains to ensure the schema_version row exists for DBs
   * that have never run V6, before V7 runs the dedup+unique creation.
   *
   * SQLite partial indexes (WHERE clause) are supported since 3.8.0 (2013).
   */
  private applyV6(): void {
    // V7 will handle the actual index creation (UNIQUE); V6 just stamps the version.
    // If V7 has not run yet, V6 creates the non-unique index as a placeholder —
    // V7's DROP+CREATE will atomically replace it with the UNIQUE variant.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_proposals_active_per_resource
        ON proposals(resource_rid)
        WHERE status IN ('pending', 'evaluating');
      INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (6, datetime('now'));
    `);
  }

  /**
   * V7 — WS10 Round 3 (Fix 5): upgrade the partial index to UNIQUE.
   *
   * One-active-proposal-per-resource is a governance invariant: two concurrent
   * reconcile runs must not both create proposals for the same resource.
   * The UNIQUE constraint on (resource_rid) WHERE status IN ('pending','evaluating')
   * enforces this at the DB level; propose() catches SQLITE_CONSTRAINT_UNIQUE and
   * converts it to the typed PROPOSAL_ALREADY_PENDING error code.
   *
   * Migration steps (run inside a transaction to be atomic):
   *   1. Dedup: for each resource_rid that has more than one active proposal,
   *      keep the oldest (MIN(proposal_id) by insertion order / uuid sort).
   *      Mark the rest 'superseded' so they no longer violate the constraint.
   *   2. Drop the old non-unique index.
   *   3. Create the new UNIQUE index.
   *
   * The 'superseded' status is a terminal state: superseded proposals are never
   * committed, approved, or evaluated. The unique constraint only covers
   * ('pending', 'evaluating') — a superseded row does not conflict with a new
   * pending proposal on the same resource.
   *
   * Sequential propose→reject→propose is still supported: after a proposal is
   * rejected (status='rejected'), it leaves the unique constraint scope, and a new
   * pending proposal for the same resource can be created immediately.
   */
  private applyV7(): void {
    // Idempotent: only run if version 7 has not been applied yet.
    const v7Row = this.db.prepare(`SELECT version FROM schema_version WHERE version = 7`).get();
    if (v7Row) return;

    this.db.exec(`BEGIN`);
    try {
      // Step 1: dedup — mark duplicates 'superseded', keeping the oldest per resource_rid.
      // "Oldest" = lowest proposal_id (UUIDs are random but insertion order is a valid tie-break).
      this.db.exec(`
        UPDATE proposals
           SET status = 'superseded'
         WHERE status IN ('pending', 'evaluating')
           AND proposal_id NOT IN (
             SELECT MIN(proposal_id)
               FROM proposals
              WHERE status IN ('pending', 'evaluating')
              GROUP BY resource_rid
           )
      `);

      // Step 2: drop the old non-unique partial index (created in V6).
      this.db.exec(`DROP INDEX IF EXISTS idx_proposals_active_per_resource`);

      // Step 3: recreate as UNIQUE.
      this.db.exec(`
        CREATE UNIQUE INDEX idx_proposals_active_per_resource
          ON proposals(resource_rid)
          WHERE status IN ('pending', 'evaluating')
      `);

      this.db.exec(`
        INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (7, datetime('now'))
      `);
      this.db.exec(`COMMIT`);
    } catch (err) {
      this.db.exec(`ROLLBACK`);
      throw err;
    }
  }

  private applyV3(): void {
    const memCols = this.db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
    if (!memCols.some((c) => c.name === "handle")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN handle TEXT`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_handle ON memories(handle)`);
    }
    if (!memCols.some((c) => c.name === "cell")) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN cell TEXT`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_cell ON memories(cell)`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hydra_envelopes (
        envelope_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        type TEXT NOT NULL,
        origin_squad TEXT,
        target_squad TEXT,
        payload_json TEXT NOT NULL,
        context_refs_json TEXT NOT NULL DEFAULT '[]',
        tenant_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        memory_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hydra_env_workflow ON hydra_envelopes(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_hydra_env_type ON hydra_envelopes(type);
      CREATE INDEX IF NOT EXISTS idx_hydra_env_target ON hydra_envelopes(target_squad);

      CREATE TABLE IF NOT EXISTS governance_ledger (
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,          -- budget|iteration|depth|failure
        delta REAL NOT NULL DEFAULT 0,
        total REAL NOT NULL,
        cap REAL NOT NULL,
        action TEXT NOT NULL,        -- proceed|downgrade|block|trip
        at TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        meta_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_gov_ledger_run ON governance_ledger(run_id);
      CREATE INDEX IF NOT EXISTS idx_gov_ledger_kind ON governance_ledger(kind);

      CREATE TABLE IF NOT EXISTS governance_caps (
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        cap REAL NOT NULL,
        PRIMARY KEY (run_id, kind)
      );

      CREATE TABLE IF NOT EXISTS hitl_queue (
        request_id TEXT PRIMARY KEY,
        run_id TEXT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|expired
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT,
        decision_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hitl_status ON hitl_queue(status);
      CREATE INDEX IF NOT EXISTS idx_hitl_run ON hitl_queue(run_id);

      CREATE TABLE IF NOT EXISTS breaker_state (
        node_id TEXT PRIMARY KEY,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        tripped INTEGER NOT NULL DEFAULT 0,
        tripped_at TEXT,
        last_failure_at TEXT
      );

      INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (3, datetime('now'));
    `);
  }

  private applyV2(): void {
    const cols = this.db.prepare(`PRAGMA table_info(resources)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "consumer")) {
      this.db.exec(`ALTER TABLE resources ADD COLUMN consumer TEXT NOT NULL DEFAULT 'eights'`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resource_sources (
        rid TEXT NOT NULL,
        source_path TEXT NOT NULL,
        consumer TEXT NOT NULL,
        writeback_mode TEXT NOT NULL DEFAULT 'in-place+branch',
        last_written_version TEXT,
        last_written_at TEXT,
        PRIMARY KEY (rid, source_path),
        FOREIGN KEY (rid) REFERENCES resources(rid)
      );
      CREATE INDEX IF NOT EXISTS idx_resource_sources_consumer ON resource_sources(consumer);
      INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (2, datetime('now'));
    `);
  }

  close(): void {
    this.db.close();
  }
}

const MIGRATIONS_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  default_scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actors (
  actor_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,             -- 'agent' | 'human' | 'system'
  parent_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(parent_id) REFERENCES actors(actor_id)
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,             -- working|episodic|semantic|procedural|meta
  content TEXT NOT NULL,
  summary TEXT,
  embedding_id INTEGER,
  graph_node_id TEXT,
  provenance_json TEXT NOT NULL,
  scopes_json TEXT NOT NULL,      -- JSON array
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  supersedes_json TEXT NOT NULL DEFAULT '[]',
  superseded_by_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);

CREATE TABLE IF NOT EXISTS resources (
  rid TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  risk_class TEXT NOT NULL,
  current_version TEXT NOT NULL,
  evolution_policy TEXT NOT NULL,
  audit_url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_versions (
  rid TEXT NOT NULL,
  version TEXT NOT NULL,           -- content hash
  content TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  justification TEXT,
  evidence_memory_ids_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(rid, version),
  FOREIGN KEY(rid) REFERENCES resources(rid)
);

CREATE TABLE IF NOT EXISTS proposals (
  proposal_id TEXT PRIMARY KEY,
  resource_rid TEXT NOT NULL,
  candidate_version TEXT NOT NULL,
  candidate_content TEXT NOT NULL,
  justification TEXT NOT NULL,
  evidence_memory_ids_json TEXT NOT NULL DEFAULT '[]',
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  evaluation_json TEXT,
  decided_at TEXT,
  decided_by TEXT,
  FOREIGN KEY(resource_rid) REFERENCES resources(rid)
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);

-- Append-only event log; hash-chained for tamper evidence.
CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- 'memory.add', 'evolution.commit', ...
  envelope_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL                        -- sha256(prev_hash || ts || kind || envelope || payload)
);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS daemon_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_version(version, applied_at)
VALUES (1, datetime('now'));
`;
