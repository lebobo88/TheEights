import { nanoid } from "nanoid";
import type { SqliteStore } from "../stores/sqlite.js";

export class IdentityEngine {
  constructor(private readonly store: SqliteStore) {}

  registerProject(name: string, domain: string, defaultScopes: string[] = []): string {
    const now = new Date().toISOString();
    this.store.db
      .prepare(
        `INSERT OR IGNORE INTO projects(project_id, domain, default_scopes_json, created_at)
         VALUES (?,?,?,?)`,
      )
      .run(name, domain, JSON.stringify(defaultScopes), now);
    return name;
  }

  registerActor(name: string, kind: "agent" | "human" | "system", parentId?: string): string {
    const actorId = name.startsWith("act_") ? name : `act_${nanoid()}_${name}`;
    const now = new Date().toISOString();
    this.store.db
      .prepare(
        `INSERT OR IGNORE INTO actors(actor_id, kind, parent_id, created_at)
         VALUES (?,?,?,?)`,
      )
      .run(actorId, kind, parentId ?? null, now);
    return actorId;
  }
}
