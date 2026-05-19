import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
  }

  migrate(): void {
    // Two-pass migration: ensure base tables, then apply v2 ALTER (no-op if column exists).
    this.db.exec(MIGRATIONS_V1);
    this.applyV2();
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
