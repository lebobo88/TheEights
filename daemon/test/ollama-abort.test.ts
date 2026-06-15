/**
 * The Ollama embedder + completer use bare fetch; without an AbortSignal a
 * wedged local model server would hang an MCP call forever. These assert the
 * EIGHTS_OLLAMA_TIMEOUT_MS bound: a hung Ollama returns null + sets lastError
 * (callers then degrade to episodic-only search / NoopEval) instead of hanging.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { OllamaEmbedder } from "../src/embeddings.js";
import { OllamaCompleter } from "../src/engines/eval/completer.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** /api/tags resolves ok (available); the work endpoint hangs until its signal aborts. */
function routedFetch(): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    if (String(url).includes("/api/tags")) {
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    }
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }
    });
  }) as unknown as typeof fetch;
}

describe("Ollama abort bounds", () => {
  it("OllamaEmbedder.embed returns null + lastError when the fetch is aborted by the timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(routedFetch()));
    const embedder = new OllamaEmbedder("http://localhost:11434", "nomic-embed-text", 768, 50);
    const t0 = Date.now();
    const out = await embedder.embed("hello");
    expect(out).toBeNull();
    expect(embedder.lastError).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("OllamaCompleter.complete returns null when the fetch is aborted by the timeout", async () => {
    const prev = process.env.EIGHTS_LLM_COMPLETIONS;
    process.env.EIGHTS_LLM_COMPLETIONS = "1"; // completer is gated on this
    try {
      vi.stubGlobal("fetch", vi.fn(routedFetch()));
      const completer = new OllamaCompleter("http://localhost:11434", "qwen3:4b", "qwen3:4b", 50);
      const t0 = Date.now();
      const out = await completer.complete("sys", "user", {});
      expect(out).toBeNull();
      // two models tried, each bounded by the 50ms timeout
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      if (prev === undefined) delete process.env.EIGHTS_LLM_COMPLETIONS;
      else process.env.EIGHTS_LLM_COMPLETIONS = prev;
    }
  });
});
