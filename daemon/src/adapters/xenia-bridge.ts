/**
 * xenia-bridge — Xenia customer-support squad adapter.
 *
 * Normalizes hearth/progress/events.jsonl events into episodic memories under
 * `domain=customer-support` with explicit cell tags (the squad's trigram
 * manifesto compiled: Kan→risk, Dui→delight, Xun→influence).
 *
 * Layer-4 redaction: event content is PII-scrubbed here before memory.add —
 * the bridge never trusts hook-side redaction alone (Xenia constitution
 * Article IV: no single layer is ever trusted).
 *
 * Escalation events write TWO memories (risk + influence): the crossing
 * itself is danger; the context that crossed is influence. One cell per
 * memory is a schema invariant, so the pair is the faithful encoding.
 */
import type { MemoryEngine } from "../engines/memory.js";
import type { Envelope } from "../schemas/envelope.js";

/** kind -> cell(s); unknown kinds default to influence. */
const CELLS_BY_KIND: Record<string, string[]> = {
  "xenia.ticket_created": ["risk"],
  "xenia.ticket_resolved": ["delight"],
  "xenia.escalated": ["risk", "influence"],
  "xenia.voc_report": ["influence"],
  "xenia.output_written": ["influence"],
};

const PII_PATTERNS: Array<[RegExp, string]> = [
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[EMAIL]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]"],
  [/\b(?:\d[ -]?){13,16}\b/g, "[CARD]"],
  [/\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g, "[PHONE]"],
  [/\b(sk-[a-zA-Z0-9]{20,}|bearer\s+[a-zA-Z0-9._-]{20,})/gi, "[APIKEY]"],
];

function scrubPii(text: string): string {
  let out = text;
  for (const [re, repl] of PII_PATTERNS) out = out.replace(re, repl);
  return out;
}

export class XeniaBridge {
  constructor(private readonly memory: MemoryEngine) {}

  async ingestEvent(project: string, evt: Record<string, unknown>): Promise<void> {
    const kind = String(evt.kind ?? "xenia.event");
    const ts = typeof evt.ts === "string" ? evt.ts : new Date().toISOString();
    const ticket = String(evt.ticket_id ?? "?");
    const severity = String(evt.severity ?? "unknown");
    const category = String(evt.category ?? "general");
    const eventId = String(evt.event_id ?? `noid_${ts}`);
    const cells = CELLS_BY_KIND[kind] ?? ["influence"];

    const env: Envelope = {
      tenant_id: "local",
      actor_id: "xenia-watcher",
      project_id: "xenia",
      domain: "customer-support",
      scope: [
        "project:xenia",
        "domain:customer-support",
        `severity:${severity}`,
        `ticket:${ticket}`,
        `category:${category}`,
        `kind:${kind}`,
        `event:${eventId}`,
      ],
      trace_id: `xenia_${ticket}_${ts}`,
    };

    const content = scrubPii(JSON.stringify(evt, null, 2));
    for (const cell of cells) {
      await this.memory.add(env, {
        type: "episodic",
        content,
        summary: scrubPii(`[xenia ${severity}] ${kind} ${ticket}`),
        scopes: env.scope,
        provenance: { actor: "xenia-bridge", source_uri: "xenia://hearth/progress" },
        confidence: 0.8,
        cell,
      });
    }
  }
}
