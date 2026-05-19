/**
 * eights-daemon entry point.
 *
 * Phases 0..2 wired: stores, embedder, audit, memory + SSGM gates, identity,
 * governance, pp-watcher. Phases 3..4 wired below the line.
 */
import { loadConfig } from "./config.js";
import { makeLogger } from "./logger.js";
import { SqliteStore } from "./stores/sqlite.js";
import { VectorStore } from "./stores/vec.js";
import { GraphStore } from "./stores/graph.js";
import { AuditEngine } from "./engines/audit.js";
import { MemoryEngine } from "./engines/memory.js";
import { IdentityEngine } from "./engines/identity.js";
import { PolicyEngine } from "./engines/policy.js";
import { EvolutionEngine } from "./engines/evolution.js";
import { PpWatcher } from "./engines/pp-watcher.js";
import { ExecSuiteWatcher } from "./engines/execsuite-watcher.js";
import { RlmWatcher } from "./engines/rlm-watcher.js";
import { Miner } from "./engines/miner.js";
import { BomEngine } from "./engines/bom.js";
import { OllamaEmbedder } from "./embeddings.js";
import { PpBridge } from "./adapters/pp-bridge.js";
import { ExecSuiteBridge } from "./adapters/execsuite-bridge.js";
import { RlmBridge } from "./adapters/rlm-bridge.js";
import { registerMemoryTools } from "./mcp/memory.js";
import { registerIdentityTools } from "./mcp/identity.js";
import { registerAuditTools } from "./mcp/audit.js";
import { registerGovernanceTools } from "./mcp/governance.js";
import { registerEvolutionTools } from "./mcp/evolution.js";
import { registerAdapterTools } from "./mcp/adapters.js";
import { startMcpServer, type ToolMap } from "./mcp/server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = makeLogger(cfg.logsDir);
  log.info({ cfg }, "eights-daemon booting");

  const sql = new SqliteStore(cfg.statePath);
  sql.migrate();

  const vec = new VectorStore(sql.db, cfg.embeddingDim);
  vec.load();

  const graph = new GraphStore(cfg.graphPath, cfg.graphDriver === "stub" ? "ladybug" : cfg.graphDriver);
  if (cfg.graphDriver !== "stub") {
    try {
      await graph.open();
      await graph.ensureSchema();
      log.info({ driver: cfg.graphDriver }, "graph store opened");
    } catch (err) {
      log.warn({ err: String(err) }, "graph store unavailable — degraded mode");
    }
  }

  const audit = new AuditEngine(sql, cfg.eventsDir);
  const chain = audit.verifyChain();
  if (!chain.ok) {
    log.error({ broken_at: chain.broken_at }, "AUDIT CHAIN BROKEN — refusing to start");
    process.exit(2);
  }

  const policy = new PolicyEngine(sql);
  const embedder = new OllamaEmbedder();
  const embedAvailable = await embedder.available();
  log.info({ embedAvailable, dim: embedder.dim() }, embedAvailable
    ? "local embeddings ready (Ollama)"
    : "Ollama unavailable — episodic fallback");

  const memory = new MemoryEngine(sql, vec, graph, audit, embedder, policy);
  const identity = new IdentityEngine(sql);
  identity.registerActor("eights.system", "system");
  identity.registerProject("TheEights", "infra", ["public"]);
  identity.registerProject("pair-programmer", "code", ["public"]);
  identity.registerProject("Hydra", "orchestration", ["public"]);
  identity.registerProject("ExecutiveSuite", "exec", ["public"]);

  const evolution = new EvolutionEngine(sql, cfg.resourcesDir, policy, audit);
  evolution.seedCriticalResources();

  const ppBridge = new PpBridge(memory);
  const ppWatcher = new PpWatcher(sql, ppBridge, log);
  ppWatcher.start();

  const execBridge = new ExecSuiteBridge(memory);
  const execWatcher = new ExecSuiteWatcher(sql, execBridge, log);
  execWatcher.start();

  const rlmBridge = new RlmBridge(memory);
  const rlmWatcher = new RlmWatcher(sql, rlmBridge, log);
  rlmWatcher.start();

  const miner = new Miner(sql, memory, audit, log);
  miner.startScheduled();

  const bom = new BomEngine(sql);

  const tools: ToolMap = {
    ...registerMemoryTools(memory),
    ...registerIdentityTools(identity),
    ...registerAuditTools(audit, sql),
    ...registerGovernanceTools(policy),
    ...registerEvolutionTools(evolution),
    ...registerAdapterTools({ pp: ppWatcher, exec: execWatcher, rlm: rlmWatcher, miner, bom }),
  };
  log.info({ tool_count: Object.keys(tools).length, tools: Object.keys(tools) }, "MCP tools registered");

  const shutdown = async (sig: string): Promise<void> => {
    log.info({ sig }, "shutting down");
    ppWatcher.stop();
    execWatcher.stop();
    rlmWatcher.stop();
    miner.stop();
    try { await graph.close(); } catch { /* ignore */ }
    sql.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await startMcpServer(tools, { name: "eights-daemon", version: "0.2.0" });
  log.info("eights-daemon stdio MCP transport active");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("eights-daemon failed to start:", err);
  process.exit(1);
});
