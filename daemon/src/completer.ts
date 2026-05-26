export interface Completer {
  complete(system: string, user: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string | null>;
  available(): Promise<boolean>;
  lastError: string | null;
}

export class NullCompleter implements Completer {
  lastError: string | null = "completer disabled";
  async available(): Promise<boolean> { return false; }
  async complete(): Promise<string | null> { return null; }
}
