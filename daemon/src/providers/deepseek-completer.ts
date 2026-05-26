import type { Completer } from "../completer.js";
import { OpenAiTransport } from "./openai-transport.js";

export class DeepSeekCompleter implements Completer {
  lastError: string | null = null;
  private readonly transport: OpenAiTransport;
  private readonly model: string;

  constructor(
    apiKey: string,
    model: string = "deepseek-v4-flash",
    baseUrl: string = "https://api.deepseek.com",
    timeoutMs?: number,
  ) {
    this.model = model;
    this.transport = new OpenAiTransport({ apiKey, baseUrl, timeoutMs });
  }

  async available(): Promise<boolean> {
    return this.transport.healthCheck();
  }

  async complete(
    system: string,
    user: string,
    opts: { maxTokens?: number; temperature?: number } = {},
  ): Promise<string | null> {
    const result = await this.transport.chatCompletion(
      this.model,
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { maxTokens: opts.maxTokens ?? 512, temperature: opts.temperature ?? 0.2 },
    );
    if (!result) {
      this.lastError = this.transport.lastError;
      return null;
    }
    this.lastError = null;
    return result;
  }
}
