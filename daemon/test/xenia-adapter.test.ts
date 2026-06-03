import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { SqliteStore } from "../src/stores/sqlite.js";
import { AuditEngine } from "../src/engines/audit.js";
import { PolicyEngine } from "../src/engines/policy.js";
import { EvolutionEngine } from "../src/engines/evolution.js";
import { WriteRouter } from "../src/engines/writeback.js";
import { XeniaRegistrar } from "../src/engines/registrars/xenia-registrar.js";
import { XeniaWatcher } from "../src/engines/xenia-watcher.js";
import { XeniaBridge } from "../src/adapters/xenia-bridge.js";
import type { Envelope } from "../src/schemas/envelope.js";

const env: Envelope = {
  tenant_id: "local", actor_id: "xenia-test",
  project_id: "xenia", domain: "customer-support",
  scope: [], trace_id: "t-xenia",
};

const log = pino({ level: "silent" });

function makeFakeXeniaRoot(dir: string): string {
  const root = join(dir, "fake-xenia");
  mkdirSync(join(root, ".claude", "agents", "soteria-crew"), { recursive: true });
  mkdirSync(join(root, ".claude", "skills", "kb-rag-citation"), { recursive: true });
  mkdirSync(join(root, ".claude", "commands"), { recursive: true });
  mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(root, "rubrics"), { recursive: true });
  mkdirSync(join(root, "hearth", "progress"), { recursive: true });
  writeFileSync(join(root, ".claude", "agents", "hestia.md"), "# Hestia crown lead");
  writeFileSync(join(root, ".claude", "agents", "soteria-crew", "echo.md"), "# Echo sub-agent");
  writeFileSync(join(root, ".claude", "skills", "kb-rag-citation", "SKILL.md"), "# kb skill");
  writeFileSync(join(root, ".claude", "commands", "support-ticket.md"), "# command");
  writeFileSync(join(root, ".claude", "hooks", "pre-tool-privilege.ps1"), "# article V gate");
  writeFileSync(join(root, ".claude", "hooks", "post-output-sla-stamp.ps1"), "# telemetry");
  writeFileSync(join(root, "rubrics", "sla-p1-1hour.yaml"), "rubric_id: sla-p1-1hour");
  writeFileSync(join(root, "squad.yaml"), "name: Xenia Hearth");
  return root;
}

describe("xenia-registrar — pack registration with risk classes", () => {
  let dir: string;
  let sql: SqliteStore;
  let engine: EvolutionEngine;
  let root: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-xenia-reg-"));
    root = makeFakeXeniaRoot(dir);
    process.env.EIGHTS_XENIA_ROOT = root;
    sql = new SqliteStore(join(dir, "state.db"));
    sql.migrate();
    const audit = new AuditEngine(sql, join(dir, "events"));
    const policy = new PolicyEngine(sql);
    engine = new EvolutionEngine(sql, join(dir, "resources"), policy, audit);
    engine.setWriteRouter(new WriteRouter([]));
  });

  afterAll(() => {
    delete process.env.EIGHTS_XENIA_ROOT;
    sql.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers agents/skills/commands/rubrics/squad/hooks with correct risk", () => {
    const registrar = new XeniaRegistrar(engine, log);
    const r = registrar.run(env);
    expect(r.consumer).toBe("xenia");
    expect(r.errors).toEqual([]);
    expect(r.registered).toBe(8);

    const agent = engine.getResource("resource:xenia.agent.hestia")!;
    expect(agent.risk_class).toBe("high");
    expect(agent.evolution_policy).toBe("hitl-only");

    const subAgent = engine.getResource("resource:xenia.agent.echo");
    expect(subAgent).not.toBeNull();

    const skill = engine.getResource("resource:xenia.skill.kb-rag-citation")!;
    expect(skill.risk_class).toBe("low");

    const command = engine.getResource("resource:xenia.command.support-ticket")!;
    expect(command.risk_class).toBe("medium");

    const rubric = engine.getResource("resource:xenia.rubric.sla-p1-1hour")!;
    expect(rubric.risk_class).toBe("low");

    const squad = engine.getResource("resource:xenia.squad.customer-support")!;
    expect(squad.risk_class).toBe("high");

    // Constitution-enforcing hook is critical -> frozen by default policy.
    const gateHook = engine.getResource("resource:xenia.hook.pre-tool-privilege.ps1")!;
    expect(gateHook.risk_class).toBe("critical");
    const telemetryHook = engine.getResource("resource:xenia.hook.post-output-sla-stamp.ps1")!;
    expect(telemetryHook.risk_class).toBe("medium");
  });

  it("is idempotent on rescan", () => {
    const registrar = new XeniaRegistrar(engine, log);
    const r = registrar.run(env);
    expect(r.registered).toBe(0);
    expect(r.skipped).toBe(8);
  });
});

