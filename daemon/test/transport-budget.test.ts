/**
 * OpenAiTransport per-call budget: a degraded provider must fail fast and
 * attributably (inline budget = maxRetries:0) instead of stacking 4×30s into a
 * >120s gateway timeout, and a per-call timeout must abort the in-flight fetch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAiTransport } from "../src/providers/openai-transport.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function hangingFetch(): typeof fetch {
  // Resolves never; rejects with AbortError when the (timeout/external) signal fires.
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }
    })) as unknown as typeof fetch;
}

describe("OpenAiTransport per-call budget", () => {
  it("per-call timeoutMs aborts the fetch and returns null with exactly one attempt (maxRetries:0)", async () => {
    const fetchMock = vi.fn(hangingFetch());
    vi.stubGlobal("fetch", fetchMock);

    const transport = new OpenAiTransport({ apiKey: "sk-test", baseUrl: "https://api.example.test" });
    const t0 = Date.now();
    const result = await transport.chatCompletion("m", [{ role: "user", content: "hi" }], {
      timeoutMs: 50,
      maxRetries: 0,
    });
    const elapsed = Date.now() - t0;

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);     // no retry stacking
    expect(elapsed).toBeLessThan(2_000);            // bounded by the 50ms budget, not 30s×4
  });

  it("per-call maxRetries:0 overrides a permissive ctor default (exactly one attempt)", async () => {
    // fetch rejects immediately (network error) — would normally retry on ctor default.
    const fetchMock = vi.fn((() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch);
    vi.stubGlobal("fetch", fetchMock);

    const transport = new OpenAiTransport({ apiKey: "sk-test", baseUrl: "https://api.example.test", maxRetries: 5 });
    const result = await transport.chatCompletion("m", [{ role: "user", content: "hi" }], { maxRetries: 0 });

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);     // per-call budget wins over ctor maxRetries:5
  });
});
