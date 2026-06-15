/**
 * Abort helpers shared by the provider transports (cloud + Ollama).
 *
 * `combineTimeout` builds a per-attempt AbortSignal that fires when EITHER a
 * fixed timeout elapses OR an externally-supplied signal (e.g. the MCP server
 * seam's per-tool deadline) aborts. This is what lets a slow/hung provider call
 * be cancelled both by its own budget and by the request deadline, so no single
 * MCP tool call can hang past the gateway's 120s ceiling.
 */

/** AbortSignal that fires after `timeoutMs`, OR when `external` aborts. */
export function combineTimeout(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return timeout;
  // AbortSignal.any landed in Node 20.3; prefer it when present.
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn([timeout, external]);
  // Fallback for older runtimes: manually fan-in both signals.
  const ac = new AbortController();
  const abort = (): void => ac.abort();
  if (external.aborted || timeout.aborted) ac.abort();
  else {
    external.addEventListener("abort", abort, { once: true });
    timeout.addEventListener("abort", abort, { once: true });
  }
  return ac.signal;
}
