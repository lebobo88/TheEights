/* TheEights — Agent-BOM Atlas: the entire codebase as a graph.
   Sourced from ARCHITECTURE.md §10 (repo layout), §4/§5 (data model + MCP surface),
   §12 (invariants), README (consumers, providers) and the audit-growth report. */

(function () {
  const G = {
    core:      { label: 'Substrate',      color: 'var(--c-core)',   ang: 0,     dist: 0 },
    consumer:  { label: 'Consumers',      color: 'var(--c-cons)',   ang: -90,   dist: 360 },
    hub:       { label: 'Subsystems',     color: 'var(--c-hub)',    ang: 0,     dist: 205 },
    mcp:       { label: 'MCP namespaces', color: 'var(--c-mcp)',    ang: -30,   dist: 340 },
    tool:      { label: 'MCP tools',      color: 'var(--c-tool)',   ang: -30,   dist: 470 },
    engine:    { label: 'Core engines',   color: 'var(--c-eng)',    ang: 28,    dist: 340 },
    cognitive: { label: 'Cognitive svc',  color: 'var(--c-cog)',    ang: 80,    dist: 330 },
    store:     { label: 'Storage',        color: 'var(--c-store)',  ang: 120,   dist: 330 },
    adapter:   { label: 'Adapters',       color: 'var(--c-adapt)',  ang: -130,  dist: 330 },
    provider:  { label: 'Providers',      color: 'var(--c-prov)',   ang: 165,   dist: 340 },
    schema:    { label: 'Schemas',        color: 'var(--c-schema)', ang: -165,  dist: 330 },
    memory:    { label: 'Memory model',   color: 'var(--c-mem)',    ang: 150,   dist: 205 },
    cell:      { label: 'Eight Cells',    color: 'var(--c-cell)',   ang: 128,   dist: 150 },
    bom:       { label: 'Agent-BOM nodes',color: 'var(--c-bom)',    ang: 100,   dist: 195 },
    resource:  { label: 'Resources',      color: 'var(--c-res)',    ang: 45,    dist: 205 },
    proposal:  { label: 'Proposals · HITL',color:'var(--c-prop)',   ang: 78,    dist: 400 },
    gov:       { label: 'Governance',     color: 'var(--c-gov)',    ang: -55,   dist: 190 },
    invariant: { label: 'Hard invariants',color: 'var(--c-inv)',    ang: -90,   dist: 225 },
    frozen:    { label: 'Frozen roster',  color: 'var(--c-frozen)', ang: -68,   dist: 295 },
    envelope:  { label: 'Hydra envelopes',color: 'var(--c-env)',    ang: 58,    dist: 258 },
    runtime:   { label: 'Daemon runtime', color: 'var(--c-rt)',     ang: 188,   dist: 250 },
    cli:       { label: 'CLI',            color: 'var(--c-cli)',    ang: 210,   dist: 400 },
    adr:       { label: 'ADRs',           color: 'var(--c-adr)',    ang: 0,     dist: 480 },
  };

  const nodes = [];
  const links = [];
  const N = (id, label, group, r, desc, extra = {}) =>
    nodes.push(Object.assign({ id, label, group, r, desc }, extra));
  const L = (s, t, rel = '') => links.push({ s, t, rel });

  /* ---------- CORE ---------- */
  N('core', 'TheEights', 'core', 30,
    'The local-first daemon + MCP server. Sits below every consumer and owns shared memory, governance and gated self-evolution. Substrate, not orchestrator.',
    { path: 'daemon/src/index.ts', meta: 'eights-daemon v0.3.0 · MCP stdio' });

  /* ---------- CONSUMERS ---------- */
  const consumers = [
    ['pp', 'pair-programmer', 18, '39 sub-agents · 22 teams · taxonomy gates + judges. pp-watcher mirrors every attempt into eights memory.', '59 resources · 96% of ledger'],
    ['hydra', 'Hydra', 14, 'LangGraph multi-squad supervisor. Constitution attestation at intake, envelope recording, budget enforcement.', '8 squads · envelope store'],
    ['execsuite', 'ExecutiveSuite', 13, '20 C-suite roles + 4 multi-exec orchestrators. Decision memos → Agent-BOM graph.', '42 governed resources'],
    ['rlm', 'RLM-Creative', 14, '9-phase creative pipeline across 14+ sibling projects. events.jsonl normalized into episodic memory.', '1,175 governed resources'],
    ['marketbliss', 'MarketBliss', 11, '15 specialist marketing agents across 5 Hydra squad packs. Evolution-governed brand-voice + persona resources.', '5 squad packs'],
    ['agentsmith', 'AgentSmith', 12, 'Meta-governance antibody. Detects drift and proposes evolutions but cannot commit — TheEights holds the verdict.', 'proposes · cannot commit'],
  ];
  consumers.forEach(([id, label, r, desc, meta]) => {
    N('cons-' + id, label, 'consumer', r, desc, { meta });
    L('cons-' + id, 'core', 'consumer');
  });

  /* ---------- SUBSYSTEM HUBS ---------- */
  const hubs = [
    ['hub-mcp', 'MCP Surface', '65 tools across 12 namespaces — the only thing agents touch.', 'daemon/src/mcp/'],
    ['hub-eng', 'Core Engines', '18 engines: memory, evolution, policy, audit, governance, identity, constitution, redaction, hydra, BOM, miner, writers, watchers, eval.', 'daemon/src/engines/'],
    ['hub-cog', 'Cognitive Services', 'LLM-backed periodic jobs: consolidation, cost analysis, episode synthesis, cell classification.', 'daemon/src/cognitive/'],
    ['hub-store', 'Storage Drivers', 'Three access paths, one logical store — all embedded, no external services.', 'daemon/src/stores/'],
    ['hub-adapt', 'Adapters', 'Per-consumer bridges translating each system\'s events into MCP calls.', 'daemon/src/adapters/'],
    ['hub-prov', 'Providers', 'Embedder + Completer factory. Ollama local by default; cloud opt-in.', 'daemon/src/providers/'],
    ['hub-schema', 'Schemas', 'Zod runtime + JSON-Schema export for every MCP tool I/O.', 'daemon/src/schemas/'],
  ];
  hubs.forEach(([id, label, desc, path]) => {
    N(id, label, 'hub', 14, desc, { path });
    L('core', id, 'subsystem');
  });

  /* ---------- MCP NAMESPACES + TOOLS ---------- */
  const ns = {
    memory:       ['add', 'search', 'get', 'link', 'resolve', 'resolve_batch'],
    governance:   ['policy.evaluate', 'consistency_check', 'access.check', 'redact', 'redact_for_squad', 'budget.charge', 'cap.set', 'ceiling.tick', 'hitl.request', 'hitl.resolve', 'hitl.list', 'breaker.status', 'breaker.outcome', 'breaker.reset'],
    evolution:    ['register', 'get_resource', 'list_resources', 'propose', 'evaluate', 'commit', 'approve', 'reject', 'rollback', 'unfreeze', 'list_pending', 'detect_drift'],
    audit:        ['trace', 'bom', 'verify'],
    constitution: ['get', 'attest', 'propose_amendment'],
    identity:     ['register_actor', 'register_project'],
    hydra:        ['envelope.record', 'envelope.query', 'handoff.list'],
    squad:        ['list', 'get'],
    cells:        ['classify', 'distribution', 'query'],
    prompt:       ['list', 'get', 'diff'],
    adapters:     ['pp.start', 'pp.sync_now', 'exec.sync_now', 'rlm.sync_now', 'hydra.register_now'],
    miner:        ['run_now'],
  };
  const nsDesc = {
    memory: 'Hybrid memory CRUD with the handle scheme (ep:// sem:// proc:// meta://).',
    governance: 'Policy enforcement, budget control, circuit breaking, squad-scoped redaction.',
    evolution: 'Gated resource modification — RSPL/SEPL propose→evaluate→commit|queue.',
    audit: 'Tamper-evident trace + CycloneDX ML-BOM v1.7 export + chain verify.',
    constitution: 'Immutable governance head; hash-chained attestation receipts.',
    identity: 'Actor and project registry — every envelope binds here.',
    hydra: 'Cross-squad envelope store for Hydra workflows.',
    squad: 'Squad metadata — squads are resources, not raw YAML.',
    cells: 'Eight Cells semantic axis: classify / distribution / query.',
    prompt: 'Cross-consumer agent prompt registry + versioning + diff.',
    adapters: 'Consumer adapter lifecycle control (start/stop/sync/register).',
    miner: 'Trigger cross-project pattern mining.',
  };
  Object.entries(ns).forEach(([name, tools]) => {
    N('ns-' + name, 'eights.' + name, 'mcp', 9, nsDesc[name], { path: 'daemon/src/mcp/' + name + '.ts', meta: tools.length + ' tools' });
    L('hub-mcp', 'ns-' + name, 'mcp');
    tools.forEach(t => {
      const tid = 'tool-' + name + '-' + t;
      N(tid, t, 'tool', 3.4, name + '.' + t, { meta: 'eights.' + name + '.' + t });
      L('ns-' + name, tid, 'tool');
    });
  });

  /* ---------- CORE ENGINES ---------- */
  const engines = [
    ['memory', 'Memory Engine', 'Hybrid write/read across vec + graph + SQLite. Hierarchical Memory Orchestrator (cache → hot → archive).'],
    ['evolution', 'Evolution Engine', 'Autogenesis RSPL/SEPL — versioned resources, signing, proposal routing by risk_class, drift detection.'],
    ['policy', 'Policy Engine', 'Pure-function SSGM + LASM evaluator. Deterministic; never calls an LLM.'],
    ['audit', 'Audit Engine', 'Append-only .jsonl event log + graph projection. Tamper-evident running hash chain.'],
    ['governance-state', 'Governance State', 'Durable budget ledger, loop ceilings, 3-strike circuit breaker, HITL queue.'],
    ['identity', 'Identity Engine', 'Tenant / actor / project registration. Every envelope validated here.'],
    ['constitution', 'Constitution Engine', 'Versioning + hash-chained attestation binding workflow runs to a constitution hash.'],
    ['redaction', 'Redaction Engine', 'Scope-aware redaction; squad-scoped payload stripping + PII patterns.'],
    ['hydra', 'Hydra Engine', 'HydraEnvelope native ingest with semantic indexing + cross-squad queries.'],
    ['bom', 'BOM Engine', 'CycloneDX ML-BOM v1.7 export — 1,288 components.'],
    ['miner', 'Pattern Miner', 'Hourly cross-project scan: rubric failures ≥3 / 30d, missability clusters ≥2 / 30d.'],
    ['git-writer', 'Git Writer', 'Signed, content-addressed resource commits.'],
    ['writeback', 'WriteRouter', 'Dispatches sandbox-enforced writeback to the theeights/auto branch.'],
    ['pp-watcher', 'pp Watcher', 'Polls ~/.pair-programmer/state.db every 5s, mirrors attempts as memory.add — drives 96% of the ledger.'],
    ['execsuite-watcher', 'ExecSuite Watcher', 'Decision memos → episodic memory + Agent-BOM Decision/Assumption/Outcome nodes.'],
    ['rlm-watcher', 'RLM Watcher', 'Tails each RLM project\'s events.jsonl; normalizes into episodic memory.'],
    ['registrars', 'Registrars', 'Four bulk resource scanners — pp / hydra / execsuite / rlm registrars register prompts, teams and squads.'],
    ['writers', 'WriteBridges', 'Four sandbox-enforced WriteBridges, path-contained to each consumer root (ADR-0007, invariant #6).'],
    ['eval', 'Eval Adapters', 'Four judge adapters — llm-judge, yaml-structural, rubric-backtest, noop — run inside evolution.evaluate.'],
  ];
  engines.forEach(([id, label, desc]) => {
    const r = ['memory', 'evolution', 'audit', 'policy'].includes(id) ? 9 : 6.5;
    N('eng-' + id, label, 'engine', r, desc, { path: 'daemon/src/engines/' + id + '.ts' });
    L('hub-eng', 'eng-' + id, 'engine');
  });
  // engine ↔ store wiring
  L('eng-memory', 'store-vec', 'reads'); L('eng-memory', 'store-graph', 'reads'); L('eng-memory', 'store-sqlite', 'reads');
  L('eng-audit', 'store-eventlog', 'writes'); L('eng-audit', 'store-sqlite', 'writes');
  L('eng-bom', 'store-graph', 'reads'); L('eng-evolution', 'eng-policy', 'governs');
  L('eng-evolution', 'git-writer-x', ''); // placeholder removed below

  /* ---------- COGNITIVE SERVICES ---------- */
  const cog = [
    ['memory-steward', 'Memory Steward', 'Decides what gets written, when to consolidate, when to decay. 6h cadence + inline on memory.add.'],
    ['cost-analyst', 'Cost Analyst', 'Token/latency analysis; daily burn memo; proposes model-routing changes.'],
    ['iolaus', 'Iolaus', 'Hydra episode synthesis + calibration — the manifesto\'s daily "Cauterizer" deprecation sweep.'],
    ['cell-classifier', 'Cell Classifier', 'Keyword-first 8-cell classifier with optional local-Ollama fallback.'],
  ];
  cog.forEach(([id, label, desc]) => {
    N('cog-' + id, label, 'cognitive', 7, desc, { path: 'daemon/src/cognitive/' + id + '.ts' });
    L('hub-cog', 'cog-' + id, 'cognitive');
  });
  L('cog-memory-steward', 'eng-memory', 'cognitive');
  L('cog-cell-classifier', 'eng-memory', 'cognitive');
  L('cog-iolaus', 'eng-hydra', 'cognitive');

  /* ---------- STORES ---------- */
  const stores = [
    ['sqlite', 'SQLite', 9, 'Episodic + audit + KV + identity + resources. WAL mode, single writer. ~/.eights/state.db (2.2 GB).', 'stores/sqlite.ts'],
    ['vec', 'sqlite-vec', 9, '768-dim embeddings for first-pass semantic recall (Ollama nomic-embed-text).', 'stores/vec.ts'],
    ['graph', 'LadybugDB / Kuzu', 9, 'Embedded property graph — the Agent-BOM. Runs, memories, resources, proposals + edges.', 'stores/graph.ts'],
    ['eventlog', 'Event Log', 8, 'Append-only .jsonl hash chain — 658,280 events, 418 MB. The tamper-evident source of truth.', '~/.eights/events/*.jsonl'],
  ];
  stores.forEach(([id, label, r, desc, path]) => {
    N('store-' + id, label, 'store', r, desc, { path });
    L('hub-store', 'store-' + id, 'store');
  });

  /* ---------- ADAPTERS ---------- */
  const adapters = [
    ['pp-bridge', 'pp-bridge', 'cons-pp', 'Listens to finalize_run / record_verdict / archive_artifact from the pp daemon.'],
    ['hydra-bridge', 'hydra-bridge', 'cons-hydra', 'LangGraph MemoryRef resolution (Phase-6 native envelope ingest superseded the stub).'],
    ['execsuite-bridge', 'execsuite-bridge', 'cons-execsuite', 'Wraps the output/<domain>/ archival convention into Agent-BOM nodes.'],
    ['rlm-bridge', 'rlm-bridge', 'cons-rlm', 'Tails RLM/progress/events.jsonl for all 14 RLM* siblings.'],
  ];
  adapters.forEach(([id, label, cons, desc]) => {
    N('adapt-' + id, label, 'adapter', 7, desc, { path: 'daemon/src/adapters/' + id + '.ts' });
    L('hub-adapt', 'adapt-' + id, 'adapter');
    L('adapt-' + id, cons, 'adapter');
  });
  L('adapt-pp-bridge', 'eng-pp-watcher', 'adapter');
  L('adapt-execsuite-bridge', 'eng-execsuite-watcher', 'adapter');
  L('adapt-rlm-bridge', 'eng-rlm-watcher', 'adapter');
  L('adapt-hydra-bridge', 'eng-hydra', 'adapter');

  /* ---------- PROVIDERS ---------- */
  const providers = [
    ['ollama', 'Ollama', 'Local default — nomic-embed-text (768) + gpt-oss:20b. No API key, no outbound traffic.'],
    ['openai', 'OpenAI', 'text-embedding-3-small + gpt-4o-mini. Opt-in behind EIGHTS_ALLOW_CLOUD_PROVIDERS=1.'],
    ['deepseek', 'DeepSeek', 'Completions only (no embeddings API). Opt-in cloud.'],
    ['authhub', 'AuthHub', 'Local-only, gitignored. Multi-provider routing via @authhub/sdk.'],
  ];
  providers.forEach(([id, label, desc]) => {
    N('prov-' + id, label, 'provider', 6, desc, { path: 'daemon/src/providers/' + (id === 'authhub' ? 'local/' : '') + id });
    L('hub-prov', 'prov-' + id, 'provider');
  });
  L('hub-prov', 'eng-memory', 'provider');

  /* ---------- SCHEMAS ---------- */
  const schemas = [
    ['envelope', 'Envelope', 'tenant · actor · project · domain · scope · trace — carried by every MCP call.'],
    ['memory', 'Memory', 'working / episodic / semantic / procedural / meta + provenance + cell.'],
    ['resource', 'Resource', 'Versioned resource: kind, risk_class, evolution_policy, signed versions.'],
    ['proposal', 'Proposal', 'EvolutionProposal + EvaluationReport (eval_delta, SSGM gate results).'],
    ['hydra-envelope', 'HydraEnvelope', 'CSuiteDecisionPacket / PRD / ArchRFC / DevTask / Handoff subtypes.'],
    ['memory-handle', 'MemoryHandle', 'Typed references: ep:// sem:// proc:// meta:// mem://.'],
  ];
  schemas.forEach(([id, label, desc]) => {
    N('schema-' + id, label, 'schema', 6, desc, { path: 'daemon/src/schemas/' + id + '.ts' });
    L('hub-schema', 'schema-' + id, 'schema');
  });

  /* ---------- MEMORY MODEL (CoALA types) ---------- */
  const memtypes = [
    ['working', 'Working', 'In-process LRU + SQLite spill. Lifetime: minutes (active turn buffer).'],
    ['episodic', 'Episodic', 'SQLite + jsonl event log. Run summaries, decision memos, dissent records. Tiered decay.'],
    ['semantic', 'Semantic', 'sqlite-vec + graph. Facts, glossaries, schemas, personas. Consolidated.'],
    ['procedural', 'Procedural', 'Graph + signed resource store. Prompts, teams, rubrics, workflows. Versioned, never deleted.'],
    ['meta', 'Meta', 'SQLite KV. Policies, profiles, learned weights, gate thresholds. Versioned.'],
  ];
  memtypes.forEach(([id, label, desc]) => {
    N('mem-' + id, label, 'memory', 7, desc, { meta: 'memory type' });
    L('mem-' + id, 'eng-memory', 'memtype');
  });

  /* ---------- EIGHT CELLS ---------- */
  ['vision', 'context', 'triggers', 'influence', 'risk', 'focus', 'constraints', 'delight'].forEach((c, i) => {
    N('cell-' + c, c, 'cell', 5, 'Eight Cells semantic axis — every memory row is tagged with one cell.', { meta: 'cell · ' + (i + 1) + '/8' });
    L('cell-' + c, 'cog-cell-classifier', 'cell');
  });

  /* ---------- AGENT-BOM NODE TYPES ---------- */
  const bomNodes = [
    ['Run', '(:Run)-[:PRODUCED]->(:Artifact), (:Run)-[:WROTE]->(:Memory). Replay walks the graph from here.'],
    ['Artifact', 'Produced output of a run — code, dossier, asset, report.'],
    ['Memory', 'A written memory node, vector-indexed and graph-linked.'],
    ['Decision', '(:Decision)-[:ASSUMES]->(:Assumption). ExecutiveSuite decision memos.'],
    ['Assumption', 'Linked to Outcomes at 6/12-month post-deal review.'],
    ['Outcome', 'Realized result; calibrates Dissent and Assumptions.'],
    ['ResourceVersion', '(:Resource)-[:HAD_VERSION]->(:ResourceVersion). Signed, content-addressed.'],
    ['EvolutionProposal', '(:EvolutionProposal)-[:PROPOSES]->(:ResourceVersion).'],
    ['Dissent', '(:Dissent)-[:RAISED_BY]->(:Actor)-[:CALIBRATED_BY]->(:Outcome).'],
  ];
  bomNodes.forEach(([id, desc]) => {
    N('bom-' + id, id, 'bom', 5.5, desc, { meta: 'Agent-BOM node' });
    L('bom-' + id, 'eng-bom', 'bom');
  });
  L('eng-bom', 'eng-audit', 'bom');

  /* ---------- RESOURCES (kinds) ---------- */
  const reskinds = [
    ['prompt', 'prompt', 'low→medium', 'Agent prompts across .claude/.codex/.gemini in all four consumers.'],
    ['team', 'team', 'medium', 'pair-programmer team compositions (YAML).'],
    ['rubric', 'rubric', 'high', 'Judging rubrics + taxonomy mappings.'],
    ['workflow', 'workflow', 'medium', 'Multi-step workflows bound to a constitution hash.'],
    ['squad', 'squad', 'high→critical', 'Hydra squads as resources — never raw YAML reads.'],
    ['policy', 'policy', 'critical', 'Governance gates — frozen, evolution cannot touch them.'],
    ['schema', 'schema', 'high', 'Memory + resource schemas.'],
    ['constitution', 'constitution', 'critical', 'Immutable governance head — amendments are always HITL.'],
    ['redaction_policy', 'redaction_policy', 'high', 'Squad-scoped redaction resource.'],
    ['tool', 'tool wrapper', 'medium', 'Tool wrappers and routing policies.'],
  ];
  reskinds.forEach(([id, label, risk, desc]) => {
    N('res-' + id, label, 'resource', 7, desc, { meta: 'risk: ' + risk });
    L('res-' + id, 'eng-evolution', 'evolves');
  });
  L('eng-evolution', 'res-policy', 'frozen');
  L('eng-evolution', 'res-constitution', 'frozen');

  /* ---------- PROPOSALS / HITL ---------- */
  N('hitl', 'HITL Queue', 'proposal', 11, '21 pending · 0 approved · 0 committed. Non-low risk classes require operator-signed approval.', { meta: '21 pending', path: '~/.eights/evolution/pending/' });
  L('hitl', 'eng-governance-state', 'proposes');
  const props = [
    // RLM Platform (10)
    ['cms', 'rlm/cms-content-block-registry', 'medium', 'hydra-supervisor · 05-25 · Δ +0.04', 'cons-rlm'],
    ['rlm-voice', 'rlm/persona-voice-v3', 'medium', 'hydra-supervisor · Δ +0.06', 'cons-rlm'],
    ['rlm-shot', 'rlm/shotlist-rubric', 'high', 'claude-orchestrator · Δ +0.03', 'cons-rlm'],
    ['rlm-asset', 'rlm/asset-job-routing', 'medium', 'hydra-supervisor · Δ +0.05', 'cons-rlm'],
    ['rlm-phase', 'rlm/phase-gate-thresholds', 'high', 'claude-orchestrator · Δ +0.07', 'cons-rlm'],
    ['rlm-brief', 'rlm/creative-brief-template', 'medium', 'hydra-supervisor · Δ +0.04', 'cons-rlm'],
    ['rlm-fin', 'rlm/finance-rubric-weights', 'high', 'claude-orchestrator · Δ +0.02', 'cons-rlm'],
    ['rlm-auth', 'rlm/auth-flow-prompt', 'medium', 'hydra-supervisor · Δ +0.09', 'cons-rlm'],
    ['rlm-code', 'rlm/coding-team-comp', 'medium', 'claude-orchestrator · Δ +0.06', 'cons-rlm'],
    ['rlm-design', 'rlm/design-critique-rubric', 'high', 'hydra-supervisor · Δ +0.05', 'cons-rlm'],
    // Hydra (2)
    ['sqr', 'hydra/squad.engineering.routing', 'high', 'hydra-supervisor · Δ +0.12', 'cons-hydra'],
    ['hydra-budget', 'hydra/budget-ceiling-policy', 'high', 'hydra-supervisor · Δ +0.08', 'cons-hydra'],
    // pair-programmer / AgentSmith (3)
    ['tdd', 'pp/team.feature-team-tdd', 'medium', 'claude-orchestrator · Δ +0.08', 'cons-pp'],
    ['pp-gate', 'pp/gate-escalation-thresholds', 'high', 'claude-orchestrator · Δ +0.05', 'cons-pp'],
    ['smith-drift', 'agentsmith/drift-quarantine-rule', 'high', 'agentsmith · Δ +0.04', 'cons-agentsmith'],
    // ExecutiveSuite (1)
    ['ma', 'execsuite/rubric.ma-dossier', 'high', 'claude-orchestrator · Δ +0.05', 'cons-execsuite'],
    // Cross-cutting (5)
    ['x-route', 'cross/routing.model-policy', 'medium', 'cost-analyst · Δ +0.11', 'cog-cost-analyst'],
    ['x-decay', 'cross/memory-decay-tuning', 'medium', 'memory-steward · Δ +0.03', 'eng-memory'],
    ['x-redact', 'cross/redaction-pattern-set', 'high', 'claude-orchestrator · Δ +0.02', 'eng-redaction'],
    ['x-fmt', 'cross/prompt-formatting-template', 'medium', 'miner · Δ +0.07', 'eng-miner'],
    ['x-miss', 'cross/missability-taxonomy', 'high', 'miner · Δ +0.06', 'eng-miner'],
  ];
  props.forEach(([id, label, risk, meta, link]) => {
    N('prop-' + id, label, 'proposal', 5.5, 'Pending evolution proposal — ' + risk + '-risk, so it requires operator-signed HITL approval before commit.', { meta: meta + ' · ' + risk });
    L('prop-' + id, 'hitl', 'proposes');
    if (link) L('prop-' + id, link, 'proposes');
  });

  /* ---------- GOVERNANCE ---------- */
  const gov = [
    ['ssgm', 'SSGM', 'Structured Safety Gate Model — consistency / decay / access gates on every commit.'],
    ['lasm', 'LASM', 'Layered Agent Security Model — defense-in-depth access checks at each layer.'],
    ['budget', 'Budget Ledger', 'proceed → downgrade @ 80% → block @ 100%. Durable across restart.'],
    ['breaker', 'Circuit Breaker', '3-strike per-node breaker. status / outcome / reset.'],
    ['ceiling', 'Loop Ceilings', 'iteration / depth / failure caps per run.'],
    ['redact', 'Redaction', 'Scope + squad-scoped stripping at the MCP boundary.'],
  ];
  gov.forEach(([id, label, desc]) => {
    N('gov-' + id, label, 'gov', 6, desc, { meta: 'governance plane' });
    L('gov-' + id, 'eng-policy', 'governs');
  });
  L('gov-budget', 'eng-governance-state', 'governs');
  L('gov-breaker', 'eng-governance-state', 'governs');
  L('gov-ceiling', 'eng-governance-state', 'governs');
  L('gov-redact', 'eng-redaction', 'governs');

  /* ---------- HARD INVARIANTS ---------- */
  const inv = [
    'Tenant + scope isolation', 'Audit immutability', 'Critical resources frozen',
    'Facts under audit immutable', 'No HITL bypass', 'WriteBridge sandboxing',
    'Eval rubric immutability', 'Constitution attestation', 'Squad lifecycle via Evolution',
    'OTEL loopback-only',
  ];
  N('hub-inv', 'Hard Invariants', 'invariant', 11, '10 rules the Evolution Engine can never modify. Enforced in the type system, not convention.', { path: 'ARCHITECTURE.md §12', meta: '10 / 10 held' });
  L('core', 'hub-inv', 'governs');
  inv.forEach((label, i) => {
    N('inv-' + (i + 1), (i + 1) + '. ' + label, 'invariant', 4.5, 'Immutable invariant #' + (i + 1) + ' — see ARCHITECTURE.md §12.', { meta: 'immutable' });
    L('inv-' + (i + 1), 'hub-inv', 'governs');
  });

  /* ---------- ADRs ---------- */
  const adrs = [
    ['0001', 'sqlite-vec over pgvector', 'store-vec'],
    ['0002', 'LadybugDB over Kuzu', 'store-graph'],
    ['0003', 'Node daemon, MCP-first', 'core'],
    ['0004', 'Autogenesis resource model', 'eng-evolution'],
    ['0005', 'SSGM gate set', 'gov-ssgm'],
    ['0006', 'Risk-class evolution policy', 'eng-evolution'],
    ['0007', 'Source-anchored + WriteBridge', 'eng-writeback'],
    ['0008', 'Eval adapter + LLM judge', 'eng-eval'],
  ];
  adrs.forEach(([num, title, target]) => {
    N('adr-' + num, 'ADR ' + num, 'adr', 4.5, title + '.', { path: 'adrs/' + num + '-*.md', meta: 'decision record' });
    L('adr-' + num, target, 'adr');
  });

  /* clean up the one placeholder edge */
  for (let i = links.length - 1; i >= 0; i--) {
    if (links[i].t === 'git-writer-x') links.splice(i, 1);
  }
  L('eng-evolution', 'eng-git-writer', 'engine');

  /* ---------- ENGINE INTERNALS (registrars · writers · eval adapters) ---------- */
  ['pp', 'hydra', 'execsuite', 'rlm'].forEach(c => {
    N('reg-' + c, c + '-registrar', 'engine', 4.2, 'Bulk-registers ' + c + '\'s prompts, teams and squads as versioned resources.', { path: 'daemon/src/engines/registrars/' + c + '.ts', meta: 'registrar' });
    L('eng-registrars', 'reg-' + c, 'engine');
    N('wb-' + c, c + ' WriteBridge', 'engine', 4.2, 'Sandbox-enforced writeback for ' + c + ', path-contained to its allowlisted root (ADR-0007, invariant #6).', { path: 'daemon/src/engines/writers/' + c + '.ts', meta: 'WriteBridge' });
    L('eng-writers', 'wb-' + c, 'engine');
  });
  [
    ['llm-judge', 'LLM-judge', 'Prose evaluation via local LLM against the frozen judge rubrics.'],
    ['yaml-structural', 'YAML-structural', 'Structural validation for teams / workflows / squads.'],
    ['rubric-backtest', 'Rubric-backtest', 'Backtests rubric changes against historical run verdicts.'],
    ['noop', 'NoopEval', 'Catch-all adapter — passes through with eval Δ 0.'],
  ].forEach(([id, label, desc]) => {
    N('ev-' + id, label, 'engine', 4.2, desc, { path: 'daemon/src/engines/eval/' + id + '.ts', meta: 'eval adapter' });
    L('eng-eval', 'ev-' + id, 'engine');
  });

  /* ---------- DAEMON RUNTIME / TOOLING ---------- */
  [
    ['config', 'config.ts', 'Configuration loader — paths, ports, log levels, provider selection.', 'daemon/src/config.ts', 'core'],
    ['logger', 'logger.ts', 'pino JSON logger → ~/.eights/logs/. Never console.log in daemon code.', 'daemon/src/logger.ts', 'core'],
    ['embeddings', 'embeddings.ts', 'Embedder interface + OllamaEmbedder (nomic-embed-text, 768-dim).', 'daemon/src/embeddings.ts', 'hub-prov'],
    ['completer', 'completer.ts', 'Completer interface — providers implement it; cognitive services consume it.', 'daemon/src/completer.ts', 'hub-prov'],
    ['audit-repair', 'audit-repair.ts', 'Forensic recovery tool for the hash chain.', 'daemon/src/audit-repair.ts', 'eng-audit'],
    ['otel', 'otel-sink.ts', 'OTEL exporter, hard-gated to localhost — refuses non-loopback at startup (invariant #10).', 'daemon/src/observability/otel-sink.ts', 'eng-audit'],
    ['mcp-server', 'mcp/server.ts', 'MCP server startup + stdio transport; transport-first boot with fail-closed readiness gate.', 'daemon/src/mcp/server.ts', 'hub-mcp'],
    ['zod-json', 'zod-to-json.ts', 'Zod → JSON-Schema export so adapters get typed tool contracts.', 'daemon/src/mcp/zod-to-json.ts', 'hub-schema'],
  ].forEach(([id, label, desc, path, link]) => {
    N('rt-' + id, label, 'runtime', 5, desc, { path, meta: 'daemon runtime' });
    L('core', 'rt-' + id, 'runtime');
    if (link && link !== 'core') L('rt-' + id, link, 'runtime');
  });

  /* ---------- CLI (thin shim over MCP) ---------- */
  [
    ['init', 'eights init', 'Creates ~/.eights/ + per-project .eights/config.yaml.', 'cli/src/index.ts'],
    ['status', 'eights status', 'Health check — embedAvail, llmEnabled, chain status.', 'cli/src/index.ts'],
    ['search', 'eights memory search', 'Hybrid-ranked recall from the CLI.', 'cli/src/index.ts'],
    ['review', 'eights review', 'Interactive HITL queue — approve / reject pending proposals.', 'cli/src/index.ts'],
    ['client', 'mcp-client.ts', 'Thin MCP stdio client the CLI talks through.', 'cli/src/mcp-client.ts'],
  ].forEach(([id, label, desc, path]) => {
    N('cli-' + id, label, 'cli', 5, desc, { path, meta: 'CLI shim' });
    L('cli-' + id, 'hub-mcp', 'cli');
  });
  L('cli-review', 'hitl', 'cli');

  /* ---------- HYDRA ENVELOPE SUBTYPES ---------- */
  [
    ['csuite', 'CSuiteDecisionPacket', 'Executive decision packet routed between C-suite roles.'],
    ['prd', 'PRD', 'Product requirements doc handed from exec → engineering squad.'],
    ['archrfc', 'ArchRFC', 'Architecture RFC bound to a constitution hash.'],
    ['devtask', 'DevTask', 'Engineering task dispatched to pair-programmer.'],
    ['brief', 'CreativeBrief', 'Creative brief feeding the RLM pipeline.'],
    ['shotlist', 'ShotList', 'Shot list for creative production.'],
    ['assetjob', 'AssetJob', 'Asset-generation job.'],
    ['decrec', 'DecisionRecord', 'Durable record of a workflow decision.'],
    ['hitlreq', 'HITLRequest', 'Human-in-the-loop approval request raised mid-workflow.'],
    ['handoff', 'Handoff', 'Cross-squad delegation — handoff.list reconstructs the chain.'],
  ].forEach(([id, label, desc]) => {
    N('env-' + id, label, 'envelope', 5, desc, { meta: 'HydraEnvelope subtype' });
    L('env-' + id, 'eng-hydra', 'envelope');
  });
  L('eng-hydra', 'schema-hydra-envelope', 'envelope');

  /* ---------- CRITICAL-FROZEN ROSTER (invariant #3 · ARCHITECTURE §12.3) ---------- */
  N('frozen-hub', 'Critical-Frozen Roster', 'frozen', 10, 'Resources the Evolution Engine can never mutate — risk_class=critical, evolution_policy=frozen. Amendments require an operator-signed unfreeze + HITL approval.', { path: 'ARCHITECTURE.md §12.3', meta: 'frozen by default' });
  L('frozen-hub', 'inv-3', 'frozen');
  L('frozen-hub', 'eng-evolution', 'frozen');
  [
    ['pol', 'eights.policy ×2', 'TheEights\' own governance policies — frozen.', 'core'],
    ['rubrics', 'eights.eval-rubric ×5', 'Per-kind judge rubrics — evolution cannot mutate the criteria it is judged by (ADR-0008, invariant #7).', 'eng-eval'],
    ['exec-gov', 'ExecSuite ai-governance', 'ExecutiveSuite AI-governance skill — frozen.', 'cons-execsuite'],
    ['exec-proto', 'ExecSuite executive-protocol', 'ExecutiveSuite executive-protocol skill — frozen.', 'cons-execsuite'],
    ['exec-fin', 'ExecSuite financial-frameworks', 'ExecutiveSuite financial-frameworks skill — frozen.', 'cons-execsuite'],
    ['pp-sec', 'pp security rubric', 'pair-programmer security gate — frozen.', 'cons-pp'],
    ['pp-contract', 'pp contract rubric', 'pair-programmer contract gate — frozen.', 'cons-pp'],
    ['pp-spec', 'pp spec rubric', 'pair-programmer spec gate — frozen.', 'cons-pp'],
    ['rlm-hooks', 'RLM safety hooks ×4', 'pre-tool-safety · session-* · stop-checkpoint · post-state-write-verify.', 'cons-rlm'],
    ['hydra-squads', 'Hydra squads ×8', 'All 8 squads carry tool-privilege escalation → critical-frozen (invariant #9).', 'cons-hydra'],
    ['hydra-hitl', 'Hydra HITL gates', 'Hydra HITL gates + redactor configs — frozen.', 'cons-hydra'],
  ].forEach(([id, label, desc, link]) => {
    N('fz-' + id, label, 'frozen', 4.6, desc, { meta: 'risk: critical · frozen' });
    L('fz-' + id, 'frozen-hub', 'frozen');
    if (link && link !== 'core') L('fz-' + id, link, 'frozen');
  });

  /* ---------- LENSES ---------- */
  const lenses = [
    { id: 'overview', label: 'Overview', desc: 'The substrate, its consumers and the seven subsystems.',
      groups: ['core', 'consumer', 'hub', 'invariant'], collapseLeaves: true },
    { id: 'architecture', label: 'Architecture', desc: 'Every module: engines, stores, MCP, cognitive, adapters, providers, schemas, runtime & CLI.',
      groups: ['core', 'hub', 'engine', 'store', 'mcp', 'cognitive', 'adapter', 'provider', 'schema', 'runtime', 'cli'] },
    { id: 'mcp', label: 'MCP Surface', desc: 'All 12 namespaces, their 65 tools, and the CLI shim.',
      groups: ['core', 'hub', 'mcp', 'tool', 'cli'], focus: 'hub-mcp' },
    { id: 'ecosystem', label: 'Ecosystem', desc: 'How the six consumers read & write the substrate — adapters, envelopes, resources, proposals.',
      groups: ['core', 'consumer', 'adapter', 'engine', 'resource', 'proposal', 'envelope'] },
    { id: 'memory', label: 'Memory', desc: 'CoALA memory types, the Eight Cells and the stores behind them.',
      groups: ['core', 'hub', 'memory', 'cell', 'store', 'bom', 'engine'] },
    { id: 'evolution', label: 'Self-Evolution', desc: 'Resources, the 21 pending proposals, the HITL queue, the eval loop and the frozen roster.',
      groups: ['core', 'engine', 'resource', 'proposal', 'invariant', 'adr', 'frozen'] },
    { id: 'audit', label: 'Audit / BOM', desc: 'The Agent-BOM node types, the audit engine, the hash chain and the recovery tooling.',
      groups: ['core', 'hub', 'bom', 'engine', 'store', 'invariant', 'runtime'] },
    { id: 'governance', label: 'Governance', desc: 'Gates, the governance plane, the 10 invariants and the frozen roster.',
      groups: ['core', 'gov', 'engine', 'invariant', 'proposal', 'frozen'] },
    { id: 'hydra', label: 'Hydra Flow', desc: 'Hydra\'s 10 envelope subtypes, its engine, squads and cross-squad handoffs.',
      groups: ['core', 'consumer', 'envelope', 'engine', 'adapter', 'frozen'] },
    { id: 'safety', label: 'Safety & Frozen', desc: 'The immutable safety surface — invariants, the named frozen roster and the gates.',
      groups: ['core', 'invariant', 'frozen', 'gov', 'resource'] },
    { id: 'codebase', label: 'Full Atlas', desc: 'Everything at once — the complete codebase as one graph.',
      groups: Object.keys(G) },
  ];

  window.ATLAS = { groups: G, nodes, links, lenses };
})();
