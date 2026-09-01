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
import { XeniaWatcher } from "./engines/xenia-watcher.js";
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
import { AuditVerifierJob, type AuditGate } from "./cognitive/audit-verifier.js";
import { PromptRegistrar } from "./engines/registrars/prompts.js";
import { OtelSink } from "./observability/otel-sink.js";
import { loadProviderConfig, createEmbedder, createCompleter, inlineBudget, backgroundBudget } from "./providers/index.js";
import { PpBridge } from "./adapters/pp-bridge.js";
import { ExecSuiteBridge } from "./adapters/execsuite-bridge.js";
import { RlmBridge } from "./adapters/rlm-bridge.js";
import { XeniaBridge } from "./adapters/xenia-bridge.js";
import { WriteRouter } from "./engines/writeback.js";
import { PpWriteBridge } from "./engines/writers/pp-writer.js";
import { HydraWriteBridge } from "./engines/writers/hydra-writer.js";
import { ExecSuiteWriteBridge } from "./engines/writers/execsuite-writer.js";
import { RlmWriteBridge } from "./engines/writers/rlm-writer.js";
import { PpRegistrar } from "./engines/registrars/pp-registrar.js";
import { HydraRegistrar } from "./engines/registrars/hydra-registrar.js";
import { ExecSuiteRegistrar } from "./engines/registrars/execsuite-registrar.js";
import { RlmRegistrar } from "./engines/registrars/rlm-registrar.js";
import { XeniaRegistrar } from "./engines/registrars/xenia-registrar.js";
import { EvalRegistry } from "./engines/eval/registry.js";
import { LlmJudgeEval } from "./engines/eval/llm-judge.js";
import { YamlStructuralEval } from "./engines/eval/yaml-structural.js";
import { RubricBacktestEval } from "./engines/eval/rubric-backtest.js";
import { PromptDriftEval } from "./engines/eval/prompt-drift.js";
import { NoopEval } from "./engines/eval/noop.js";
import { ManualCompleter } from "./providers/manual-completer.js";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { siblingRoot } from "./paths.js";
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
import { startMcpServer, type ReadinessState, type ToolMap } from "./mcp/server.js";
import { registerHealthTools } from "./mcp/health.js";
import { startTransportThenScheduleBoot } from "./boot-sequencing.js";
import { LazyEmbedder, LazyCompleter } from "./providers/lazy.js";
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
  const vec = new VectorStore(sql.db, cfg.embeddingDim);

  const graph = new GraphStore(cfg.graphPath, cfg.graphDriver === "stub" ? "ladybug" : cfg.graphDriver);

  const audit = new AuditEngine(sql, cfg.eventsDir);

  // Fail-closed readiness gate (D3). The stdio transport comes up BEFORE the
  // hash chain is verified, so the Hydra gateway's connect handshake returns
  // immediately instead of timing out on a large ledger (the chain grew to
  // 600k+ events and the old synchronous full verify took 6–26s, exceeding the
  // gateway's 10s connect timeout — every consumer saw "backend not connected").
  // Until verification passes, every tool call is refused (see mcp/server.ts).
  // The audit engine is never disabled or muted (AGENTS.md hard rule #1): the
  // full chain is still verified, just off the connect critical path. Boot
  // verifies only the tail past the persisted checkpoint; a daily background
  // job re-verifies from genesis (cognitive/audit-verifier.ts).
  let auditReady = false;
  let auditFailed = false;
  let auditReason: string | undefined = "audit verification in progress";
  // Wall-clock origin for `verify_ms_so_far`, so a caller that gets a
  // `not_ready` refusal (or polls `eights.health`) can see how long the gate
  // has been closed rather than guessing whether the daemon is wedged.
  const auditVerifyStartedAt = Date.now();
  const auditGate: AuditGate = {
    pass() {
      auditReady = true;
      auditFailed = false;
      auditReason = undefined;
      log.info({ verify_ms: Date.now() - auditVerifyStartedAt }, "audit readiness gate open");
    },
    fail(reason: string) {
      auditReady = false;
      auditFailed = true;
      auditReason = reason;
    },
  };
  const readinessGate = (): ReadinessState => ({
    ok: auditReady,
    reason: auditReason,
    failed: auditFailed,
    verify_ms_so_far: auditReady ? undefined : Date.now() - auditVerifyStartedAt,
  });

  const policy = new PolicyEngine(sql);
  const providerCfg = loadProviderConfig();
  // Inline = completions awaited DURING an MCP request (cells.classify,
  // evolution.evaluate): tight, no-retry budget. Background = miner: tolerant.
  const inlineLlmBudget = inlineBudget(providerCfg);
  const bgLlmBudget = backgroundBudget(providerCfg);
  const embedder = new LazyEmbedder(cfg.embeddingDim, () => createEmbedder(providerCfg));
  const llmEnabled = providerCfg.llmEnabled;
  const completer = new LazyCompleter(() => createCompleter(providerCfg));

  const memory = new MemoryEngine(sql, vec, graph, audit, embedder, policy);
  const identity = new IdentityEngine(sql);

  const evolution = new EvolutionEngine(sql, cfg.resourcesDir, policy, audit);

  // Wire WriteRouter with all 4 consumer bridges + sandbox guards.
  const writeRouter = new WriteRouter([
    new PpWriteBridge(),
    new HydraWriteBridge(),
    new ExecSuiteWriteBridge(),
    new RlmWriteBridge(),
  ]);
  evolution.setWriteRouter(writeRouter);

  // Wire EvalRegistry. Order matters — adapters are tried in order; one that
  // returns not_applicable falls through to the next. Layering:
  //   1. YamlStructuralEval — deterministic checks for genuine YAML config (team/
  //      workflow/schema/squad); defers prose.
  //   2. RubricBacktestEval — heuristic structural score for rubric kind.
  //   3. PromptDriftEval — diff-aware safety check for registrar source-drift
  //      resyncs; defers genuine prose edits to the quality judge.
  //   4. LlmJudgeEval — quality judge for prose. Judge tier matches stakes:
  //      low/medium risk → fast automated model; high/critical → manual (human/
  //      agent) judge bridge, which fails closed until a verdict is staged.
  //   5. NoopEval — HITL-only-by-design kinds (policy/tool/hook): delta=0.
  const escalationJudge = llmEnabled
    ? { completer: new ManualCompleter(providerCfg.manualJudgeDir), atOrAbove: "high" as const }
    : undefined;
  const evalRegistry = new EvalRegistry();
  evalRegistry.register(new YamlStructuralEval());
  evalRegistry.register(new RubricBacktestEval());
  evalRegistry.register(new PromptDriftEval());
  evalRegistry.register(new LlmJudgeEval(evolution, completer, escalationJudge, inlineLlmBudget));
  evalRegistry.register(new NoopEval());
  evolution.setEvaluator(evalRegistry);

  const constitution = new ConstitutionEngine(evolution, audit);

  const hydraEngine = new HydraEngine(sql, audit, memory);
  const governance = new GovernanceStateEngine(sql, audit);
  // TE-EV-1: wire governance so evolution can create/verify HITL rows for
  // hitl-only proposals without a circular import.
  evolution.setGovernance(governance);
  const redaction = new RedactionEngine(evolution, policy, audit);
  const classifier = new CellClassifier(completer, inlineLlmBudget);

  const otel = new OtelSink(
    { enabled: process.env.EIGHTS_OTEL_ENABLED === "1",
      endpoint: process.env.EIGHTS_OTEL_ENDPOINT ?? "http://localhost:4318/v1/traces",
      service_name: "eights-daemon" },
    log,
  );
  otel.attach(audit);

  const promptRegistrar = new PromptRegistrar(evolution, log);

  const stewardJob = new MemoryStewardJob(sql, memory, audit, log);
  const costJob = new CostAnalystJob(sql, memory, audit, log);
  const iolausJob = new IolausJob(sql, evolution, memory, audit, log);

  const ppBridge = new PpBridge(memory);
  const ppWatcher = new PpWatcher(sql, ppBridge, log);
  const execBridge = new ExecSuiteBridge(memory);
  const execWatcher = new ExecSuiteWatcher(sql, execBridge, log);
  const rlmBridge = new RlmBridge(memory);
  const rlmWatcher = new RlmWatcher(sql, rlmBridge, log);
  const xeniaBridge = new XeniaBridge(memory);
  const xeniaWatcher = new XeniaWatcher(sql, xeniaBridge, log);

  // D2c — escape hatch. EIGHTS_DISABLE_WATCHERS=1 skips all watchers + scheduled
  // jobs entirely. Use when a watcher's consumer DB is wedged or when an
  // operator needs the MCP transport up urgently without the background load.
  const watchersDisabled = process.env.EIGHTS_DISABLE_WATCHERS === "1";
  if (watchersDisabled) {
    log.warn("EIGHTS_DISABLE_WATCHERS=1 — skipping all watchers and scheduled jobs");
  }
  // Background work (watchers, scheduled jobs, miner) is deferred until the
  // audit chain verifies — see startBackgroundWork() below. These jobs write
  // audited events, so none may run on an unverified chain.

  const registrars = {
    pp: new PpRegistrar(evolution, log),
    hydra: new HydraRegistrar(evolution, log),
    exec: new ExecSuiteRegistrar(evolution, log),
    rlm: new RlmRegistrar(evolution, log),
    xenia: new XeniaRegistrar(evolution, log),
  };

  const miner = new Miner(sql, memory, audit, log, evolution, completer, { budget: bgLlmBudget });

  const bom = new BomEngine(sql);

  // Daily full re-verification of the chain (catches tamper of rows already
  // covered by the boot checkpoint). Flips the gate fail-closed on failure.
  const auditVerifier = new AuditVerifierJob(audit, auditGate, log);

  // Starts every audited background producer. Invoked only after the chain
  // verifies (or the operator override is set), never on a broken chain.
  const startBackgroundWork = (): void => {
    if (watchersDisabled) return;
    stewardJob.start();
    costJob.start();
    iolausJob.start();
    ppWatcher.start();
    execWatcher.start();
    rlmWatcher.start();
    xeniaWatcher.start();
    miner.startScheduled();
    auditVerifier.start();
  };

  const warmProviders = (): void => {
    void (async () => {
      const [embedAvail, llmAvail] = await Promise.all([
        embedder.warm(),
        completer.warm(),
      ]);
      log.info({
        embedProvider: providerCfg.embedProvider,
        llmProvider: providerCfg.llmProvider,
        embedAvail,
        llmEnabled,
        llmAvail,
      }, "LLM stack probed");
    })().catch((err: unknown) => {
      log.warn({ err: String(err) }, "LLM stack probe failed");
    });
  };

  const bootstrapAuditedRuntime = async (): Promise<void> => {
    sql.migrate();
    vec.load();

    if (cfg.graphDriver !== "stub") {
      try {
        await graph.open();
        await graph.ensureSchema();
        log.info({ driver: cfg.graphDriver }, "graph store opened");
      } catch (err) {
        log.warn({ err: String(err) }, "graph store unavailable — degraded mode");
      }
    }

    identity.registerActor("eights.system", "system");

    // Register (or promote) the operator actor as kind='human' so capability token
    // checks pass. EIGHTS_OPERATOR_ACTOR_ID defaults to "eights.operator".
    // UPSERT — not INSERT OR IGNORE — so a pre-existing row with kind != 'human'
    // (e.g. 'agent' seeded by an older daemon version) is corrected to 'human'.
    // Without the DO UPDATE a pre-existing non-human row would remain and brick
    // every operator capability check.
    const operatorActorId = process.env["EIGHTS_OPERATOR_ACTOR_ID"] ?? "eights.operator";
    sql.db.prepare(
      `INSERT INTO actors(actor_id, kind, created_at) VALUES (?, 'human', datetime('now'))
       ON CONFLICT(actor_id) DO UPDATE SET kind = 'human'`,
    ).run(operatorActorId);

    for (const p of ["TheEights", "pair-programmer", "Hydra", "ExecutiveSuite", "xenia"]) {
      identity.registerProject(p, "infra", ["public"]);
    }

    evolution.seedCriticalResources();
    seedEvalRubrics(evolution);
    seedConstitutions(constitution, log);
    promptRegistrar.run({
      tenant_id: "local", actor_id: "eights.system",
      project_id: "TheEights", domain: "infra",
      scope: [], trace_id: "seed-prompts",
    });

    // Verify the chain off the connect critical path, then open the gate and
    // start the audited background producers. Tools stay fail-closed until this
    // resolves successfully (or the operator override is set).
    const result = await audit.verifyChain();
    if (result.ok) {
      auditGate.pass();
      log.info("audit chain verified");
      startBackgroundWork();
    } else if (process.env.EIGHTS_SKIP_AUDIT_CHECK === "1") {
      auditGate.pass();
      process.stderr.write(
        `[eights-daemon] EIGHTS_SKIP_AUDIT_CHECK=1 set — continuing despite broken chain\n`,
      );
      log.warn({ broken_at: result.broken_at }, "audit chain check skipped per EIGHTS_SKIP_AUDIT_CHECK=1");
      startBackgroundWork();
    } else {
      // Fail-closed: transport stays up for diagnostics, but every tool is
      // refused and no audited background producer starts.
      auditGate.fail(`AUDIT CHAIN BROKEN at ${result.broken_at}`);
      log.error({ broken_at: result.broken_at }, "AUDIT CHAIN BROKEN — tools fail-closed");
      process.stderr.write(
        `[eights-daemon] AUDIT CHAIN BROKEN at row ${result.broken_at}. ` +
        `Tools are refused. Set EIGHTS_SKIP_AUDIT_CHECK=1 in .mcp.json env to boot anyway.\n`,
      );
    }
  };

  const tools: ToolMap = {
    ...registerMemoryTools(memory),
    ...registerIdentityTools(identity),
    ...registerAuditTools(audit, sql),
    ...registerGovernanceTools(policy, governance, redaction),
    ...registerEvolutionTools(evolution),
    ...registerAdapterTools({ pp: ppWatcher, exec: execWatcher, rlm: rlmWatcher, xenia: xeniaWatcher, miner, bom, registrars }),
    ...registerConstitutionTools(constitution),
    ...registerHydraTools(hydraEngine),
    ...registerSquadTools(evolution),
    ...registerCellTools(sql, classifier, audit),
    ...registerPromptTools(evolution),
    // Ungated — see mcp/health.ts. Must stay last so it cannot be shadowed.
    ...registerHealthTools(readinessGate),
  };
  log.info({ tool_count: Object.keys(tools).length }, "MCP tools registered");

  // Periodic WAL maintenance. A PASSIVE checkpoint is non-disruptive (it never
  // blocks a reader and only flushes the frames it can), so running it in every
  // daemon is safe and keeps the WAL from drifting up between auto-checkpoints.
  // The return tuple + WAL size are logged so checkpoint starvation (busy=1,
  // WAL not shrinking) is visible to operators instead of silently ballooning.
  let checkpointTimer: NodeJS.Timeout | null = null;
  // D2 — periodic process memory/CPU gauge. Time-correlating these lines with the
  // server seam's slow-call warns is the evidence for whether eights latency
  // spikes track host RSS pressure (external WSL2/Ollama thrash) rather than
  // eights's own work. Set EIGHTS_MEM_GAUGE_MS=0 to disable.
  let memGaugeTimer: NodeJS.Timeout | null = null;
  const MEM_GAUGE_INTERVAL_MS = Number(process.env.EIGHTS_MEM_GAUGE_MS ?? 60_000);
  let lastCpu = process.cpuUsage();
  const runMemGauge = (): void => {
    const m = process.memoryUsage();
    const cpu = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    log.info(
      { rss: m.rss, heap_used: m.heapUsed, external: m.external,
        cpu_user_us: cpu.user, cpu_system_us: cpu.system },
      "proc gauge",
    );
  };
  const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
  const runMaintenanceCheckpoint = (mode: "PASSIVE" | "TRUNCATE"): void => {
    try {
      const before = sql.walSizeBytes();
      const r = sql.checkpoint(mode);
      log.info(
        { mode, busy: r.busy, log_frames: r.log, checkpointed: r.checkpointed,
          wal_bytes_before: before, wal_bytes_after: sql.walSizeBytes() },
        "wal checkpoint",
      );
    } catch (err) {
      log.warn({ err: String(err), mode }, "wal checkpoint failed");
    }
  };

  const shutdown = async (sig: string): Promise<void> => {
    log.info({ sig }, "shutting down");
    if (checkpointTimer) { clearInterval(checkpointTimer); checkpointTimer = null; }
    if (memGaugeTimer) { clearInterval(memGaugeTimer); memGaugeTimer = null; }
    ppWatcher.stop(); execWatcher.stop(); rlmWatcher.stop(); xeniaWatcher.stop(); miner.stop();
    stewardJob.stop(); costJob.stop(); iolausJob.stop(); auditVerifier.stop(); otel.stop();
    try { await graph.close(); } catch { /* ignore */ }
    // Best-effort TRUNCATE on the way out: shrinks the -wal file to zero when no
    // sibling daemon still pins the log. Never block shutdown on it.
    runMaintenanceCheckpoint("TRUNCATE");
    sql.close();
    clearPidfile(cfg.home);  // D2b — release the singleton guard
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Transport up FIRST — answers the gateway's initialize handshake in <1s.
  await startTransportThenScheduleBoot({
    startTransport: () => startMcpServer(tools, {
      name: "eights-daemon",
      version: "0.3.0",
      ready: readinessGate,
      log,
      // Fire before the Hydra gateway's ~120s per-call timeout so an opaque
      // gateway timeout becomes a fast, attributable "tool_deadline_exceeded".
      deadlineMs: Number(process.env.EIGHTS_TOOL_DEADLINE_MS ?? 90_000),
      slowWarnMs: Number(process.env.EIGHTS_TOOL_SLOW_WARN_MS ?? 2_000),
    }),
    warmProviders,
    bootstrap: bootstrapAuditedRuntime,
    onBootstrapError: (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      auditGate.fail(`daemon bootstrap failed: ${message}`);
      log.error({ err: message }, "daemon bootstrap failed — tools remain fail-closed");
      process.stderr.write(`[eights-daemon] bootstrap failed: ${message}. Tools are refused.\n`);
    },
  });
  log.info("eights-daemon stdio MCP transport active");

  // Start WAL maintenance once the transport is live (off the connect path).
  // unref() so the timer never holds the process open on its own.
  checkpointTimer = setInterval(() => runMaintenanceCheckpoint("PASSIVE"), CHECKPOINT_INTERVAL_MS);
  checkpointTimer.unref?.();

  if (MEM_GAUGE_INTERVAL_MS > 0) {
    memGaugeTimer = setInterval(runMemGauge, MEM_GAUGE_INTERVAL_MS);
    memGaugeTimer.unref?.();
  }
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
  const seeds: Array<{ consumer: "hydra" | "pp" | "execsuite" | "rlm" | "agentsmith"; path: string }> = [
    { consumer: "hydra", path: join(siblingRoot("Hydra"), "constitution.md") },
    { consumer: "pp", path: join(siblingRoot("pair-programmer"), "constitution.md") },
    { consumer: "execsuite", path: join(siblingRoot("ExecutiveSuite"), "constitution.md") },
    // Sibling dir is RLM-Creative (RLM-CLI-Starter was a stale name).
    { consumer: "rlm", path: join(siblingRoot("RLM-Creative"), "constitution.md") },
    // AgentSmith attests its OWN constitution (smith-constitution.md) under this slot.
    // siblingRoot reads AgentSmith's actual file so eights' content_hash aligns
    // byte-for-byte with AgentSmith's local sha256 (both use raw utf8, no normalization).
    { consumer: "agentsmith", path: join(siblingRoot("AgentSmith"), "daemon", "src", "constitution", "smith-constitution.md") },
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
