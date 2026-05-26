import type { Embedder } from "../embeddings.js";
import { OpenAiTransport } from "./openai-transport.js";

export class OpenAiEmbedder implements Embedder {
  lastError: string | null = null;
  private readonly transport: OpenAiTransport;
  private readonly model: string;
  private readonly dimension: number;

  constructor(
    apiKey: string,
    model: string = "text-embedding-3-small",
    dimension: number = 1536,
    baseUrl: string = "https://api.openai.com",
    timeoutMs?: number,
  ) {
    this.model = model;
    this.dimension = dimension;
    this.transport = new OpenAiTransport({ apiKey, baseUrl, timeoutMs });
  }

  dim(): number { return this.dimension; }

  async available(): Promise<boolean> {
    return this.transport.healthCheck();
  }

  async embed(text: string): Promise<Float32Array | null> {
    const vec = await this.transport.embeddings(this.model, text, this.dimension);
    if (!vec) {
      this.lastError = this.transport.lastError;
      return null;
    }
    if (vec.length !== this.dimension) {
      this.lastError = `dimension mismatch: got ${vec.length}, expected ${this.dimension}`;
      return null;
    }
    this.lastError = null;
    return vec;
  }
}
