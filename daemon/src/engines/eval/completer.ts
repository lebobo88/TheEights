/**
 * OllamaCompleter — local-LLM judging companion to OllamaEmbedder.
 *
 * Default model: gpt-oss:20b (already pulled per Phase 1 observation). Falls
 * back to qwen3:4b if the configured model isn't available. Returns null on
 * any error so the eval adapter can default to NoopEval.
 *
 * Configure with:
 *   EIGHTS_OLLAMA_URL
 *   EIGHTS_LLM_MODEL (default: gpt-oss:20b)
 *   EIGHTS_LLM_FALLBACK (default: qwen3:4b)
 */

export type { Completer } from "../../completer.js";
export { NullCompleter } from "../../completer.js";

import type { Completer } from "../../completer.js";

export class OllamaCompleter implements Completer {
  lastError: string | null = null;
  private cachedAvailable: boolean | null = null;
  private models: string[];
  private readonly enabled: boolean;

  constructor(
    private readonly url: string = process.env.EIGHTS_OLLAMA_URL ?? "http://localhost:11434",
    primary: string = process.env.EIGHTS_LLM_MODEL ?? "gpt-oss:20b",
    fallback: string = process.env.EIGHTS_LLM_FALLBACK ?? "qwen3:4b",
  ) {
    this.models = [primary, fallback];
    this.enabled = process.env.EIGHTS_LLM_COMPLETIONS === "1";
  }

  async available(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.cachedAvailable !== null) return this.cachedAvailable;
    try {
      const res = await fetch(`${this.url}/api/tags`);
      this.cachedAvailable = res.ok;
    } catch { this.cachedAvailable = false; }
    return this.cachedAvailable;
  }

  async complete(system: string, user: string, opts: { maxTokens?: number; temperature?: number } = {}): Promise<string | null> {
    if (!(await this.available())) return null;
    for (const model of this.models) {
      try {
        const res = await fetch(`${this.url}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            prompt: user,
            system,
            stream: false,
            options: {
              temperature: opts.temperature ?? 0.2,
              num_predict: opts.maxTokens ?? 512,
            },
          }),
        });
        if (!res.ok) {
          this.lastError = `Ollama ${model} ${res.status}`;
          continue;
        }
        const data = await res.json() as { response?: string };
        if (data.response) { this.lastError = null; return data.response; }
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    return null;
  }
}
