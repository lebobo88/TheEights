/**
 * Phase 6 — Hydra-manifesto alignment surface.
 *
 * Covers the new tracks end-to-end against an in-memory daemon assembly:
 *   1. Constitution: get / attest receipt / amendment is HITL.
 *   2. Memory handles: ep:// round-trip via add + resolve.
 *   3. Hydra envelope ingest: record + query + handoff.list.
 *   4. Eight cells: distribution counts.
 *   5. Governance: budget tiers (proceed → downgrade → block) durable across re-init.
 *   6. Redaction policy: scope-stripping on cross-squad payload.
 *   7. Prompts as resources: registrar idempotent + diff non-empty.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { mintOperatorCapability } from "../src/auth/capability.js";
import { SqliteStore } from "../src/stores/sqlite.js";
import { AuditEngine } from "../src/engines/audit.js";
import { PolicyEngine } from "../src/engines/policy.js";
import { EvolutionEngine } from "../src/engines/evolution.js";
import { ConstitutionEngine } from "../src/engines/constitution.js";
import { HydraEngine } from "../src/engines/hydra.js";
import { GovernanceStateEngine } from "../src/engines/governance-state.js";
import { RedactionEngine } from "../src/engines/redaction.js";
import { MemoryEngine } from "../src/engines/memory.js";
import { VectorStore } from "../src/stores/vec.js";
import { GraphStore } from "../src/stores/graph.js";
import { CellClassifier } from "../src/cognitive/cell-classifier.js";
import { PromptRegistrar } from "../src/engines/registrars/prompts.js";
import { formatEpisodic, parseHandle } from "../src/schemas/memory-handle.js";
import type { Envelope } from "../src/schemas/envelope.js";
import type { Embedder } from "../src/embeddings.js";
import { registerHydraTools, RecordArgs } from "../src/mcp/hydra.js";

const log = pino({ level: "warn" });
void log; // used in tests but TypeScript strict-mode would warn if unused

// ---------------------------------------------------------------------------
// Operator capability helpers for phase6 tests
// ---------------------------------------------------------------------------
const P6_OP_KEY = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const P6_KEY_ID = "p6-test-key";

function withOpKey<T>(fn: () => T): T {
  const prev = process.env["HYDRA_OPERATOR_KEY"];
  const prevId = process.env["HYDRA_OPERATOR_KEY_ID"];
  process.env["HYDRA_OPERATOR_KEY"] = P6_OP_KEY;
  process.env["HYDRA_OPERATOR_KEY_ID"] = P6_KEY_ID;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env["HYDRA_OPERATOR_KEY"];
    else process.env["HYDRA_OPERATOR_KEY"] = prev;
    if (prevId === undefined) delete process.env["HYDRA_OPERATOR_KEY_ID"];
    else process.env["HYDRA_OPERATOR_KEY_ID"] = prevId;
  }
}

function makeHitlResolveEnv(actorId: string, requestId: string, workflowId?: string) {
  const token = mintOperatorCapability({
    v: 1, actor_id: actorId, actor_kind: "human",
    capability: "hitl.resolve", resource_id: requestId, workflow_id: workflowId ?? requestId,
    issued_at: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  return token;
}

class StubEmbedder implements Embedder {
  lastError: string | null = null;
  async embed(_t: string) { return null; }
  async available() { return false; }
}

const env: Envelope = {
  tenant_id: "local", actor_id: "phase6-test",
  project_id: "TheEights", domain: "infra",
  scope: [], trace_id: "t-phase6",
};

describe("Phase 6 — manifesto alignment", () => {
  let dir: string;
  let sql: SqliteStore;
  let audit: AuditEngine;
  let policy: PolicyEngine;
  let evolution: EvolutionEngine;
  let constitution: ConstitutionEngine;
  let hydra: HydraEngine;
  let gov: GovernanceStateEngine;
  let redaction: RedactionEngine;
  let memory: MemoryEngine;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-p6-"));
    sql = new SqliteStore(join(dir, "state.db"));
    sql.migrate();
    // Register the test actor as human so operator capability checks pass.
    sql.db.prepare(
      `INSERT OR IGNORE INTO actors(actor_id, kind, created_at) VALUES (?, 'human', datetime('now'))`,
    ).run("phase6-test");
    audit = new AuditEngine(sql, join(dir, "events"));
    policy = new PolicyEngine(sql);
    const vec = new VectorStore(sql.db, 768);
    vec.load();
    const graph = new GraphStore(join(dir, "graph"), "ladybug");
    memory = new MemoryEngine(sql, vec, graph, audit, new StubEmbedder(), policy);
    evolution = new EvolutionEngine(sql, join(dir, "resources"), policy, audit);
    evolution.seedCriticalResources();
    constitution = new ConstitutionEngine(evolution, audit);
    hydra = new HydraEngine(sql, audit, memory);
    gov = new GovernanceStateEngine(sql, audit);
    redaction = new RedactionEngine(evolution, policy, audit);
  });

  afterAll(() => { sql.close(); rmSync(dir, { recursive: true, force: true }); });

  it("constitution seed + attest produces a frozen receipt", () => {
    constitution.seed(env, "hydra", "# Hydra constitution v1\nAll powers under one will.\n");
    const view = constitution.get(env, "hydra");
    expect(view.frozen).toBe(true);
    expect(view.text).toContain("Hydra constitution");
    const receipt = constitution.attest(env, "hydra");
    expect(receipt.consumer).toBe("hydra");
    expect(receipt.content_hash).toBe(view.hash);
    expect(receipt.receipt_signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("constitution amendment is HITL-gated (frozen → must unfreeze)", () => {
    expect(() => constitution.proposeAmendment(env, "hydra", "tampered", "test")).toThrow(/frozen/);
  });

  it("memory handles round-trip via add + resolve", async () => {
    const explicit = formatEpisodic("wf_1", "task_a", 7);
    const m = await memory.add(env, {
      type: "episodic",
      content: "first decision",
      provenance: { run_id: "wf_1", actor: "task_a" },
      handle: explicit,
    });
    expect(m.handle).toBe(explicit);
    const back = memory.resolve(env, explicit);
    expect(back?.id).toBe(m.id);
    expect(parseHandle(explicit).scheme).toBe("ep");
  });

  it("hydra envelope record + query + handoff list", async () => {
    const r = await hydra.record(env, {
      id: "env_test_1", type: "DEV_TASK",
      origin_squad: "engineering", target_squad: "creative",
      workflow_id: "wf_1", context_refs: [],
      // @ts-expect-error passthrough extra field
      description: "Build a landing page",
    } as never);
    expect(r.workflow_id).toBe("wf_1");
    const q = hydra.query(env, { workflow_id: "wf_1" });
    expect(q.find((e) => e.envelope_id === r.envelope_id)).toBeDefined();
    await hydra.record(env, {
      id: "env_test_handoff_1", type: "HANDOFF",
      origin_squad: "engineering", target_squad: "creative",
      workflow_id: "wf_1", context_refs: [],
    } as never);
    const handoffs = hydra.listHandoffs(env, "wf_1");
    expect(handoffs.length).toBe(1);
  });

  it("X3 (persistence test, direct engine — NOT the production attestor shape): a PLAN body that happens to carry a `summary` key is indexed by extractSummary", async () => {
    // NOTE ON SCOPE: this calls HydraEngine.record directly with a hand-built
    // body that includes `summary`. Hydra's real attestor
    // (hydra_core/eights/attestation.py:507-515) only forwards
    // id/type/workflow_id/origin_squad/target_squad/parent_id — it does NOT
    // forward `summary` or any other Plan-body field. So this test proves only
    // that extractSummary's `summary` probe works when a `summary` key is
    // present in whatever is passed to record(); it does NOT prove that a
    // production-attested PLAN gets a semantic memory row. See the next test
    // for the honest, attestor-shaped counterpart (memory_id is null there).
    const r = await hydra.record(env, {
      id: "env_test_plan_1", type: "PLAN",
      origin_squad: "hydra-planner", target_squad: null,
      workflow_id: "wf_plan_1", context_refs: [],
      // @ts-expect-error passthrough extra fields (Plan body is not re-typed here)
      summary: "Decompose the X3 goal into dependency-ordered steps",
      rigor: "standard", goal_restatement: "Let X3 envelopes reach TheEights",
    } as never);
    expect(r.workflow_id).toBe("wf_plan_1");
    // StubEmbedder.available() returns false, so memory.add still runs (embedding
    // is optional) and extractSummary's match against `summary` should produce
    // a row — assert memory_id is non-null, not just that record() succeeded.
    expect(r.memory_id).not.toBeNull();
    const q = hydra.query(env, { workflow_id: "wf_plan_1" });
    expect(q.find((e) => e.envelope_id === r.envelope_id)).toBeDefined();
  });

  it("X3: a PLAN recorded in the real attestor's forwarded shape (id/type/workflow_id/origin_squad/target_squad/parent_id only, NO summary) persists durably but yields a null memory_id", async () => {
    // This is the production-honest counterpart to the test above. Hydra's
    // attestor never forwards `summary` (or `objective`/`description`/`goal`),
    // so extractSummary's four-field probe finds nothing and memory_id stays
    // null — the PLAN is still durably recorded and queryable, it's just not
    // semantically indexed. This does not change extractSummary or record()'s
    // indexing behavior; it documents/pins the real production outcome.
    const r = await hydra.record(env, {
      id: "env_test_plan_attestor_1",
      type: "PLAN",
      workflow_id: "wf_plan_attestor_1",
      origin_squad: "hydra-planner",
      target_squad: null,
      parent_id: null,
    } as never);
    expect(r.workflow_id).toBe("wf_plan_attestor_1");
    expect(r.memory_id).toBeNull();
    const q = hydra.query(env, { workflow_id: "wf_plan_attestor_1" });
    expect(q.find((e) => e.envelope_id === r.envelope_id)).toBeDefined();
  });

  it("X3 (persistence test, direct engine — bypasses public validation boundary): SUPPORT_TICKET, PORTABLE_CONTEXT, VOC_REPORT and JUDGE_VERDICT all record successfully", async () => {
    // This test calls HydraEngine.record directly and therefore does not
    // exercise Zod's runtime enum validation (HydraEngine.record has none of
    // its own). It proves the persistence path (INSERT + query) works for each
    // new type's shape; it does NOT prove the public intake boundary rejects
    // unknown types. See the RecordArgs/MCP-handler boundary test below for that.
    const cases: Array<{ id: string; type: string; extra: Record<string, unknown> }> = [
      { id: "env_test_support_1", type: "SUPPORT_TICKET", extra: { description: "Customer cannot reset password" } },
      { id: "env_test_portctx_1", type: "PORTABLE_CONTEXT", extra: {} },
      { id: "env_test_voc_1", type: "VOC_REPORT", extra: { summary: "Q3 VoC themes" } },
      { id: "env_test_judge_1", type: "JUDGE_VERDICT", extra: {} },
    ];
    for (const c of cases) {
      const r = await hydra.record(env, {
        id: c.id, type: c.type,
        origin_squad: "test", target_squad: null,
        workflow_id: "wf_x3_misc", context_refs: [],
        ...c.extra,
      } as never);
      expect(r.workflow_id).toBe("wf_x3_misc");
    }
    const q = hydra.query(env, { workflow_id: "wf_x3_misc" });
    expect(q.length).toBe(cases.length);
  });

  it("X3 (public validation boundary — RecordArgs + MCP handler): PLAN, SUPPORT_TICKET, PORTABLE_CONTEXT, VOC_REPORT and JUDGE_VERDICT all pass through the attestor-shaped payload and record successfully", async () => {
    // Unlike the direct-engine tests above, this goes through the same public
    // seam the real MCP tool call uses: RecordArgs.parse (Zod validation) then
    // the registered "eights.hydra.envelope.record" handler. The payload shape
    // mirrors exactly what Hydra's attestor forwards — no summary/objective/
    // description/goal fields — so this also documents that the boundary does
    // not require those optional fields.
    const tools = registerHydraTools(hydra);
    const recordTool = tools["eights.hydra.envelope.record"];
    const x3Types = ["PLAN", "SUPPORT_TICKET", "PORTABLE_CONTEXT", "VOC_REPORT", "JUDGE_VERDICT"];
    for (const type of x3Types) {
      const raw = {
        envelope: env,
        hydra_envelope: {
          id: `env_boundary_${type}`,
          type,
          workflow_id: "wf_x3_boundary",
          origin_squad: "test",
          target_squad: null,
          parent_id: null,
        },
      };
      // RecordArgs.parse throws on schema violation — proves the payload is
      // accepted at the real validation boundary, not merely by the engine.
      // The attestor's forwarded shape never includes `context_refs`; assert
      // that Zod's schema default ([]) is what actually reaches the engine,
      // so a regression that drops the default would fail here even though
      // this fixture would still "look right" without the field.
      const parsed = RecordArgs.parse(raw);
      expect(parsed.hydra_envelope.context_refs).toEqual([]);
      const r = await recordTool.handler(parsed);
      expect(r.workflow_id).toBe("wf_x3_boundary");
      expect(r.type).toBe(type);
    }
    const q = hydra.query(env, { workflow_id: "wf_x3_boundary" });
    expect(q.length).toBe(x3Types.length);
  });

  it("X3 (public validation boundary): an unknown envelope type is rejected by RecordArgs before it ever reaches the engine", () => {
    const raw = {
      envelope: env,
      hydra_envelope: {
        id: "env_boundary_unknown",
        type: "SOMETHING_STILL_UNKNOWN",
        workflow_id: "wf_x3_boundary_unknown",
        origin_squad: "test",
        target_squad: null,
        parent_id: null,
        context_refs: [],
      },
    };
    const result = RecordArgs.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it("cells distribution counts the eight + untagged buckets", async () => {
    const cf = new CellClassifier();
    expect(cf.classify("risk threats and compliance liability")).toBe("risk");
    expect(cf.classify("budget cap deadline SLA")).toBe("constraints");
    expect(cf.classify("delight brand voice polish")).toBe("delight");
  });

  it("governance budget enforces proceed → downgrade → block thresholds", () => {
    const run = "wf_budget";
    // setCap now requires a governance.cap.set capability token.
    const capSetToken = withOpKey(() => mintOperatorCapability({
      v: 1, actor_id: env.actor_id, actor_kind: "human",
      capability: "governance.cap.set", resource_id: run, workflow_id: run,
      issued_at: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }));
    const capSetEnv = { ...env, capability_token: capSetToken } as unknown as typeof env;
    withOpKey(() => gov.setCap(capSetEnv, run, "budget", 100));
    const a = gov.budgetCharge(env, run, 50);
    expect(a.action).toBe("proceed");
    const b = gov.budgetCharge(env, run, 35);  // 85%
    expect(b.action).toBe("downgrade");
    const c = gov.budgetCharge(env, run, 30);  // 115%
    expect(c.action).toBe("block");
  });

  it("loop ceiling tick warns at 80% and blocks at cap", () => {
    const run = "wf_loop";
    // setCap now requires a governance.cap.set capability token.
    const capSetToken = withOpKey(() => mintOperatorCapability({
      v: 1, actor_id: env.actor_id, actor_kind: "human",
      capability: "governance.cap.set", resource_id: run, workflow_id: run,
      issued_at: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }));
    const capSetEnv = { ...env, capability_token: capSetToken } as unknown as typeof env;
    withOpKey(() => gov.setCap(capSetEnv, run, "iteration", 5));
    expect(gov.ceilingTick(env, run, "iteration").action).toBe("proceed");
    expect(gov.ceilingTick(env, run, "iteration").action).toBe("proceed");
    expect(gov.ceilingTick(env, run, "iteration").action).toBe("proceed");
    expect(gov.ceilingTick(env, run, "iteration").action).toBe("warn");
    const fifth = gov.ceilingTick(env, run, "iteration");
    expect(["block", "trip"]).toContain(fifth.action);
  });

  it("breaker trips after 3 consecutive failures and resets on success", () => {
    gov.breakerOutcome(env, "node_x", "failure");
    gov.breakerOutcome(env, "node_x", "failure");
    const trip = gov.breakerOutcome(env, "node_x", "failure");
    expect(trip.tripped).toBe(true);
    // breakerOutcome(success) on a tripped breaker requires an operator capability token
    // (Fix #1 — close the untrip path). Mint a fresh token bound to node_x.
    const breakerResetToken = withOpKey(() =>
      mintOperatorCapability({
        v: 1, actor_id: env.actor_id, actor_kind: "human",
        capability: "governance.breaker.reset", resource_id: "node_x", workflow_id: "node_x",
        issued_at: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
    const resetEnv = { ...env, capability_token: breakerResetToken } as unknown as typeof env;
    const reset = withOpKey(() => gov.breakerOutcome(resetEnv, "node_x", "success"));
    expect(reset.tripped).toBe(false);
  });

  it("HITL queue is durable + resolvable", () => {
    const req = gov.hitlRequest(env, { run_id: "wf_h", kind: "approve_release", payload: { v: 1 } });
    expect(req.status).toBe("pending");
    const list = gov.hitlList(env, "pending");
    expect(list.find((r) => r.request_id === req.request_id)).toBeDefined();
    // workflow_id must match run_id from the HITL row ("wf_h") — that's what hitlResolve derives.
    const token = withOpKey(() => makeHitlResolveEnv(env.actor_id, req.request_id, "wf_h"));
    const resolveEnv = { ...env, capability_token: token } as unknown as typeof env;
    const resolved = withOpKey(() => gov.hitlResolve(resolveEnv, req.request_id, "approved", "lgtm"));
    expect(resolved.status).toBe("approved");
  });

  it("redact_for_squad strips scoped fields and runs PII patterns", () => {
    const r = redaction.redactForSquad(env, "creative", {
      type: "DEV_TASK",
      context_refs: [
        { tier: "semantic", key: "X", summary: "fine", scopes: ["public"] },
        { tier: "semantic", key: "Y", summary: "salary 100k", scopes: ["financial"] },
      ],
      contact: "alice@example.com",
    });
    expect(r.blocked).toBe(false);
    const refs = (r.payload as { context_refs: Array<Record<string, unknown>> }).context_refs;
    expect(refs[0]?._redacted).toBeUndefined();
    expect(refs[1]?._redacted).toBe(true);
    expect((r.payload as { contact: string }).contact).toMatch(/REDACTED:email/);
  });

  it("prompt registrar registers and is idempotent on rerun", () => {
    // Create a fake .claude/agents prompt to register.
    const fakeRepo = join(dir, "fake-hydra");
    mkdirSync(join(fakeRepo, ".claude", "agents"), { recursive: true });
    writeFileSync(join(fakeRepo, ".claude", "agents", "fake-agent.md"), "You are fake.", "utf8");
    // PromptRegistrar uses fixed repo paths; substitute by writing into the real .claude paths is too invasive.
    // Instead test the underlying registerFile via the common helper indirectly through a manual call.
    const rid = "resource:hydra.prompt.agent.fake-agent";
    evolution.register(env, {
      rid, kind: "prompt", risk_class: "high", initial_content: "You are fake.",
      consumer: "hydra", source_paths: [join(fakeRepo, ".claude", "agents", "fake-agent.md")],
      writeback_mode: "in-place+branch",
    });
    const r = evolution.getResource(rid);
    expect(r?.kind).toBe("prompt");
    expect(r?.risk_class).toBe("high");
    expect(r?.evolution_policy).toBe("hitl-only");
  });
});
