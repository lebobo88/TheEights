/**
 * CellClassifier — assigns the 8-cell tag (Vision/Context/Triggers/Influence/
 * Risk/Focus/Constraints/Delight) to a memory body. Keyword-first (fast,
 * deterministic, no LLM round-trip); falls back to the local completer when
 * keywords are ambiguous and a completer is available. No outbound HTTP.
 *
 * Manifesto-aligned cell vocabulary (I Ching trigram mapping):
 *   vision      — long-horizon intent, north-star, strategy
 *   context     — environmental facts, surrounding state
 *   triggers    — events, prompts, catalysts that initiated action
 *   influence   — stakeholders, dependencies, persuasion paths
 *   risk        — threats, compliance, liabilities, failure modes
 *   focus       — current priority, what to ignore
 *   constraints — budgets, deadlines, technical limits, contracts
 *   delight     — emotional/aesthetic/UX value, brand voice
 */
import type { Cell } from "../schemas/memory.js";
import type { Completer } from "../engines/eval/completer.js";
import type { CompletionBudget } from "../completer.js";

const KEYWORDS: Record<Cell, RegExp> = {
  vision:      /\b(vision|mission|north[- ]?star|long[- ]?term|strategy|objective|aspirat|charter|covenant|constitution)\b/i,
  context:     /\b(context|background|current state|baseline|environment|history|status quo|situation)\b/i,
  triggers:    /\b(trigger|event|incident|catalyst|fired|reported|escalat|paged|alert)\b/i,
  influence:   /\b(stakeholder|sponsor|approver|customer|user|persuad|alignment|coalition|champion|owner)\b/i,
  risk:        /\b(risk|threat|vulnerab|liabilit|compliance|GDPR|HIPAA|SOC2|failure mode|exposure|attack|breach|legal|regulator)\b/i,
  focus:       /\b(focus|priorit|in[- ]?scope|out[- ]?of[- ]?scope|now|next|do not|defer|ignore)\b/i,
  constraints: /\b(budget|deadline|SLA|SLO|quota|cap|limit|contract|dependency|locked in|must use|cannot|window)\b/i,
  delight:     /\b(delight|love|beauty|brand|voice|polish|craft|tone|UX|surprise|magic|elegant)\b/i,
};

export class CellClassifier {
  constructor(
    private readonly completer?: Completer,
    private readonly budget?: CompletionBudget,
  ) {}

  classify(text: string, summary?: string): Cell | null {
    const corpus = `${summary ?? ""}\n${text}`.slice(0, 8_000);
    const hits = new Map<Cell, number>();
    for (const [cell, re] of Object.entries(KEYWORDS) as Array<[Cell, RegExp]>) {
      const m = corpus.match(new RegExp(re.source, "gi"));
      if (m) hits.set(cell, m.length);
    }
    if (hits.size === 0) return null;
    let best: Cell | null = null;
    let bestN = 0;
    for (const [c, n] of hits.entries()) if (n > bestN) { best = c; bestN = n; }
    // If the leader is clearly ahead (≥2× runner-up), commit. Otherwise return
    // it as a best-guess; the caller can override.
    return best;
  }

  async classifyAsync(text: string, summary?: string, signal?: AbortSignal): Promise<Cell | null> {
    const sync = this.classify(text, summary);
    if (sync) return sync;
    if (!this.completer) return null;
    const ok = await this.completer.available();
    if (!ok) return null;
    const out = await this.completer.complete(
      "You are a classifier. Return exactly one token from this list and nothing else: vision context triggers influence risk focus constraints delight",
      `Classify the cell of this text:\n\n${(summary ?? text).slice(0, 2_000)}`,
      { maxTokens: 8, temperature: 0, timeoutMs: this.budget?.timeoutMs, maxRetries: this.budget?.maxRetries, signal },
    );
    if (!out) return null;
    const token = out.trim().toLowerCase().split(/\s+/)[0] ?? "";
    const cells: Cell[] = ["vision","context","triggers","influence","risk","focus","constraints","delight"];
    return (cells as string[]).includes(token) ? (token as Cell) : null;
  }
}
