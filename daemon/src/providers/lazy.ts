import type { Completer, CompletionOpts } from "../completer.js";
import type { Embedder } from "../embeddings.js";

export class LazyEmbedder implements Embedder {
  lastError: string | null = null;
  private inner: Embedder | null = null;
  private initPromise: Promise<Embedder | null> | null = null;

  constructor(
    private readonly expectedDim: number,
    private readonly factory: () => Promise<Embedder>,
  ) {}

  dim(): number {
    return this.expectedDim;
  }

  warm(): Promise<boolean> {
    return this.available();
  }

  async available(): Promise<boolean> {
    const embedder = await this.ensure();
    if (!embedder) return false;
    const ok = await embedder.available();
    this.lastError = embedder.lastError;
    return ok;
  }

  async embed(text: string): Promise<Float32Array | null> {
    const embedder = await this.ensure();
    if (!embedder) return null;
    const vector = await embedder.embed(text);
    this.lastError = embedder.lastError;
    return vector;
  }

  private async ensure(): Promise<Embedder | null> {
    if (this.inner) return this.inner;
    if (!this.initPromise) {
      this.initPromise = this.factory()
        .then((embedder) => {
          if (embedder.dim() !== this.expectedDim) {
            throw new Error(
              `Embedder reports dim=${embedder.dim()} but EIGHTS_EMBEDDING_DIM=${this.expectedDim}. ` +
              `Set EIGHTS_EMBEDDING_DIM=${embedder.dim()} or choose a model that matches.`,
            );
          }
          this.inner = embedder;
          this.lastError = embedder.lastError;
          return embedder;
        })
        .catch((err: unknown) => {
          this.lastError = err instanceof Error ? err.message : String(err);
          return null;
        });
    }
    return this.initPromise;
  }
}

export class LazyCompleter implements Completer {
  lastError: string | null = null;
  private inner: Completer | null = null;
  private initPromise: Promise<Completer | null> | null = null;

  constructor(private readonly factory: () => Promise<Completer>) {}

  warm(): Promise<boolean> {
    return this.available();
  }

  async available(): Promise<boolean> {
    const completer = await this.ensure();
    if (!completer) return false;
    const ok = await completer.available();
    this.lastError = completer.lastError;
    return ok;
  }

  async complete(system: string, user: string, opts?: CompletionOpts): Promise<string | null> {
    const completer = await this.ensure();
    if (!completer) return null;
    const out = await completer.complete(system, user, opts);
    this.lastError = completer.lastError;
    return out;
  }

  private async ensure(): Promise<Completer | null> {
    if (this.inner) return this.inner;
    if (!this.initPromise) {
      this.initPromise = this.factory()
        .then((completer) => {
          this.inner = completer;
          this.lastError = completer.lastError;
          return completer;
        })
        .catch((err: unknown) => {
          this.lastError = err instanceof Error ? err.message : String(err);
          return null;
        });
    }
    return this.initPromise;
  }
}
