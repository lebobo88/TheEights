#!/usr/bin/env node
// Reproduce Claude Code's MCP stdio spawn pattern.
// Args + env mirror ~/.claude.json's eights entry exactly.
import { spawn } from "node:child_process";
import { unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the daemon relative to this probe (daemon/test -> daemon/dist), so it
// works on any clone. Env override mirrors the real CLI/registration contract.
const DAEMON_JS = process.env.EIGHTS_DAEMON_JS
  ?? fileURLToPath(new URL("../dist/index.js", import.meta.url));

const pidPath = join(homedir(), ".eights", "eights.pid");
if (existsSync(pidPath)) {
  try { unlinkSync(pidPath); console.error("[probe] cleared stale pidfile"); } catch {}
}

const t0 = Date.now();
const child = spawn(
  "node",
  [DAEMON_JS],
  {
    env: { ...process.env, EIGHTS_LOG_LEVEL: "info" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  },
);

let stdoutBuf = "";
let firstResponseAt = null;
let toolsListAt = null;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk;
  const lines = stdoutBuf.split("\n");
  stdoutBuf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    const dt = ((Date.now() - t0) / 1000).toFixed(2);
    let msg;
    try { msg = JSON.parse(line); } catch { console.error(`[${dt}s] non-json stdout: ${line.slice(0, 200)}`); continue; }
    if (msg.id === 1 && !firstResponseAt) {
      firstResponseAt = dt;
      console.error(`[${dt}s] initialize response received`);
      // Send notifications/initialized + tools/list
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    } else if (msg.id === 2 && !toolsListAt) {
      toolsListAt = dt;
      const count = msg.result?.tools?.length ?? "?";
      console.error(`[${dt}s] tools/list response received — ${count} tools`);
      child.stdin.end();
      setTimeout(() => { child.kill(); process.exit(0); }, 500);
    } else {
      console.error(`[${dt}s] unexpected message: ${JSON.stringify(msg).slice(0, 200)}`);
    }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  for (const line of chunk.split("\n")) {
    if (line) console.error(`[${dt}s][stderr] ${line}`);
  }
});

child.on("exit", (code, sig) => {
  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  console.error(`[${dt}s] child exit code=${code} sig=${sig}`);
  process.exit(0);
});

// Send initialize after the daemon logs "stdio MCP transport active" — eliminates
// the "wrote-before-listener-attached" theory.
import { readFileSync } from "node:fs";
const logPath = `${process.env.USERPROFILE}/.eights/logs/eights-daemon-${new Date().toISOString().slice(0,10)}.log`;
const startMark = Date.now();
const poll = setInterval(() => {
  try {
    const log = readFileSync(logPath, "utf8");
    if (log.includes(`"pid":${child.pid},"hostname":"`) && log.includes(`stdio MCP transport active`)) {
      const ready = ((Date.now() - t0) / 1000).toFixed(2);
      console.error(`[${ready}s] daemon log shows transport active — sending initialize`);
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "claude-probe", version: "0.0.1" },
          },
        }) + "\n",
      );
      clearInterval(poll);
    }
  } catch {}
  if (Date.now() - startMark > 60000) clearInterval(poll);
}, 100);

// Hard ceiling so we don't hang the test run forever.
setTimeout(() => {
  const dt = ((Date.now() - t0) / 1000).toFixed(2);
  console.error(`[${dt}s] HARD TIMEOUT — initFirst=${firstResponseAt}s, tools=${toolsListAt}s`);
  child.kill();
  process.exit(2);
}, 120000);
