/**
 * eights-daemon entry point — Phase 5.
 *
 * Wires:
 *   - stores (sqlite + sqlite-vec + LadybugDB), audit, memory, identity, policy
 *   - embedder + completer (Ollama)
 *   - evolution engine with WriteRouter (4 WriteBridges) and EvalRegistry (4 adapters)
 *   - 4 watchers + 4 registrars + miner with pattern→proposal pipeline
 *   - 35+ MCP tools across 8 namespaces
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
import { ConstitutionEngine } from "./engines/constitution.js";
import { HydraEngine } from "./engines/hydra.js";
import { GovernanceStateEngine } from "./engines/governance-state.js";
import { RedactionEngine } from "./engines/redaction.js";
import { CellClassifier } from "./cognitive/cell-classifier.js";
import { MemoryStewardJob } from "./cognitive/memory-steward.js";
import { CostAnalystJob } from "./cognitive/cost-analyst.js";
import { IolausJob } from "./cognitive/iolaus.js";
import { PromptRegistrar } from "./engines/registrars/prompts.js";
import { OtelSink } from "./observability/otel-sink.js";
import { OllamaEmbedder } from "./embeddings.js";
import { OllamaCompleter } from "./engines/eval/completer.js";
import { PpBridge } from "./adapters/pp-bridge.js";
import { ExecSuiteBridge } from "./adapters/execsuite-bridge.js";
import { RlmBridge } from "./adapters/rlm-bridge.js";
import { WriteRouter } from "./engines/writeback.js";
import { PpWriteBridge } from "./engines/writers/pp-writer.js";
import { HydraWriteBridge } from "./engines/writers/hydra-writer.js";
import { ExecSuiteWriteBridge } from "./engines/writers/execsuite-writer.js";
import { RlmWriteBridge } from "./engines/writers/rlm-writer.js";
import { PpRegistrar } from "./engines/registrars/pp-registrar.js";
import { HydraRegistrar } from "./engines/registrars/hydra-registrar.js";
import { ExecSuiteRegistrar } from "./engines/registrars/execsuite-registrar.js";
import { RlmRegistrar } from "./engines/registrars/rlm-registrar.js";
import { EvalRegistry } from "./engines/eval/registry.js";
import { LlmJudgeEval } from "./engines/eval/llm-judge.js";
import { YamlStructuralEval } from "./engines/eval/yaml-structural.js";
import { RubricBacktestEval } from "./engines/eval/rubric-backtest.js";
import { NoopEval } from "./engines/eval/noop.js";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { registerMemoryTools } from "./mcp/memory.js";
import { registerIdentityTools } from "./mcp/identity.js";
import { registerAuditTools } from "./mcp/audit.js";
import { registerGovernanceTools } from "./mcp/governance.js";
import { registerEvolutionTools } from "./mcp/evolution.js";
import { registerAdapterTools } from "./mcp/adapters.js";
import { registerConstitutionTools } from "./mcp/constitution.js";
import { registerHydraTools } from "./mcp/hydra.js";
import { registerSquadTools } from "./mcp/squad.js";
import { registerCellTools } from "./mcp/cells.js";
import { registerPromptTools } from "./mcp/prompt.js";
import { startMcpServer, type ToolMap } from "./mcp/server.js";
import type { Envelope } from "./schemas/envelope.js";

/**
 * D2c — write the current PID to ~/.eights/eights.pid as a diagnostic breadcrumb,
 * NOT as a singleton lock.
 *
 * History: D2b introduced a singleton pidfile guard to suppress a dual-spawn
 * race between AgentSmith's EightsBridge child and Claude Code's MCP host
 * (both raced on SqliteStore.migrate + audit.verifyChain). The guard worked
 * for that one symptom but broke every legitimate concurrent spawn: stdio MCP
 * gives every client its own child (Claude Code session, AgentSmith bridge,
 * pair-programmer, etc.), and they are supposed to coexist. The refusal
 * surfaced to the MCP host as -32000 — the child exited cleanly with no
 * transport attached.
 *
 * D2c removes the refusal. SQLite WAL mode already serializes writes safely
 * across concurrent opens, and the audit chain's tamper detection plus the
 * `eights audit:repair` tool provide a forensic recovery path if a write race
 * does manage to break linkage. The pidfile is retained as a diagnostic
 * breadcrumb for operator triage and for the repair tool's snapshot phase.
 */
