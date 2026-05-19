/**
 * execsuite-bridge — ExecutiveSuite adapter.
 *
 * Ingests Markdown decision memos from `<project>/output/<domain>/<topic>-YYYY-MM-DD.md`
 * as episodic memories with Decision / Assumption / Dissent / Outcome scope tags.
 *
 * Phase 4 v1: file-level ingestion + naive section parser. Structured entity
 * extraction (LLM-backed) lives behind the Memory Steward in Phase 4+.
 */
import type { MemoryEngine } from "../engines/memory.js";
import type { Envelope } from "../schemas/envelope.js";

export interface ExecMemo {
  domain: string;
  path: string;
  filename: string;
  body: string;
}

export class ExecSuiteBridge {
  constructor(private readonly memory: MemoryEngine) {}

  async ingestMemo(memo: ExecMemo): Promise<void> {
    const env: Envelope = {
      tenant_id: "local",
      actor_id: "execsuite-watcher",
      project_id: "ExecutiveSuite",
      domain: `exec.${memo.domain}`,
      scope: [`project:ExecutiveSuite`, `domain:exec`, `exec.domain:${memo.domain}`, `path:${memo.path}`],
      trace_id: `exec_${memo.filename}`,
    };

    const sections = splitSections(memo.body);
    const summary = (sections.summary ?? memo.body).slice(0, 280);
    await this.memory.add(env, {
      type: "episodic",
      content: memo.body,
      summary,
      scopes: env.scope,
      provenance: { actor: "execsuite-bridge", source_uri: `file://${memo.path}` },
      confidence: 0.85,
    });

    // Surface known executive-suite primitives as semantic memories so the
    // graph layer has nodes to link to.
    for (const a of sections.assumptions) {
      await this.memory.add(env, {
        type: "semantic",
        content: a,
        summary: a.slice(0, 200),
        scopes: [...env.scope, "type:Assumption"],
        provenance: { actor: "execsuite-bridge" },
        confidence: 0.7,
      });
    }
    for (const d of sections.dissents) {
      await this.memory.add(env, {
        type: "semantic",
        content: d,
        summary: d.slice(0, 200),
        scopes: [...env.scope, "type:Dissent"],
        provenance: { actor: "execsuite-bridge" },
        confidence: 0.75,
      });
    }
  }
}

function splitSections(md: string): { summary?: string; assumptions: string[]; dissents: string[] } {
  const lines = md.split(/\r?\n/);
  let summary: string | undefined;
  const assumptions: string[] = [];
  const dissents: string[] = [];
  let current: "summary" | "assumptions" | "dissents" | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (!current || !buf.length) { buf = []; return; }
    const text = buf.join("\n").trim();
    if (!text) { buf = []; return; }
    if (current === "summary") summary = text;
    else if (current === "assumptions") splitBullets(text).forEach((b) => assumptions.push(b));
    else if (current === "dissents") splitBullets(text).forEach((b) => dissents.push(b));
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (m && m[1]) {
      flush();
      const h = m[1].toLowerCase();
      if (/(summary|tl;dr|abstract)/.test(h)) current = "summary";
      else if (/assumption/.test(h)) current = "assumptions";
      else if (/(dissent|minority|objection)/.test(h)) current = "dissents";
      else current = null;
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return { summary, assumptions, dissents };
}

function splitBullets(text: string): string[] {
  return text
    .split(/\n(?=[-*]\s+)/)
    .map((b) => b.replace(/^[-*]\s+/, "").trim())
    .filter((b) => b.length > 0);
}
