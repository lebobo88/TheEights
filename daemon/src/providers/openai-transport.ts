/**
 * Shared OpenAI-compatible HTTP transport used by OpenAI, DeepSeek, and any
 * other provider whose API shape matches the OpenAI v1 surface.
 *
 * Handles auth, retry with exponential backoff, timeout, error redaction,
 * and HTTPS-only enforcement for non-loopback hosts.
 */
import { combineTimeout } from "../abort-util.js";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const SECRET_PATTERN = /\b(sk-[A-Za-z0-9_-]{10,}|ak_[A-Za-z0-9_-]{10,})\b/g;

function redact(text: string): string {
  return text.replace(SECRET_PATTERN, "[REDACTED]");
}

export interface OpenAiTransportConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  maxRetries?: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
  model?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
}

export class OpenAiTransport {
  lastError: string | null = null;
  private cachedHealthy: boolean | null = null;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(cfg: OpenAiTransportConfig) {
    this.apiKey = cfg.apiKey;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
    this.maxRetries = cfg.maxRetries ?? 3;
    this.validateUrl(this.baseUrl);
  }

  private validateUrl(url: string): void {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new Error(`Invalid provider base URL: ${redact(url)}`); }
    if (parsed.protocol !== "https:" && !LOCALHOST_HOSTS.has(parsed.hostname)) {
      throw new Error(
        `Provider base URL must use HTTPS for non-localhost hosts (got ${parsed.protocol}//${parsed.hostname})`,
      );
    }
  }

  async healthCheck(): Promise<boolean> {
    if (this.cachedHealthy !== null) return this.cachedHealthy;
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        method: "GET",
        headers: this.headers(),
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 10_000)),
      });
      this.cachedHealthy = res.ok;
    } catch {
      this.cachedHealthy = false;
    }
    return this.cachedHealthy;
  }

  async embeddings(
    model: string,
    input: string,
    dimensions?: number,
  ): Promise<Float32Array | null> {
    const body: Record<string, unknown> = { model, input };
    if (dimensions != null) body.dimensions = dimensions;

    const data = await this.post<EmbeddingResponse>("/v1/embeddings", body);
    if (!data) return null;

    const vec = data.data?.[0]?.embedding;
    if (!vec || !Array.isArray(vec)) {
      this.lastError = "Response missing embedding data";
      return null;
    }
    this.lastError = null;
    return Float32Array.from(vec);
  }

  async chatCompletion(
    model: string,
    messages: ChatMessage[],
    opts: { maxTokens?: number; temperature?: number; timeoutMs?: number; maxRetries?: number; signal?: AbortSignal } = {},
  ): Promise<string | null> {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };
    if (opts.temperature != null) body.temperature = opts.temperature;
    if (opts.maxTokens != null) body.max_completion_tokens = opts.maxTokens;

    const data = await this.post<ChatCompletionResponse>("/v1/chat/completions", body, {
      timeoutMs: opts.timeoutMs,
      maxRetries: opts.maxRetries,
      signal: opts.signal,
    });
    if (!data) return null;

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      this.lastError = "Response missing completion content";
      return null;
    }
    this.lastError = null;
    return content;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
    };
  }

  private async post<T>(
    path: string,
    body: unknown,
    opts: { timeoutMs?: number; maxRetries?: number; signal?: AbortSignal } = {},
  ): Promise<T | null> {
    // Per-call budget overrides the ctor defaults. Inline (request-path) callers
    // pass a tight timeout + maxRetries:0 so a degraded provider fails fast and
    // attributably instead of stacking 4×30s into a >120s gateway timeout.
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const maxRetries = opts.maxRetries ?? this.maxRetries;
    let lastErr: string | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Honor an external (request-deadline) abort between attempts.
      if (opts.signal?.aborted) { this.lastError = "aborted"; return null; }
      if (attempt > 0) {
        const delayMs = 1000 * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delayMs));
      }

      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: combineTimeout(timeoutMs, opts.signal),
        });

        if (!res.ok) {
          const snippet = await res.text().catch(() => "");
          lastErr = redact(`HTTP ${res.status}: ${snippet.slice(0, 200)}`);
          if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) continue;
          this.lastError = lastErr;
          return null;
        }

        const data = await res.json() as T;
        return data;
      } catch (err) {
        lastErr = redact(err instanceof Error ? err.message : String(err));
        if (attempt < maxRetries) continue;
      }
    }

    this.lastError = lastErr;
    return null;
  }
}
