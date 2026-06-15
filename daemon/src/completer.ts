/**
 * Per-call completion budget. `timeoutMs`/`maxRetries` let a CALLER bound an
 * inline (request-path) completion tightly while a background job (miner) keeps
 * a tolerant budget — without two separate Completer instances. `signal` lets
 * the MCP server seam's per-tool deadline cancel an in-flight cloud call.
 */
export interface CompletionOpts {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

/** Per-call completion budget threaded into a Completer.complete(opts) call. */
export interface CompletionBudget {
  timeoutMs: number;
  maxRetries: number;
}

export interface Completer {
  complete(system: string, user: string, opts?: CompletionOpts): Promise<string | null>;
  available(): Promise<boolean>;
  lastError: string | null;
}

export class NullCompleter implements Completer {
  lastError: string | null = "completer disabled";
  async available(): Promise<boolean> { return false; }
  async complete(): Promise<string | null> { return null; }
}
