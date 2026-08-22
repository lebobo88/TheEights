import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  // Consumer / sibling repo roots. Default to the directory that contains this
  // TheEights clone (side-by-side layout) so a fresh clone works with zero
  // config; every root is independently overridable via env. These define the
  // writeback sandbox (ADR-0007) and registrar/watcher scan surface.
  siblingsRoot: string;       // parent dir of the clone (base for the others)
  hydraRoot: string;          // Hydra repo root
  ppRoot: string;             // pair-programmer repo root
  execsuiteRoot: string;      // ExecutiveSuite repo root
  execsuiteOutputRoot: string;// ExecutiveSuite output dir watched for memos
  rlmScanRoot: string;        // readdir base for discovering ^RLM* sibling dirs
  rlmStarterRoot: string;     // canonical RLM-CLI-Starter repo root
  claudeRoot: string;         // ~/.claude — pp's second trust root
}

/**
 * Repo root resolved relative to THIS module, so it is correct whether running
 * from built `daemon/dist/config.js` or `tsx`-compiled `daemon/src/config.ts`
 * (both sit two levels under the repo root). Never derived from process.cwd().
 */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]+$/, "");
const fwd = (p: string): string => p.replace(/\\/g, "/");

export function loadConfig(): EightsConfig {
  const home = process.env.EIGHTS_HOME ?? join(homedir(), ".eights");
  const siblingsRoot = fwd(process.env.EIGHTS_SIBLINGS_ROOT ?? dirname(REPO_ROOT));
  const execsuiteRoot = fwd(process.env.EIGHTS_EXECSUITE_ROOT ?? join(siblingsRoot, "ExecutiveSuite"));
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
    siblingsRoot,
    hydraRoot: fwd(process.env.EIGHTS_HYDRA_ROOT ?? join(siblingsRoot, "Hydra")),
    ppRoot: fwd(process.env.EIGHTS_PP_ROOT ?? join(siblingsRoot, "pair-programmer")),
    execsuiteRoot,
    execsuiteOutputRoot: fwd(process.env.EIGHTS_EXEC_OUTPUT_ROOT ?? join(execsuiteRoot, "output")),
    rlmScanRoot: fwd(process.env.EIGHTS_RLM_ROOT ?? siblingsRoot),
    rlmStarterRoot: fwd(process.env.EIGHTS_RLM_STARTER_ROOT ?? join(siblingsRoot, "RLM-CLI-Starter")),
    claudeRoot: fwd(join(homedir(), ".claude")),
  };
}
