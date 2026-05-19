/**
 * Shared helpers for consumer registrars.
 */
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, basename, extname, resolve } from "node:path";
import type { EvolutionEngine } from "../evolution.js";
import type { Envelope } from "../../schemas/envelope.js";
import type { Consumer, ResourceKind, RiskClass, WritebackMode } from "../../schemas/resource.js";

export interface RegistrationResult {
  consumer: Consumer;
  registered: number;
  updated: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
}

export interface RegisterFileSpec {
  source_path: string;
  kind: ResourceKind;
  risk_class: RiskClass;
  consumer: Consumer;
  rid: string;
  writeback_mode?: WritebackMode;
}

/** Walk a directory tree, yielding absolute paths whose basename matches `predicate`. */
export function walk(root: string, predicate: (absPath: string) => boolean, depth = 6): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack: Array<{ dir: string; d: number }> = [{ dir: root, d: 0 }];
  while (stack.length) {
    const { dir, d } = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (d < depth && !shouldSkipDir(e.name)) stack.push({ dir: p, d: d + 1 });
      } else if (e.isFile() && predicate(p)) {
        out.push(p);
      }
    }
  }
  return out;
}

function shouldSkipDir(name: string): boolean {
  return name === "node_modules" || name === ".git" || name === "dist" || name === ".next" || name === "__pycache__";
}

export function registerFile(
  engine: EvolutionEngine,
  env: Envelope,
  spec: RegisterFileSpec,
): { kind: "registered" | "updated" | "skipped"; reason?: string; rid: string } {
  let content: string;
  try {
    content = readFileSync(spec.source_path, "utf8");
  } catch (err) {
    return { kind: "skipped", reason: `read failed: ${(err as Error).message}`, rid: spec.rid };
  }
  const existing = engine.getResource(spec.rid);
  if (!existing) {
    engine.register(env, {
      rid: spec.rid,
      kind: spec.kind,
      risk_class: spec.risk_class,
      initial_content: content,
      consumer: spec.consumer,
      source_paths: [resolve(spec.source_path)],
      writeback_mode: spec.writeback_mode,
    });
    return { kind: "registered", rid: spec.rid };
  }
  // Already registered. Idempotently ensure the source path is attached.
  engine.register(env, {
    rid: spec.rid,
    kind: spec.kind,
    risk_class: spec.risk_class,
    initial_content: content,
    consumer: spec.consumer,
    source_paths: [resolve(spec.source_path)],
    writeback_mode: spec.writeback_mode,
  });
  // If the on-disk content has changed since last import, treat the disk as authoritative
  // and import as a new version. This keeps the registry in sync with the consumer repo.
  // Note: this bypasses the proposal flow — used only at registration / re-scan time
  // when the operator explicitly asks us to ingest the current state of the consumer.
  const onDiskMatches = existing.versions.some((v) => v.content === content);
  if (!onDiskMatches) {
    engine.importFromSource(env, spec.rid, content, "registrar re-scan: source file changed");
    return { kind: "updated", rid: spec.rid };
  }
  return { kind: "skipped", reason: "unchanged", rid: spec.rid };
}

export function basenameNoExt(p: string): string {
  return basename(p, extname(p));
}

export function existsDir(p: string): boolean {
  try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
}
