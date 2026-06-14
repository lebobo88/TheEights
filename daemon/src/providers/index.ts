import { z } from "zod";
import type { Embedder } from "../embeddings.js";
import type { Completer } from "../completer.js";
import { NullEmbedder } from "../embeddings.js";
import { NullCompleter } from "../completer.js";
import { OllamaEmbedder } from "../embeddings.js";
import { OllamaCompleter } from "../engines/eval/completer.js";
import { OpenAiEmbedder } from "./openai-embedder.js";
import { OpenAiCompleter } from "./openai-completer.js";
import { DeepSeekCompleter } from "./deepseek-completer.js";
import { ManualCompleter } from "./manual-completer.js";
import { loadAuthHubEmbedder, loadAuthHubCompleter } from "./authhub-stub.js";
import { homedir } from "node:os";
import { join } from "node:path";

// "manual" is a completion-only provider: a human/agent judge bridge (see
// manual-completer.ts). It is local (no cloud gate) and cannot be an embedder.
const ProviderName = z.enum(["ollama", "openai", "deepseek", "authhub", "manual"]);

const ProviderConfigSchema = z.object({
  provider: ProviderName.default("ollama"),
  embedProvider: ProviderName.default("ollama"),
  llmProvider: ProviderName.default("ollama"),
  allowCloudProviders: z.boolean().default(false),
  llmEnabled: z.boolean().default(false),

  ollamaUrl: z.string().default("http://localhost:11434"),
  ollamaEmbedModel: z.string().default("nomic-embed-text"),
  ollamaEmbedDim: z.coerce.number().int().positive().default(768),
  ollamaLlmModel: z.string().default("gpt-oss:20b"),
  ollamaLlmFallback: z.string().default("qwen3:4b"),

  openaiApiKey: z.string().optional(),
  openaiBaseUrl: z.string().default("https://api.openai.com"),
  openaiEmbedModel: z.string().default("text-embedding-3-small"),
  openaiEmbedDim: z.coerce.number().int().positive().default(1536),
  openaiLlmModel: z.string().default("gpt-4o-mini"),

  deepseekApiKey: z.string().optional(),
  deepseekBaseUrl: z.string().default("https://api.deepseek.com"),
  deepseekLlmModel: z.string().default("deepseek-v4-flash"),

  authhubBaseUrl: z.string().optional(),
  authhubApiKey: z.string().optional(),
  authhubEmbedModel: z.string().default("text-embedding-3-small"),
  authhubEmbedDim: z.coerce.number().int().positive().default(1536),
  authhubLlmModel: z.string().default("gpt-4o-mini"),
  authhubRouteAlias: z.string().optional(),

  // Manual (human/agent) judge bridge — directory of staged verdict files.
  manualJudgeDir: z.string().default(join(homedir(), ".eights", "manual-judge")),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

const CLOUD_PROVIDERS = new Set(["openai", "deepseek", "authhub"]);

export function loadProviderConfig(): ProviderConfig {
  const env = process.env;
  const base = env.EIGHTS_PROVIDER ?? "ollama";

  return ProviderConfigSchema.parse({
    provider: base,
    embedProvider: env.EIGHTS_EMBED_PROVIDER ?? base,
    llmProvider: env.EIGHTS_LLM_PROVIDER ?? base,
    allowCloudProviders: env.EIGHTS_ALLOW_CLOUD_PROVIDERS === "1",
    llmEnabled: env.EIGHTS_LLM_COMPLETIONS === "1",

    ollamaUrl: env.EIGHTS_OLLAMA_URL,
    ollamaEmbedModel: env.EIGHTS_EMBEDDING_MODEL,
    ollamaEmbedDim: env.EIGHTS_EMBEDDING_DIM,
    ollamaLlmModel: env.EIGHTS_LLM_MODEL,
    ollamaLlmFallback: env.EIGHTS_LLM_FALLBACK,

    openaiApiKey: env.EIGHTS_OPENAI_API_KEY,
    openaiBaseUrl: env.EIGHTS_OPENAI_BASE_URL,
    openaiEmbedModel: env.EIGHTS_OPENAI_EMBED_MODEL,
    openaiEmbedDim: env.EIGHTS_OPENAI_EMBED_DIM,
    openaiLlmModel: env.EIGHTS_OPENAI_LLM_MODEL,

    deepseekApiKey: env.EIGHTS_DEEPSEEK_API_KEY,
    deepseekBaseUrl: env.EIGHTS_DEEPSEEK_BASE_URL,
    deepseekLlmModel: env.EIGHTS_DEEPSEEK_LLM_MODEL,

    authhubBaseUrl: env.EIGHTS_AUTHHUB_BASE_URL,
    authhubApiKey: env.EIGHTS_AUTHHUB_API_KEY,
    authhubEmbedModel: env.EIGHTS_AUTHHUB_EMBED_MODEL,
    authhubEmbedDim: env.EIGHTS_AUTHHUB_EMBED_DIM,
    authhubLlmModel: env.EIGHTS_AUTHHUB_LLM_MODEL,
    authhubRouteAlias: env.EIGHTS_AUTHHUB_ROUTE_ALIAS,

    manualJudgeDir: env.EIGHTS_MANUAL_JUDGE_DIR,
  });
}

function requireCloudGate(provider: string, cfg: ProviderConfig): void {
  if (CLOUD_PROVIDERS.has(provider) && !cfg.allowCloudProviders) {
    throw new Error(
      `Provider "${provider}" requires EIGHTS_ALLOW_CLOUD_PROVIDERS=1. ` +
      `Set this env var to acknowledge outbound API traffic.`,
    );
  }
}

export async function createEmbedder(cfg: ProviderConfig): Promise<Embedder> {
  const p = cfg.embedProvider;
  requireCloudGate(p, cfg);

  switch (p) {
    case "ollama":
      return new OllamaEmbedder(cfg.ollamaUrl, cfg.ollamaEmbedModel, cfg.ollamaEmbedDim);

    case "openai": {
      if (!cfg.openaiApiKey) throw new Error("EIGHTS_OPENAI_API_KEY required when EIGHTS_EMBED_PROVIDER=openai");
      return new OpenAiEmbedder(cfg.openaiApiKey, cfg.openaiEmbedModel, cfg.openaiEmbedDim, cfg.openaiBaseUrl);
    }

    case "deepseek":
      return new NullEmbedder(cfg.ollamaEmbedDim);

    case "authhub": {
      if (!cfg.authhubBaseUrl) throw new Error("EIGHTS_AUTHHUB_BASE_URL required when EIGHTS_EMBED_PROVIDER=authhub");
      if (!cfg.authhubApiKey) throw new Error("EIGHTS_AUTHHUB_API_KEY required when EIGHTS_EMBED_PROVIDER=authhub");
      return loadAuthHubEmbedder({
        baseUrl: cfg.authhubBaseUrl,
        apiKey: cfg.authhubApiKey,
        embedModel: cfg.authhubEmbedModel,
        embedDim: cfg.authhubEmbedDim,
        routeAlias: cfg.authhubRouteAlias,
      });
    }

    case "manual":
      throw new Error("provider 'manual' is completion-only (judge bridge); it cannot be used as an embedder");
  }
}

export async function createCompleter(cfg: ProviderConfig): Promise<Completer> {
  if (!cfg.llmEnabled) return new NullCompleter();

  const p = cfg.llmProvider;
  requireCloudGate(p, cfg);

  switch (p) {
    case "manual":
      return new ManualCompleter(cfg.manualJudgeDir);

    case "ollama":
      return new OllamaCompleter(cfg.ollamaUrl, cfg.ollamaLlmModel, cfg.ollamaLlmFallback);

    case "openai": {
      if (!cfg.openaiApiKey) throw new Error("EIGHTS_OPENAI_API_KEY required when EIGHTS_LLM_PROVIDER=openai");
      return new OpenAiCompleter(cfg.openaiApiKey, cfg.openaiLlmModel, cfg.openaiBaseUrl);
    }

    case "deepseek": {
      if (!cfg.deepseekApiKey) throw new Error("EIGHTS_DEEPSEEK_API_KEY required when EIGHTS_LLM_PROVIDER=deepseek");
      return new DeepSeekCompleter(cfg.deepseekApiKey, cfg.deepseekLlmModel, cfg.deepseekBaseUrl);
    }

    case "authhub": {
      if (!cfg.authhubBaseUrl) throw new Error("EIGHTS_AUTHHUB_BASE_URL required when EIGHTS_LLM_PROVIDER=authhub");
      if (!cfg.authhubApiKey) throw new Error("EIGHTS_AUTHHUB_API_KEY required when EIGHTS_LLM_PROVIDER=authhub");
      return loadAuthHubCompleter({
        baseUrl: cfg.authhubBaseUrl,
        apiKey: cfg.authhubApiKey,
        llmModel: cfg.authhubLlmModel,
        routeAlias: cfg.authhubRouteAlias,
      });
    }
  }
}
