import { homedir } from "node:os";
import { join } from "node:path";

export type ProviderName = "ollama" | "openai" | "deepseek" | "authhub";

export interface EightsConfig {
  home: string;             // ~/.eights/
  statePath: string;        // ~/.eights/state.db
  graphPath: string;        // ~/.eights/graph.kuzu/
  eventsDir: string;        // ~/.eights/events/
  logsDir: string;          // ~/.eights/logs/
  resourcesDir: string;     // ~/.eights/resources/
  evolutionDir: string;     // ~/.eights/evolution/
  graphDriver: "ladybug" | "kuzu" | "stub";
  embeddingDim: number;
  provider: ProviderName;
  embedProvider: ProviderName;
  llmProvider: ProviderName;
  allowCloudProviders: boolean;
}

export function loadConfig(): EightsConfig {
  const home = process.env.EIGHTS_HOME ?? join(homedir(), ".eights");
  return {
    home,
    statePath: join(home, "state.db"),
    graphPath: join(home, "graph.kuzu"),
    eventsDir: join(home, "events"),
    logsDir: join(home, "logs"),
    resourcesDir: join(home, "resources"),
    evolutionDir: join(home, "evolution"),
    graphDriver: (process.env.EIGHTS_GRAPH_DRIVER as "ladybug" | "kuzu" | "stub" | undefined) ?? "ladybug",
    embeddingDim: Number(process.env.EIGHTS_EMBEDDING_DIM ?? 768),
    provider: (process.env.EIGHTS_PROVIDER as ProviderName | undefined) ?? "ollama",
    embedProvider: (process.env.EIGHTS_EMBED_PROVIDER ?? process.env.EIGHTS_PROVIDER ?? "ollama") as ProviderName,
    llmProvider: (process.env.EIGHTS_LLM_PROVIDER ?? process.env.EIGHTS_PROVIDER ?? "ollama") as ProviderName,
    allowCloudProviders: process.env.EIGHTS_ALLOW_CLOUD_PROVIDERS === "1",
  };
}
