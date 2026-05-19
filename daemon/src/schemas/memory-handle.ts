/**
 * MemoryHandle — URI-style addressing for memory refs per Hydra manifesto.
 *
 * Schemes:
 *   ep://wf/<workflow_id>/<task_id>/<seq>    episodic, scoped to a workflow
 *   sem://<index>/<doc_id>                   semantic, vector-indexed
 *   proc://<resource_id>/<version>           procedural (frozen prompt/spec)
 *   meta://<actor_id>/<key>                  meta facts about an actor
 *   mem://<memory_id>                        opaque-fallback to raw memory id
 *
 * Handles are deterministic from their parts so two writers producing the
 * same logical address converge on the same key without coordination.
 */
import { z } from "zod";

export type HandleScheme = "ep" | "sem" | "proc" | "meta" | "mem";

export interface EpisodicHandle { scheme: "ep"; workflow_id: string; task_id: string; seq: number }
export interface SemanticHandle { scheme: "sem"; index: string; doc_id: string }
export interface ProceduralHandle { scheme: "proc"; resource_id: string; version: string }
export interface MetaHandle { scheme: "meta"; actor_id: string; key: string }
export interface OpaqueHandle { scheme: "mem"; memory_id: string }

export type ParsedHandle =
  | EpisodicHandle
  | SemanticHandle
  | ProceduralHandle
  | MetaHandle
  | OpaqueHandle;

const HANDLE_RE = /^(ep|sem|proc|meta|mem):\/\/(.+)$/;

export const MemoryHandle = z.string().regex(HANDLE_RE, "not a memory handle URI");

export function parseHandle(uri: string): ParsedHandle {
  const m = HANDLE_RE.exec(uri);
  if (!m || !m[1] || !m[2]) throw new Error(`invalid memory handle: ${uri}`);
  const scheme = m[1] as HandleScheme;
  const rest: string = m[2];
  switch (scheme) {
    case "ep": {
      const [wfTag, workflow_id, task_id, seqStr] = rest.split("/");
      if (wfTag !== "wf" || !workflow_id || !task_id || !seqStr) {
        throw new Error(`malformed ep:// handle: ${uri}`);
      }
      const seq = Number.parseInt(seqStr, 10);
      if (!Number.isFinite(seq)) throw new Error(`ep:// seq must be int: ${uri}`);
      return { scheme: "ep", workflow_id, task_id, seq };
    }
    case "sem": {
      const idx = rest.indexOf("/");
      if (idx < 0) throw new Error(`malformed sem:// handle: ${uri}`);
      return { scheme: "sem", index: rest.slice(0, idx), doc_id: rest.slice(idx + 1) };
    }
    case "proc": {
      const idx = rest.lastIndexOf("/");
      if (idx < 0) throw new Error(`malformed proc:// handle: ${uri}`);
      return { scheme: "proc", resource_id: rest.slice(0, idx), version: rest.slice(idx + 1) };
    }
    case "meta": {
      const idx = rest.indexOf("/");
      if (idx < 0) throw new Error(`malformed meta:// handle: ${uri}`);
      return { scheme: "meta", actor_id: rest.slice(0, idx), key: rest.slice(idx + 1) };
    }
    case "mem":
      return { scheme: "mem", memory_id: rest };
  }
}

export function isHandle(s: string): boolean {
  return HANDLE_RE.test(s);
}

export function formatEpisodic(workflow_id: string, task_id: string, seq: number): string {
  return `ep://wf/${workflow_id}/${task_id}/${seq}`;
}

export function formatSemantic(index: string, doc_id: string): string {
  return `sem://${index}/${doc_id}`;
}

export function formatProcedural(resource_id: string, version: string): string {
  return `proc://${resource_id}/${version}`;
}

export function formatMeta(actor_id: string, key: string): string {
  return `meta://${actor_id}/${key}`;
}

export function formatOpaque(memory_id: string): string {
  return `mem://${memory_id}`;
}

/**
 * Heuristic handle assignment given a memory write. Used when the caller
 * hasn't supplied an explicit handle (most callers won't). Episodic memories
 * tied to a run_id+actor become ep://; semantic memories with a source_uri
 * become sem://; everything else falls back to mem://.
 */
export function deriveHandle(input: {
  memory_id: string;
  type: "working" | "episodic" | "semantic" | "procedural" | "meta";
  provenance: { run_id?: string; actor: string; source_uri?: string };
}): string {
  if (input.type === "episodic" && input.provenance.run_id) {
    return formatEpisodic(input.provenance.run_id, input.provenance.actor, seqFromMemId(input.memory_id));
  }
  if (input.type === "semantic" && input.provenance.source_uri) {
    return formatSemantic("default", input.memory_id);
  }
  if (input.type === "meta") {
    return formatMeta(input.provenance.actor, input.memory_id);
  }
  return formatOpaque(input.memory_id);
}

function seqFromMemId(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % 1_000_000;
}
