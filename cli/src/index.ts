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
program
  .name("eights")
  .description("TheEights — persistent self-evolving agent fabric")
  .version("0.2.0");

program.command("init").description("Scaffold ~/.eights/").action(() => {
  const home = process.env.EIGHTS_HOME ?? join(homedir(), ".eights");
  for (const dir of [
    "events", "logs",
    "resources/prompts", "resources/teams", "resources/rubrics", "resources/policies",
    "evolution/pending", "evolution/archived",
  ]) mkdirSync(join(home, dir), { recursive: true });
  const cfg = join(home, "config.yaml");
  if (!existsSync(cfg)) {
    writeFileSync(cfg, [
      "graph_driver: ladybug",
      "embedding_dim: 768",
      "log_level: info",
      "",
    ].join("\n"));
  }
  process.stdout.write(`initialized ${home}\n`);
});

program.command("status").description("Daemon health snapshot").action(async () => {
  const c = new EightsClient();
  await c.connect();
  try {
    const verify = await c.call<{ ok: boolean }>("eights.audit.verify", {});
    const drift = await c.call<unknown[]>("eights.evolution.detect_drift", {});
    const pending = await c.call<unknown[]>("eights.evolution.list_pending", {});
    process.stdout.write(JSON.stringify({ audit_chain: verify, drift, pending_proposals: pending }, null, 2) + "\n");
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
        envelope: defaultEnvelope(),
        content, type: opts.type,
        scopes: opts.scopes ? opts.scopes.split(",").map((s) => s.trim()).filter(Boolean) : [],
        provenance: { actor: "eights-cli" },
      });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } finally { await c.close(); }
  });

const ingest = program.command("ingest").description("Drive an adapter sync cycle");
ingest.command("pp").action(async () => {
  const c = new EightsClient(); await c.connect();
  try { process.stdout.write(JSON.stringify(await c.call("eights.adapters.pp.sync_now", {}), null, 2) + "\n"); }
  finally { await c.close(); }
});
ingest.command("exec").action(async () => {
  const c = new EightsClient(); await c.connect();
  try { process.stdout.write(JSON.stringify(await c.call("eights.adapters.exec.sync_now", {}), null, 2) + "\n"); }
  finally { await c.close(); }
});
ingest.command("rlm").action(async () => {
  const c = new EightsClient(); await c.connect();
  try { process.stdout.write(JSON.stringify(await c.call("eights.adapters.rlm.sync_now", {}), null, 2) + "\n"); }
  finally { await c.close(); }
});

program.command("miner").description("Run the cross-project pattern miner once").action(async () => {
  const c = new EightsClient(); await c.connect();
  try { process.stdout.write(JSON.stringify(await c.call("eights.miner.run_now", {}), null, 2) + "\n"); }
  finally { await c.close(); }
});

program.command("bom").description("Emit CycloneDX ML-BOM v1.7").action(async () => {
  const c = new EightsClient(); await c.connect();
  try { process.stdout.write(JSON.stringify(await c.call("eights.audit.bom", {}), null, 2) + "\n"); }
  finally { await c.close(); }
});

program.command("review").description("Interactive HITL review queue").action(async () => {
  const c = new EightsClient();
  await c.connect();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const proposals = await c.call<Array<{ proposal_id: string; resource_rid: string; justification: string; candidate_version: string }>>("eights.evolution.list_pending", {});
    if (!proposals.length) {
      process.stdout.write("no pending proposals\n");
      return;
    }
    for (const p of proposals) {
      process.stdout.write("\n----\n");
      process.stdout.write(`proposal: ${p.proposal_id}\n`);
      process.stdout.write(`resource: ${p.resource_rid} → ${p.candidate_version}\n`);
      process.stdout.write(`why: ${p.justification}\n`);
      const action = (await rl.question("[a]pprove / [r]eject / [s]kip / [q]uit > ")).trim().toLowerCase();
      if (action === "q") break;
      if (action === "a") {
        const r = await c.call("eights.evolution.approve", { envelope: defaultEnvelope("eights.operator"), proposal_id: p.proposal_id });
        process.stdout.write(JSON.stringify(r) + "\n");
      } else if (action === "r") {
        const reason = (await rl.question("reason > ")).trim() || "no reason given";
        await c.call("eights.evolution.reject", { envelope: defaultEnvelope("eights.operator"), proposal_id: p.proposal_id, reason });
      }
    }
  } finally {
    rl.close();
    await c.close();
  }
});

program.parseAsync(process.argv).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
