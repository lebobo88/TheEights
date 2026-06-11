#!/usr/bin/env node
/**
 * `eights` CLI — thin shim over the daemon's MCP surface.
 */
import { Command } from "commander";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { createHmac, randomUUID } from "node:crypto";
import { EightsClient, defaultEnvelope } from "./mcp-client.js";

// ---------- Operator capability mint (CLI-side) ----------
// Reads HYDRA_OPERATOR_KEY from the CLI process environment (NEVER from the request).
// Returns the signed token object or null if the key is not configured.

const OPERATOR_ACTOR_ID = process.env["EIGHTS_OPERATOR_ACTOR_ID"] ?? "eights.operator";

function hexDecode(s: string): Buffer | null {
  if (s.length % 2 !== 0) return null;
  try {
    const b = Buffer.from(s, "hex");
    if (b.toString("hex") !== s.toLowerCase()) return null;
    return b;
  } catch { return null; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonValue = string | number | boolean | null | any[] | Record<string, any>;
function canonJson(val: JsonValue): string {
  if (val === null) return "null";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return JSON.stringify(val);
  if (typeof val === "string") {
    let out = '"';
    for (let i = 0; i < val.length; i++) {
      const cp = val.codePointAt(i)!;
      if (cp > 0xffff) {
        const hi = Math.floor((cp - 0x10000) / 0x400) + 0xd800;
        const lo = ((cp - 0x10000) % 0x400) + 0xdc00;
        out += `\\u${hi.toString(16).padStart(4, "0")}\\u${lo.toString(16).padStart(4, "0")}`;
        i++;
      } else if (cp > 0x7f) { out += `\\u${cp.toString(16).padStart(4, "0")}`;
      } else if (cp === 0x22) { out += '\\"';
      } else if (cp === 0x5c) { out += "\\\\";
      } else if (cp === 0x08) { out += "\\b";
      } else if (cp === 0x0c) { out += "\\f";
      } else if (cp === 0x0a) { out += "\\n";
      } else if (cp === 0x0d) { out += "\\r";
      } else if (cp === 0x09) { out += "\\t";
      } else if (cp < 0x20) { out += `\\u${cp.toString(16).padStart(4, "0")}`;
      } else { out += val[i]; }
    }
    return out + '"';
  }
  if (Array.isArray(val)) return "[" + (val as JsonValue[]).map(canonJson).join(",") + "]";
  const keys = Object.keys(val).sort((a, b) => {
    const la = [...a]; const lb = [...b];
    for (let i = 0; i < Math.min(la.length, lb.length); i++) {
      const d = la[i]!.codePointAt(0)! - lb[i]!.codePointAt(0)!;
      if (d !== 0) return d;
    }
    return la.length - lb.length;
  });
  return "{" + keys.map((k) => canonJson(k as JsonValue) + ":" + canonJson((val as Record<string, JsonValue>)[k] as JsonValue)).join(",") + "}";
}

/**
 * Mint an operator capability token for a CLI action.
 * Returns the token object, or null if HYDRA_OPERATOR_KEY is unset.
 */
function mintCliCapability(capability: string, resourceId: string, workflowId: string): unknown | null {
  const raw = process.env["HYDRA_OPERATOR_KEY"];
  if (!raw) return null;
  try {
    const keyBuf = hexDecode(raw) ?? Buffer.from(raw, "utf8");
    const keyId = process.env["HYDRA_OPERATOR_KEY_ID"] ?? "default";
    const nowSec = Math.floor(Date.now() / 1000);
    const payload = {
      v: 1, actor_id: OPERATOR_ACTOR_ID, actor_kind: "human",
      capability, resource_id: resourceId, workflow_id: workflowId,
      issued_at: nowSec, exp: nowSec + 300,
      jti: randomUUID(),
    };
    const sig = createHmac("sha256", keyBuf).update(canonJson(payload as JsonValue), "utf8").digest()
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return { ...payload, sig: { alg: "HMAC-SHA256", key_id: keyId, value: sig } };
  } catch { return null; }
}

/**
 * Build a capability-bearing envelope for an operator action.
 * Falls back to a plain envelope if HYDRA_OPERATOR_KEY is not configured
 * (the daemon will fail-closed for ops that require it).
 */
function opEnvelope(capability: string, resourceId: string, workflowId?: string): Record<string, unknown> {
  const env = defaultEnvelope(OPERATOR_ACTOR_ID) as Record<string, unknown>;
  const token = mintCliCapability(capability, resourceId, workflowId ?? resourceId);
  if (token !== null) env["capability_token"] = token;
  return env;
}

const program = new Command();
program.name("eights").description("TheEights — persistent self-evolving agent fabric").version("0.3.0");

program.command("init").description("Scaffold ~/.eights/").action(() => {
  const home = process.env.EIGHTS_HOME ?? join(homedir(), ".eights");
  for (const dir of [
    "events", "logs",
    "resources/prompts", "resources/teams", "resources/rubrics", "resources/policies",
    "evolution/pending", "evolution/archived",
  ]) mkdirSync(join(home, dir), { recursive: true });
  const cfg = join(home, "config.yaml");
  if (!existsSync(cfg)) {
    writeFileSync(cfg, ["graph_driver: ladybug", "embedding_dim: 768", "log_level: info", ""].join("\n"));
  }
  process.stdout.write(`initialized ${home}\n`);
});

program.command("status").description("Daemon health snapshot").action(async () => {
  const c = new EightsClient();
  await c.connect();
  try {
    const verify = await c.call<{ ok: boolean }>("eights.audit.verify", {});
    const statusEnv = defaultEnvelope(OPERATOR_ACTOR_ID);
    // Single detect_drift call (limit=1) — the engine computes total_registry,
    // total_sources, total_resources, and total across ALL resources on every call
    // regardless of limit/offset. No accumulation loop, no allDriftItems array.
    const dp = await c.call<{ total: number; total_registry: number; total_sources: number; total_resources: number }>(
      "eights.evolution.detect_drift",
      { envelope: statusEnv, limit: 1, offset: 0 },
    );
    const pendingPage = await c.call<{ items: unknown[]; total: number }>("eights.evolution.list_pending", { envelope: statusEnv });
    const pendingTotal = typeof pendingPage.total === "number" ? pendingPage.total : (Array.isArray(pendingPage) ? (pendingPage as unknown[]).length : 0);
    process.stdout.write(JSON.stringify({
      audit_chain: verify,
      drift_summary: {
        registry: dp.total_registry ?? 0,
        sources: dp.total_sources ?? 0,
        total_drifts: dp.total,
        total_resources: dp.total_resources ?? 0,
      },
      pending_proposals: pendingTotal,
    }, null, 2) + "\n");
  } finally { await c.close(); }
});

const memory = program.command("memory");
memory.command("search <query>").option("-k, --top-k <n>", "top k", "10").action(async (q: string, opts: { topK: string }) => {
  const c = new EightsClient();
  await c.connect();
  try {
    const hits = await c.call<Array<Record<string, unknown>>>("eights.memory.search", {
      envelope: defaultEnvelope(), query: q, top_k: Number(opts.topK), fusion: "hybrid",
    });
    process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
  } finally { await c.close(); }
});
memory.command("add <content>")
  .option("-t, --type <type>", "type", "episodic")
  .option("-s, --scopes <list>", "comma-separated", "")
  .action(async (content: string, opts: { type: string; scopes: string }) => {
    const c = new EightsClient();
    await c.connect();
    try {
      const result = await c.call("eights.memory.add", {
        envelope: defaultEnvelope(), content, type: opts.type,
        scopes: opts.scopes ? opts.scopes.split(",").map((s) => s.trim()).filter(Boolean) : [],
        provenance: { actor: "eights-cli" },
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } finally { await c.close(); }
  });

const ingest = program.command("ingest").description("Drive an adapter sync cycle (read-only watcher)");
ingest.command("pp").action(async () => withClient(async (c) => c.call("eights.adapters.pp.sync_now", {})));
ingest.command("exec").action(async () => withClient(async (c) => c.call("eights.adapters.exec.sync_now", {})));
ingest.command("rlm").action(async () => withClient(async (c) => c.call("eights.adapters.rlm.sync_now", {})));

const register = program.command("register").description("Bulk-register consumer artifacts as RSPL resources");
register.command("pp").action(async () => withClient(async (c) => c.call("eights.adapters.pp.register_now", { envelope: defaultEnvelope("eights.operator", "pair-programmer", "code") })));
register.command("hydra").action(async () => withClient(async (c) => c.call("eights.adapters.hydra.register_now", { envelope: defaultEnvelope("eights.operator", "Hydra", "orchestration") })));
register.command("exec").action(async () => withClient(async (c) => c.call("eights.adapters.exec.register_now", { envelope: defaultEnvelope("eights.operator", "ExecutiveSuite", "exec") })));
register.command("rlm [sibling]").action(async (sibling?: string) => withClient(async (c) => c.call("eights.adapters.rlm.register_now", { envelope: defaultEnvelope("eights.operator", sibling ?? "RLM-CLI-Starter", "rlm"), sibling })));
register.command("all").action(async () => withClient(async (c) => {
  const env = defaultEnvelope("eights.operator");
  const pp = await c.call("eights.adapters.pp.register_now", { envelope: env });
  const hy = await c.call("eights.adapters.hydra.register_now", { envelope: env });
  const ex = await c.call("eights.adapters.exec.register_now", { envelope: env });
  const rl = await c.call("eights.adapters.rlm.register_now", { envelope: env });
  return { pp, hydra: hy, exec: ex, rlm: rl };
}));

program.command("resources").description("List registered resources")
  .option("--consumer <c>", "filter by consumer (pp|hydra|execsuite|rlm|eights)")
  .option("--kind <k>", "filter by kind")
  .option("--risk <r>", "filter by risk class")
  .action(async (opts: { consumer?: string; kind?: string; risk?: string }) => withClient(async (c) => {
    // WS10: list_resources returns Page<Resource> — iterate pages until has_more=false.
    // FIX 1b: envelope required on read tools.
    const all: Array<{ rid: string; kind: string; risk_class: string; evolution_policy: string; consumer: string; sources: Array<{ source_path: string }> }> = [];
    let pageOffset = 0;
    const PAGE_LIMIT = 200;
    while (true) {
      const page = await c.call<{ items: typeof all; total: number; has_more: boolean }>("eights.evolution.list_resources", { ...opts, envelope: defaultEnvelope(OPERATOR_ACTOR_ID), limit: PAGE_LIMIT, offset: pageOffset });
      const items = Array.isArray(page.items) ? page.items : (Array.isArray(page) ? page as typeof all : []);
      all.push(...items);
      if (!page.has_more || items.length === 0) break;
      pageOffset += items.length;
    }
    process.stdout.write(JSON.stringify(all.map((r) => ({ rid: r.rid, kind: r.kind, risk: r.risk_class, policy: r.evolution_policy, consumer: r.consumer, sources: r.sources?.length ?? 0 })), null, 2) + "\n");
  }));

const resource = program.command("resource");
resource.command("show <rid>").action(async (rid: string) => withClient(async (c) => c.call("eights.evolution.get_resource", { envelope: defaultEnvelope(OPERATOR_ACTOR_ID), rid })));
resource.command("unfreeze <rid>").description("Operator-signed unfreeze (frozen → hitl-only)").action(async (rid: string) => withClient(async (c) =>
  c.call("eights.evolution.unfreeze", { envelope: opEnvelope("evolution.unfreeze", rid), rid })
));

program.command("drift").description("Scan registry + consumer source paths for drift").action(async () => {
  // Stream pages: fetch → print → discard → repeat. No allItems accumulation.
  // Each page's JSON is written to stdout independently; totals are printed last.
  const c = new EightsClient();
  await c.connect();
  try {
    const env = defaultEnvelope(OPERATOR_ACTOR_ID);
    const PAGE_LIMIT = 200;
    let pageOffset = 0;
    let total = 0;
    let totalResources = 0;
    let totalRegistry = 0;
    let totalSources = 0;
    let first = true;
    process.stdout.write("[\n");
    while (true) {
      const page = await c.call<{ items: unknown[]; total: number; total_registry: number; total_sources: number; total_resources: number; has_more: boolean }>("eights.evolution.detect_drift", { envelope: env, limit: PAGE_LIMIT, offset: pageOffset });
      const items = Array.isArray(page.items) ? page.items : [];
      if (first) {
        total = page.total ?? 0;
        totalResources = page.total_resources ?? 0;
        totalRegistry = page.total_registry ?? 0;
        totalSources = page.total_sources ?? 0;
        first = false;
      }
      for (const item of items) {
        if (pageOffset > 0 || items.indexOf(item) > 0) process.stdout.write(",\n");
        process.stdout.write("  " + JSON.stringify(item));
      }
      if (!page.has_more || items.length === 0) break;
      pageOffset += items.length;
    }
    process.stdout.write("\n]\n");
    process.stderr.write(JSON.stringify({ total_drifts: total, total_registry: totalRegistry, total_sources: totalSources, total_resources: totalResources }) + "\n");
  } finally { await c.close(); }
});

program.command("miner").description("Run the cross-project pattern miner once").action(async () => withClient(async (c) => c.call("eights.miner.run_now", {})));

program.command("bom").description("Emit CycloneDX ML-BOM v1.7").action(async () => withClient(async (c) => c.call("eights.audit.bom", {})));

program.command("review").description("Interactive HITL review queue").action(async () => {
  const c = new EightsClient();
  await c.connect();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // FIX 1b: envelope required on list_pending.
    // FIX 4: iterate all pages so the review queue is complete (not capped at page-1 limit).
    const reviewEnv = defaultEnvelope(OPERATOR_ACTOR_ID);
    type PendingProposal = { proposal_id: string; resource_rid: string; justification: string; candidate_version: string; evaluation?: { eval_delta: number; notes: string } };
    const proposals: PendingProposal[] = [];
    let reviewOffset = 0;
    const REVIEW_PAGE = 200;
    while (true) {
      const pendingRaw = await c.call<{ items: PendingProposal[]; total: number; has_more: boolean }>("eights.evolution.list_pending", { envelope: reviewEnv, limit: REVIEW_PAGE, offset: reviewOffset });
      const items = Array.isArray(pendingRaw.items) ? pendingRaw.items : [];
      proposals.push(...items);
      if (!pendingRaw.has_more || items.length === 0) break;
      reviewOffset += items.length;
    }
    if (!proposals.length) { process.stdout.write("no pending proposals\n"); return; }
    for (const p of proposals) {
      const resource = await c.call<{ kind: string; risk_class: string; consumer: string; sources: Array<{ source_path: string }> }>("eights.evolution.get_resource", { envelope: reviewEnv, rid: p.resource_rid });
      process.stdout.write("\n----\n");
      process.stdout.write(`proposal: ${p.proposal_id}\n`);
      process.stdout.write(`resource: ${p.resource_rid} (${resource?.kind}/${resource?.risk_class}, consumer=${resource?.consumer})\n`);
      process.stdout.write(`-> version: ${p.candidate_version}\n`);
      process.stdout.write(`why: ${p.justification}\n`);
      if (p.evaluation) process.stdout.write(`eval: delta=${p.evaluation.eval_delta} — ${p.evaluation.notes}\n`);
      if (resource?.sources?.length) process.stdout.write(`sources:\n  ${resource.sources.map((s) => s.source_path).join("\n  ")}\n`);
      const action = (await rl.question("[a]pprove / [r]eject / [s]kip / [q]uit > ")).trim().toLowerCase();
      if (action === "q") break;
      if (action === "a") {
        // For hitl-only resources, approve() requires a pre-approved HITL row.
        // Step 1: find the pending evolution.approve HITL row for this proposal.
        // Step 2: resolve it (operator hitl.resolve token, scoped to request_id).
        // Step 3: call evolution.approve with the approve capability token.
        // For auto/auto-low-risk resources the HITL row is absent — step 1 is a no-op.
        const hitlList = await c.call<Array<{ request_id: string; kind: string; payload: { proposal_id?: string } }>>(
          "eights.governance.hitl.list", { envelope: defaultEnvelope(OPERATOR_ACTOR_ID), status: "pending" },
        );
        const hitlRow = hitlList.find((r) => r.kind === "evolution.approve" && r.payload?.proposal_id === p.proposal_id);
        if (hitlRow) {
          // Resolve the HITL row first. workflow_id = request_id (no run_id on evolution.approve rows).
          await c.call("eights.governance.hitl.resolve", {
            envelope: opEnvelope("hitl.resolve", hitlRow.request_id, hitlRow.request_id),
            request_id: hitlRow.request_id,
            decision: "approved",
            note: "operator approved via CLI",
          });
        }
        const r = await c.call("eights.evolution.approve", {
          envelope: opEnvelope("evolution.approve", p.proposal_id),
          proposal_id: p.proposal_id,
        });
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      } else if (action === "r") {
        const reason = (await rl.question("reason > ")).trim() || "no reason given";
        await c.call("eights.evolution.reject", {
          envelope: opEnvelope("evolution.reject", p.proposal_id),
          proposal_id: p.proposal_id, reason,
        });
      }
    }
  } finally { rl.close(); await c.close(); }
});

async function withClient(fn: (c: EightsClient) => Promise<unknown>): Promise<void> {
  const c = new EightsClient();
  await c.connect();
  try {
    const out = await fn(c);
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } finally { await c.close(); }
}

program.parseAsync(process.argv).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