describe("xenia-watcher + bridge — event ingestion, cells, dedupe, redaction", () => {
  let dir: string;
  let sql: SqliteStore;
  let root: string;
  let watcher: XeniaWatcher;
  const added: Array<{ cell?: string; content: string; summary?: string; scopes?: string[] }> = [];

  // Minimal MemoryEngine stand-in: capture add() inputs.
  const memoryStub = {
    add: async (_env: Envelope, input: { cell?: string; content: string; summary?: string; scopes?: string[] }) => {
      added.push(input);
      return { id: `mem_${added.length}` };
    },
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eights-xenia-watch-"));
    root = makeFakeXeniaRoot(dir);
    sql = new SqliteStore(join(dir, "state.db"));
    sql.migrate();
    const bridge = new XeniaBridge(memoryStub as never);
    watcher = new XeniaWatcher(sql, bridge, log, { root });
  });

  afterAll(() => { sql.close(); rmSync(dir, { recursive: true, force: true }); });

  const eventsPath = () => join(root, "hearth", "progress", "events.jsonl");

  it("ingests events with the trigram cell mapping", async () => {
    appendFileSync(eventsPath(), JSON.stringify({
      event_id: "x-1", ts: "2026-06-03T00:00:00Z", kind: "xenia.ticket_created",
      agent: "iris", phase: "tickets", ticket_id: "TICKET-001", severity: "P2", category: "billing",
    }) + "\n");
    appendFileSync(eventsPath(), JSON.stringify({
      event_id: "x-2", ts: "2026-06-03T00:05:00Z", kind: "xenia.ticket_resolved",
      agent: "hestia", phase: "tickets", ticket_id: "TICKET-001", severity: "P2", category: "billing",
      customer_ref: "customer:a1b2c3d4", outcome: "delight",
    }) + "\n");
    const r = await watcher.syncNow();
    expect(r.events).toBe(2);
    expect(added.length).toBe(2);
    expect(added[0]!.cell).toBe("risk");      // created -> Kan
    expect(added[1]!.cell).toBe("delight");   // resolved -> Dui
    expect(added[0]!.scopes).toContain("ticket:TICKET-001");
    expect(added[0]!.scopes).toContain("domain:customer-support");
    // Pack memory contract: customer:<hash> + outcome:delight scopes ride wins.
    expect(added[1]!.scopes).toContain("customer:a1b2c3d4");
    expect(added[1]!.scopes).toContain("outcome:delight");
  });

  it("escalation writes TWO memories (risk + influence)", async () => {
    added.length = 0;
    appendFileSync(eventsPath(), JSON.stringify({
      event_id: "x-3", ts: "2026-06-03T00:10:00Z", kind: "xenia.escalated",
      agent: "hermes", phase: "escalations", ticket_id: "TICKET-002", severity: "P1", category: "outage",
    }) + "\n");
    const r = await watcher.syncNow();
    expect(r.events).toBe(1);
    expect(added.length).toBe(2);
    expect(added.map((a) => a.cell).sort()).toEqual(["influence", "risk"]);
  });

  it("scrubs PII at the bridge (Layer 4) even if hooks missed it", async () => {
    added.length = 0;
    appendFileSync(eventsPath(), JSON.stringify({
      event_id: "x-4", ts: "2026-06-03T00:15:00Z", kind: "xenia.voc_report",
      agent: "echo", phase: "voc", ticket_id: "TICKET-003", severity: "P3",
      category: "feedback", leaked: "contact bob@example.com or 555-123-4567",
    }) + "\n");
    await watcher.syncNow();
    expect(added.length).toBe(1);
    expect(added[0]!.content).not.toContain("bob@example.com");
    expect(added[0]!.content).toContain("[EMAIL]");
    expect(added[0]!.cell).toBe("influence");
  });

  it("skips a partial trailing line until completed", async () => {
    added.length = 0;
    appendFileSync(eventsPath(), '{"event_id":"x-5","kind":"xenia.ticket_created","ticket_id":"TICK'); // no newline
    let r = await watcher.syncNow();
    expect(r.events).toBe(0);
    appendFileSync(eventsPath(), 'ET-004","severity":"P4","category":"general"}\n');
    r = await watcher.syncNow();
    expect(r.events).toBe(1);
    expect(added[0]!.scopes).toContain("ticket:TICKET-004");
  });

  it("dedupes by event_id after truncation reset", async () => {
    added.length = 0;
    // Rotate: truncate the file, then replay an already-seen event + a new one.
    truncateSync(eventsPath(), 0);
    appendFileSync(eventsPath(), JSON.stringify({
      event_id: "x-3", kind: "xenia.escalated", ticket_id: "TICKET-002", severity: "P1", category: "outage",
    }) + "\n");
    appendFileSync(eventsPath(), JSON.stringify({
      event_id: "x-6", kind: "xenia.ticket_resolved", ticket_id: "TICKET-005", severity: "P3", category: "how-to",
    }) + "\n");
    const r = await watcher.syncNow();
    expect(r.events).toBe(1); // x-3 suppressed, x-6 ingested
    expect(added.length).toBe(1);
    expect(added[0]!.cell).toBe("delight");
  });
});
