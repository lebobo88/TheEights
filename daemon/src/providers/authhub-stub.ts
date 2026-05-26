/**
 * AuthHub provider stub — committed to the repo. The real implementations
 * live in ./local/authhub-embedder.ts and ./local/authhub-completer.ts,
 * which are gitignored and excluded from tsconfig. When those files are
 * absent, dynamic import falls back to NullEmbedder / NullCompleter.
 */
import type { Embedder } from "../embeddings.js";
import type { Completer } from "../completer.js";
import { NullEmbedder } from "../embeddings.js";
import { NullCompleter } from "../completer.js";

export interface AuthHubProviderConfig {
  baseUrl: string;
  apiKey: string;
  embedModel?: string;
  embedDim?: number;
  llmModel?: string;
  routeAlias?: string;
}

export async function loadAuthHubEmbedder(cfg: AuthHubProviderConfig): Promise<Embedder> {
  try {
    // Dynamic path prevents tsc from resolving into the gitignored local/ dir
    const path = "./local/authhub-embedder.js";
    const mod = await (import(path) as Promise<{
      createAuthHubEmbedder: (cfg: AuthHubProviderConfig) => Embedder;
    }>);
    return mod.createAuthHubEmbedder(cfg);
  } catch {
    return new NullEmbedder(cfg.embedDim ?? 1536);
  }
}

export async function loadAuthHubCompleter(cfg: AuthHubProviderConfig): Promise<Completer> {
  try {
    const path = "./local/authhub-completer.js";
    const mod = await (import(path) as Promise<{
      createAuthHubCompleter: (cfg: AuthHubProviderConfig) => Completer;
    }>);
    return mod.createAuthHubCompleter(cfg);
  } catch {
    return new NullCompleter();
  }
}
