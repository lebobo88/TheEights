#!/usr/bin/env node
/**
 * `eights` CLI — thin shim over the daemon's MCP surface.
 */
import { Command } from "commander";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { EightsClient, defaultEnvelope } from "./mcp-client.js";

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
    const drift = await c.call<{ registry: unknown[]; sources: unknown[] }>("eights.evolution.detect_drift", {});
    const pending = await c.call<unknown[]>("eights.evolution.list_pending", {});
    process.stdout.write(JSON.stringify({ audit_chain: verify, drift_summary: { registry: drift.registry.length, sources: drift.sources.length }, pending_proposals: pending.length }, null, 2) + "\n");
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
    const res = await c.call<Array<{ rid: string; kind: string; risk_class: string; evolution_policy: string; consumer: string; sources: Array<{ source_path: string }> }>>("eights.evolution.list_resources", opts);
    process.stdout.write(JSON.stringify(res.map((r) => ({ rid: r.rid, kind: r.kind, risk: r.risk_class, policy: r.evolution_policy, consumer: r.consumer, sources: r.sources?.length ?? 0 })), null, 2) + "\n");
  }));

const resource = program.command("resource");
resource.command("show <rid>").action(async (rid: string) => withClient(async (c) => c.call("eights.evolution.get_resource", { rid })));
resource.command("unfreeze <rid>").description("Operator-signed unfreeze (frozen → hitl-only)").action(async (rid: string) => withClient(async (c) =>
  c.call("eights.evolution.unfreeze", { envelope: defaultEnvelope("eights.operator"), rid })
));

program.command("drift").description("Scan registry + consumer source paths for drift").action(async () => withClient(async (c) => c.call("eights.evolution.detect_drift", {})));

program.command("miner").description("Run the cross-project pattern miner once").action(async () => withClient(async (c) => c.call("eights.miner.run_now", {})));

program.command("bom").description("Emit CycloneDX ML-BOM v1.7").action(async () => withClient(async (c) => c.call("eights.audit.bom", {})));

program.command("review").description("Interactive HITL review queue").action(async () => {
  const c = new EightsClient();
  await c.connect();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const proposals = await c.call<Array<{ proposal_id: string; resource_rid: string; justification: string; candidate_version: string; evaluation?: { eval_delta: number; notes: string } }>>("eights.evolution.list_pending", {});
    if (!proposals.length) { process.stdout.write("no pending proposals\n"); return; }
    for (const p of proposals) {
      const resource = await c.call<{ kind: string; risk_class: string; consumer: string; sources: Array<{ source_path: string }> }>("eights.evolution.get_resource", { rid: p.resource_rid });
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
        const r = await c.call("eights.evolution.approve", { envelope: defaultEnvelope("eights.operator"), proposal_id: p.proposal_id });
        process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      } else if (action === "r") {
        const reason = (await rl.question("reason > ")).trim() || "no reason given";
        await c.call("eights.evolution.reject", { envelope: defaultEnvelope("eights.operator"), proposal_id: p.proposal_id, reason });
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