function recordPidfile(home: string): void {
  const pidPath = join(home, "eights.pid");
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(pidPath, String(process.pid), "utf8");
  } catch (err) {
    process.stderr.write(
      `[eights-daemon] could not write pidfile at ${pidPath}: ${String(err)} — continuing\n`,
    );
  }
}

function clearPidfile(home: string): void {
  const pidPath = join(home, "eights.pid");
  try {
    // Only delete if we still own it (defensive against a race where another
    // instance reclaimed a stale file and stamped its own PID).
    if (existsSync(pidPath)) {
      const raw = readFileSync(pidPath, "utf8").trim();
      if (Number.parseInt(raw, 10) === process.pid) {
        unlinkSync(pidPath);
      }
    }
  } catch {
    // Best-effort; pidfile cleanup must never crash the shutdown path.
  }
}

async function main(): Promise<void> {
  // Stderr boot tag — survives logger failures, lets the operator confirm in
  // Claude Code's MCP error pane that the spawn actually fired. Stderr is safe
  // for stdio MCP transport: only stdout matters for JSON-RPC framing.
  process.stderr.write(`[eights-daemon] booting pid=${process.pid}\n`);

  const cfg = loadConfig();

  // D2c — record this process in the pidfile for diagnostics, but do NOT refuse
  // to start when another instance is alive. Stdio MCP gives every client its
  // own child (Claude Code session, AgentSmith EightsBridge, pair-programmer,
  // etc.); they are supposed to coexist. The earlier singleton guard refused
  // every spawn-after-the-first, which surfaced to the MCP host as -32000 (the
  // child exited cleanly with no transport attached). SQLite WAL mode + the
  // audit chain's hash-linkage already tolerate concurrent appends safely, and
  // the audit-repair tool provides a recovery path if a chain break is ever
  // detected. Singleton-style invariants do not belong in per-client transports.
  recordPidfile(cfg.home);

  const log = makeLogger(cfg.logsDir);
  log.info({ cfg, pid: process.pid }, "eights-daemon booting");

  const sql = new SqliteStore(cfg.statePath);
  sql.migrate();
  const vec = new VectorStore(sql.db, cfg.embeddingDim);
  vec.load();

  const graph = new GraphStore(cfg.graphPath, cfg.graphDriver === "stub" ? "ladybug" : cfg.graphDriver);
  if (cfg.graphDriver !== "stub") {
    try { await graph.open(); await graph.ensureSchema(); log.info({ driver: cfg.graphDriver }, "graph store opened"); }
    catch (err) { log.warn({ err: String(err) }, "graph store unavailable — degraded mode"); }
  }

  const audit = new AuditEngine(sql, cfg.eventsDir);
  const chain = audit.verifyChain();
  if (!chain.ok) {
    // D2b — diagnostics first. The bootstrap session's -32000 was THIS exit
    // path firing under the dual-spawn race (AgentSmith + Claude Code MCP
    // host both spawning, hash chain interleaved). Now that the singleton
    // guard above prevents the race, future spawns will keep the chain
    // intact — but historical damage persists until the operator repairs.
    //
    // EIGHTS_SKIP_AUDIT_CHECK=1 lets the operator boot the daemon despite
    // a broken chain so MCP tools come back online. Audit writes from the
    // current session continue past `broken_at`; forensic repair (chain
    // rebuild from `~/.eights/events/*.jsonl`) is a separate operation.
    log.error({ broken_at: chain.broken_at }, "AUDIT CHAIN BROKEN");
    process.stderr.write(
      `[eights-daemon] AUDIT CHAIN BROKEN at row ${chain.broken_at}. ` +
      `Set EIGHTS_SKIP_AUDIT_CHECK=1 in .mcp.json env to boot anyway.\n`,
    );
    if (process.env.EIGHTS_SKIP_AUDIT_CHECK !== "1") {
      // Throw instead of process.exit(2) so the diagnostic flows through the
      // bottom-of-file `main().catch` handler which writes a useful stderr
      // line + clears the pidfile. Bare process.exit(2) killed the daemon
      // before Claude Code could surface anything other than -32000.
      throw new Error(`AUDIT CHAIN BROKEN at ${chain.broken_at}`);
    }
    process.stderr.write(
      `[eights-daemon] EIGHTS_SKIP_AUDIT_CHECK=1 set — continuing despite broken chain\n`,
    );
    log.warn({ broken_at: chain.broken_at }, "audit chain check skipped per EIGHTS_SKIP_AUDIT_CHECK=1");
  }

  const policy = new PolicyEngine(sql);
  const embedder = new OllamaEmbedder();
  const completer = new OllamaCompleter();
  const embedAvail = await embedder.available();
  const llmEnabled = process.env.EIGHTS_LLM_COMPLETIONS === "1";
  const llmAvail = await completer.available();
  log.info({ embedAvail, llmEnabled, llmAvail }, "local LLM stack probed");

  const memory = new MemoryEngine(sql, vec, graph, audit, embedder, policy);
  const identity = new IdentityEngine(sql);
  identity.registerActor("eights.system", "system");
  for (const p of ["TheEights", "pair-programmer", "Hydra", "ExecutiveSuite"]) {
    identity.registerProject(p, "infra", ["public"]);
  }

  const evolution = new EvolutionEngine(sql, cfg.resourcesDir, policy, audit);

  // Wire WriteRouter with all 4 consumer bridges + sandbox guards.
  const writeRouter = new WriteRouter([
    new PpWriteBridge(),
    new HydraWriteBridge(),
    new ExecSuiteWriteBridge(),
    new RlmWriteBridge(),
  ]);
  evolution.setWriteRouter(writeRouter);

  // Wire EvalRegistry. Order matters — first match wins. YAML structural for team/workflow/schema first
  // (cheap, deterministic), then rubric backtest, then LLM judge for prose, then noop catch-all.
  const evalRegistry = new EvalRegistry();
  evalRegistry.register(new YamlStructuralEval());
  evalRegistry.register(new RubricBacktestEval());
  evalRegistry.register(new LlmJudgeEval(evolution, completer));
  evalRegistry.register(new NoopEval());
  evolution.setEvaluator(evalRegistry);

  evolution.seedCriticalResources();
  seedEvalRubrics(evolution);

  const constitution = new ConstitutionEngine(evolution, audit);
  seedConstitutions(constitution, log);

  const hydraEngine = new HydraEngine(sql, audit, memory);
  const governance = new GovernanceStateEngine(sql, audit);
  const redaction = new RedactionEngine(evolution, policy, audit);
  const classifier = new CellClassifier(completer);

  const otel = new OtelSink(
    { enabled: process.env.EIGHTS_OTEL_ENABLED === "1",
      endpoint: process.env.EIGHTS_OTEL_ENDPOINT ?? "http://localhost:4318/v1/traces",
      service_name: "eights-daemon" },
    log,
  );
  otel.attach(audit);

  const promptRegistrar = new PromptRegistrar(evolution, log);
  promptRegistrar.run({
    tenant_id: "local", actor_id: "eights.system",
    project_id: "TheEights", domain: "infra",
    scope: [], trace_id: "seed-prompts",
  });

  const stewardJob = new MemoryStewardJob(sql, memory, audit, log);
  const costJob = new CostAnalystJob(sql, memory, audit, log);
  const iolausJob = new IolausJob(sql, evolution, memory, audit, log);

  const ppBridge = new PpBridge(memory);
  const ppWatcher = new PpWatcher(sql, ppBridge, log);
  const execBridge = new ExecSuiteBridge(memory);
  const execWatcher = new ExecSuiteWatcher(sql, execBridge, log);
  const rlmBridge = new RlmBridge(memory);
  const rlmWatcher = new RlmWatcher(sql, rlmBridge, log);

  // D2c — escape hatch. EIGHTS_DISABLE_WATCHERS=1 skips all watchers + scheduled
  // jobs entirely. Use when a watcher's consumer DB is wedged or when an
  // operator needs the MCP transport up urgently without the background load.
  const watchersDisabled = process.env.EIGHTS_DISABLE_WATCHERS === "1";
  if (watchersDisabled) {
    log.warn("EIGHTS_DISABLE_WATCHERS=1 — skipping all watchers and scheduled jobs");
  } else {
    stewardJob.start();
    costJob.start();
    iolausJob.start();
    ppWatcher.start();
    execWatcher.start();
    rlmWatcher.start();
  }

  const registrars = {
    pp: new PpRegistrar(evolution, log),
    hydra: new HydraRegistrar(evolution, log),
    exec: new ExecSuiteRegistrar(evolution, log),
    rlm: new RlmRegistrar(evolution, log),
  };

  const miner = new Miner(sql, memory, audit, log, evolution, completer);
  if (!watchersDisabled) miner.startScheduled();

  const bom = new BomEngine(sql);

  const tools: ToolMap = {
    ...registerMemoryTools(memory),
    ...registerIdentityTools(identity),
    ...registerAuditTools(audit, sql),
    ...registerGovernanceTools(policy, governance, redaction),
    ...registerEvolutionTools(evolution),
    ...registerAdapterTools({ pp: ppWatcher, exec: execWatcher, rlm: rlmWatcher, miner, bom, registrars }),
    ...registerConstitutionTools(constitution),
    ...registerHydraTools(hydraEngine),
    ...registerSquadTools(evolution),
    ...registerCellTools(sql, classifier, audit),
    ...registerPromptTools(evolution),
  };
  log.info({ tool_count: Object.keys(tools).length }, "MCP tools registered");

  const shutdown = async (sig: string): Promise<void> => {
    log.info({ sig }, "shutting down");
    ppWatcher.stop(); execWatcher.stop(); rlmWatcher.stop(); miner.stop();
    stewardJob.stop(); costJob.stop(); iolausJob.stop(); otel.stop();
    try { await graph.close(); } catch { /* ignore */ }
    sql.close();
    clearPidfile(cfg.home);  // D2b — release the singleton guard
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await startMcpServer(tools, { name: "eights-daemon", version: "0.3.0" });
  log.info("eights-daemon stdio MCP transport active");
}

/** Seed per-kind judge rubrics as frozen critical resources (ADR-0008, invariant #7). */
function seedEvalRubrics(evolution: EvolutionEngine): void {
  const env: Envelope = {
    tenant_id: "local", actor_id: "eights.system",
    project_id: "TheEights", domain: "infra",
    scope: [], trace_id: "seed-eval-rubrics",
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const rubricsDir = join(here, "engines", "eval", "rubrics");
  for (const kind of ["agent", "skill", "command", "contract", "prompt"]) {
    let body = `# Judge rubric: ${kind}\n\nDefault stub. See ADR-0008.\n`;
    try { body = readFileSync(join(rubricsDir, `${kind}.md`), "utf8"); } catch { /* fall through */ }
    evolution.register(env, {
      rid: `resource:eights.eval-rubric.${kind}`,
      kind: "rubric",
      risk_class: "critical",
      initial_content: body,
    });
  }
}

/**
 * Seed each consumer's Immortal Head. We import from canonical source paths
 * where they exist; if a consumer ships no constitution we fall back to a
 * placeholder so attestation has something to bind to (operators can amend
 * via `eights.constitution.propose_amendment`).
 */
function seedConstitutions(c: ConstitutionEngine, log: ReturnType<typeof makeLogger>): void {
  const env: Envelope = {
    tenant_id: "local", actor_id: "eights.system",
    project_id: "TheEights", domain: "infra",
    scope: [], trace_id: "seed-constitutions",
  };
  const seeds: Array<{ consumer: "hydra" | "pp" | "execsuite" | "rlm"; path: string }> = [
    { consumer: "hydra", path: "C:/AiAppDeployments/Hydra/constitution.md" },
    { consumer: "pp", path: "C:/AiAppDeployments/pair-programmer/constitution.md" },
    { consumer: "execsuite", path: "C:/AiAppDeployments/ExecutiveSuite/constitution.md" },
    { consumer: "rlm", path: "C:/AiAppDeployments/RLM-CLI-Starter/constitution.md" },
  ];
  for (const s of seeds) {
    let content = `# ${s.consumer} constitution (placeholder)\n\nSeeded by TheEights — amend via eights.constitution.propose_amendment.\n`;
    let source: string | undefined = s.path;
    try { content = readFileSync(s.path, "utf8"); } catch { source = undefined; }
    try {
      c.seed(env, s.consumer, content, source);
      log.info({ consumer: s.consumer, sourced_from: source ?? "placeholder" }, "constitution seeded");
    } catch (err) {
      log.warn({ consumer: s.consumer, err: String(err) }, "constitution seed failed");
    }
  }
}

main().catch((err) => {
  // D2b — also release the pidfile so a successor spawn can take over. We
  // re-derive cfg.home from the same env-var resolution loadConfig() uses
  // because at this point we don't know whether loadConfig itself completed.
  try {
    const home = process.env.EIGHTS_HOME ?? join(homedir(), ".eights");
    clearPidfile(home);
  } catch {
    /* ignore */
  }
  // eslint-disable-next-line no-console
  console.error("eights-daemon failed to start:", err);
  process.exit(1);
});
