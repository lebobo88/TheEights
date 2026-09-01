/**
 * Shared helpers for consumer registrars.
 */
import { readdirSync, statSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, basename, extname, resolve } from "node:path";
import { contentHash, type EvolutionEngine } from "../evolution.js";
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

/**
 * Walk a directory tree, yielding absolute paths whose basename matches `predicate`.
 *
 * E2-12: `Dirent.isDirectory()` is false for a symlink, so a consumer laid out with
 * symlinked sub-trees (Hydra's `marketing-*` squads point into MarketBliss) was never
 * descended into. Symlinked entries are resolved with `statSync` and classified as the
 * directory/file they point at; a broken link is skipped. Cycles are guarded with a set
 * of `realpathSync` results so a self-referential link cannot loop forever.
 */
export function walk(root: string, predicate: (absPath: string) => boolean, depth = 6): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visited = new Set<string>();
  /** Record a directory's real path; returns false if it was already walked. */
  const claim = (p: string): boolean => {
    let real: string;
    try { real = realpathSync(p); } catch { return false; }
    if (visited.has(real)) return false;
    visited.add(real);
    return true;
  };
  if (!claim(root)) return [];
  const stack: Array<{ dir: string; d: number }> = [{ dir: root, d: 0 }];
  while (stack.length) {
    const { dir, d } = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = statSync(p); // follows the link
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // broken link
        }
      }
      if (isDir) {
        if (d < depth && !shouldSkipDir(e.name) && claim(p)) stack.push({ dir: p, d: d + 1 });
      } else if (isFile && predicate(p)) {
        out.push(p);
      }
    }
  }
  return out;
}

function shouldSkipDir(name: string): boolean {
  return name === "node_modules" || name === ".git" || name === "dist" || name === ".next" || name === "__pycache__";
}

const RISK_SEVERITY: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export interface RegisterFileOutcome {
  kind: "registered" | "updated" | "skipped";
  reason?: string;
  rid: string;
  /** Set when the registrar's default risk_class was superseded by a more severe stored class. */
  risk_class_deferred?: RiskClass;
}

export function registerFile(
  engine: EvolutionEngine,
  env: Envelope,
  spec: RegisterFileSpec,
): RegisterFileOutcome {
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
  //
  // E2-12: a registrar's `risk_class` is an implicit default derived from a slug list,
  // never an explicit operator request to change severity. When the store already holds
  // a MORE severe class, defer to the stored one instead of asking evolution.register()
  // for a downgrade — that request is (correctly) rejected, which otherwise turned every
  // re-scan of such a resource into a permanent hard error. An explicit downgrade
  // requested through evolution.register() directly is still rejected there.
  const storedSeverity = RISK_SEVERITY[existing.risk_class] ?? -1;
  const requestedSeverity = RISK_SEVERITY[spec.risk_class] ?? -1;
  const effectiveRisk = storedSeverity > requestedSeverity ? existing.risk_class : spec.risk_class;
  const riskDeferred = effectiveRisk !== spec.risk_class ? effectiveRisk : undefined;
  engine.register(env, {
    rid: spec.rid,
    kind: spec.kind,
    risk_class: effectiveRisk,
    initial_content: content,
    consumer: spec.consumer,
    source_paths: [resolve(spec.source_path)],
    writeback_mode: spec.writeback_mode,
  });
  // E2-12: a frozen resource can never be imported. When the source is byte-identical to
  // the stored current version there is nothing to import, so report it as skipped rather
  // than letting importFromSource throw. A frozen resource whose content HAS drifted still
  // falls through to the existing error/HITL behaviour below.
  if (existing.evolution_policy === "frozen" && contentHash(content) === existing.current_version) {
    return { kind: "skipped", reason: "frozen, unchanged", rid: spec.rid, risk_class_deferred: riskDeferred };
  }
  // If the on-disk content has changed since last import, treat the disk as authoritative
  // and import as a new version. This keeps the registry in sync with the consumer repo.
  // Note: this bypasses the proposal flow — used only at registration / re-scan time
  // when the operator explicitly asks us to ingest the current state of the consumer.
  const onDiskMatches = existing.versions.some((v) => v.content === content);
  if (!onDiskMatches) {
    engine.importFromSource(env, spec.rid, content, "registrar re-scan: source file changed");
    return { kind: "updated", rid: spec.rid, risk_class_deferred: riskDeferred };
  }
  return { kind: "skipped", reason: "unchanged", rid: spec.rid, risk_class_deferred: riskDeferred };
}

export function basenameNoExt(p: string): string {
  return basename(p, extname(p));
}

export function existsDir(p: string): boolean {
  try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
}
