/**
 * Local embedding service via Ollama.
 *
 * Default model: nomic-embed-text (768-dim, matches EIGHTS_EMBEDDING_DIM default).
 * If Ollama isn't running, returns null and the caller falls back to episodic-only search.
 *
 * Configure with:
 *   EIGHTS_OLLAMA_URL=http://localhost:11434
 *   EIGHTS_EMBEDDING_MODEL=nomic-embed-text
 */

export interface Embedder {
  embed(text: string): Promise<Float32Array | null>;
  available(): Promise<boolean>;
  dim(): number;
  lastError: string | null;
}

export class OllamaEmbedder implements Embedder {
  private cachedAvailable: boolean | null = null;

  constructor(
    private readonly url: string = process.env.EIGHTS_OLLAMA_URL ?? "http://localhost:11434",
    private readonly model: string = process.env.EIGHTS_EMBEDDING_MODEL ?? "nomic-embed-text",
    private readonly dimension: number = Number(process.env.EIGHTS_EMBEDDING_DIM ?? 768),
  ) {}

  dim(): number { return this.dimension; }

  async available(): Promise<boolean> {
    if (this.cachedAvailable !== null) return this.cachedAvailable;
    try {
      const res = await fetch(`${this.url}/api/tags`, { method: "GET" });
      this.cachedAvailable = res.ok;
    } catch {
      this.cachedAvailable = false;
    }
    return this.cachedAvailable;
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!(await this.available())) return null;
    try {
      const res = await fetch(`${this.url}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.lastError = `Ollama ${res.status}: ${body.slice(0, 200)}`;
        return null;
      }
      const data = await res.json() as { embedding?: number[] };
      if (!data.embedding) {
        this.lastError = "Ollama response missing 'embedding' field";
        return null;
      }
      if (data.embedding.length !== this.dimension) {
        this.lastError = `dimension mismatch: got ${data.embedding.length}, expected ${this.dimension}`;
        return null;
      }
      this.lastError = null;
      return Float32Array.from(data.embedding);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  lastError: string | null = null;
}

export class NullEmbedder implements Embedder {
  lastError: string | null = "embedder disabled";
  constructor(private readonly dimension: number) {}
  dim(): number { return this.dimension; }
  async available(): Promise<boolean> { return false; }
  async embed(): Promise<Float32Array | null> { return null; }
}
