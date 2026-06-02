/**
 * Living Agent-BOM Atlas — read-only MCP bridge.
 *
 * A localhost-ONLY Node server that is JUST ANOTHER MCP CLIENT, exactly like
 * the eights CLI. It exposes a thin REST/JSON facade that the React Atlas polls
 * for live observability. It owns NO new daemon surface — it talks to the
 * existing daemon over the existing MCP stdio boundary (EightsClient).
 *
 * GUARANTEES (inviolable, from AGENTS.md + CONSTITUTION.md §III):
 *   - INVARIANT #1: fixed read-only Envelope (atlasEnvelope) — actor
 *     "eights-atlas", project "TheEights", domain "infra", EMPTY scope. No
 *     request path can broaden it.
 *   - READ-ONLY: every daemon call goes through allowTool() — a hard whitelist
 *     of 13 read tools + a forbidden-verb denylist. No write/commit/approve.
 *   - INVARIANT #3: the audit engine is untouched. Every proxied read still
 *     produces a daemon audit event — the observability tool is itself observed.
 *   - LOOPBACK ONLY: binds 127.0.0.1. No non-loopback exposure, no telemetry,
 *     no outbound beyond the daemon stdio.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EightsClient, atlasEnvelope } from "./eights-client.ts";
import { allowTool, READ_ONLY_TOOLS } from "./whitelist.ts";
import { allowWriteTool, WRITE_TOOLS, type WriteTool } from "./write-whitelist.ts";
import { operatorEnvelope, sessionToken, verifyToken } from "./operator.ts";

const HOST = "127.0.0.1"; // loopback only — never 0.0.0.0
const PREFERRED_PORT = Number(process.env.EIGHTS_ATLAS_BRIDGE_PORT ?? 8788);
// If the operator pins the port explicitly, honor it strictly (fail loudly on
// conflict). Otherwise we PREFLIGHT and roll forward to the next free port so a
// stale/parallel bridge never produces a silent EADDRINUSE crash.
const PORT_PINNED = process.env.EIGHTS_ATLAS_BRIDGE_PORT != null;
const PORT_MAX_PROBES = 25;
// The actual bound port, written to PORT_FILE on listen so the vite dev proxy
// can discover us even if we rolled forward off the preferred port.
let boundPort = PREFERRED_PORT;
const PORT_FILE = fileURLToPath(new URL("../.atlas-bridge-port", import.meta.url));
const VERIFY_MIN_INTERVAL_MS = Number(process.env.EIGHTS_ATLAS_VERIFY_MS ?? 300_000); // 5 min — the walk is ~20s; once per snapshot-burst is plenty

/** True iff `port` can currently be bound on HOST (loopback). */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

/** Preflight: the preferred port if free, else the next free one (or throw). */
async function choosePort(): Promise<number> {
  if (await portFree(PREFERRED_PORT)) return PREFERRED_PORT;
  if (PORT_PINNED) {
    throw new Error(
      `EIGHTS_ATLAS_BRIDGE_PORT=${PREFERRED_PORT} is already in use. ` +
        `Free that port or set EIGHTS_ATLAS_BRIDGE_PORT to a free one.`,
    );
  }
  for (let p = PREFERRED_PORT + 1; p <= PREFERRED_PORT + PORT_MAX_PROBES; p++) {
    if (await portFree(p)) return p;
  }
  throw new Error(
    `no free port in ${PREFERRED_PORT}..${PREFERRED_PORT + PORT_MAX_PROBES}; ` +
      `set EIGHTS_ATLAS_BRIDGE_PORT to a free port.`,
  );
}

const client = new EightsClient();
let clientReady: Promise<void> | null = null;

async function ensureClient(): Promise<void> {
  if (client.connected) return;
  if (!clientReady) {
    clientReady = client.connect().catch((e) => {
      clientReady = null;
      throw e;
    });
  }
  await clientReady;
}

/**
 * The ONLY way this process calls the daemon. Refuses anything not on the
 * read-only whitelist BEFORE connecting, and always injects the fixed envelope.
 */
// Serialize all daemon calls. better-sqlite3's synchronous API throws
// "This database connection is busy executing a query" if a query begins while
// another is mid-flight on the same connection — and our daemon child runs
// background watchers/cognitive jobs on that connection. We MUST NOT modify
// daemon/src, so we keep the bridge to one in-flight call at a time and retry
// once on the transient busy error.
let callChain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = callChain.then(fn, fn);
  callChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run as Promise<T>;
}
const isBusy = (e: unknown): boolean =>
  e instanceof Error && /busy executing a query/i.test(e.message);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function readTool<T = unknown>(tool: string, extra: Record<string, unknown> = {}): Promise<T> {
  if (!allowTool(tool)) {
    throw Object.assign(new Error(`tool '${tool}' is not on the read-only whitelist`), {
      code: "FORBIDDEN_TOOL",
    });
  }
  await ensureClient();
  // The daemon namespaces tools as eights.<tool>; the gateway/cli use the bare
  // tool name. We pass through the bare whitelisted name + the fixed envelope.
  return serialize(async () => {
    try {
      return await client.call<T>(`eights.${tool}`, { ...extra, envelope: atlasEnvelope() });
    } catch (e) {
      if (!isBusy(e)) throw e;
      await sleep(120);
      return client.call<T>(`eights.${tool}`, { ...extra, envelope: atlasEnvelope() });
    }
  });
}

/* ---------------- GOVERNED WRITE PATH ----------------
   Separate from readTool by construction:
     - distinct write allowlist (exactly {approve,reject,rollback})
     - distinct OPERATOR envelope (actor operator-rob, domain governance, minimal
       scope) — NOT the read-only eights-atlas envelope
     - goes through the SAME serialize() mutex + busy-retry as reads (one in-flight
       call to the shared sqlite connection)
   The tool name is a server-controlled literal; only the validated args flow in.
   Every call is a GOVERNED eights.evolution.* tool that enforces policy/HITL/
   frozen-refusal/write-back/audit on the daemon side. We NEVER bypass governance. */
async function writeTool<T = unknown>(
  tool: WriteTool,
  args: Record<string, unknown>,
): Promise<T> {
  if (!allowWriteTool(tool)) {
    throw Object.assign(new Error(`tool '${tool}' is not on the write allowlist`), {
      code: "FORBIDDEN_TOOL",
    });
  }
  await ensureClient();
  return serialize(async () => {
    try {
      return await client.call<T>(`eights.${tool}`, { ...args, envelope: operatorEnvelope() });
    } catch (e) {
      if (!isBusy(e)) throw e;
      await sleep(120);
      return client.call<T>(`eights.${tool}`, { ...args, envelope: operatorEnvelope() });
    }
  });
}

/* ---- server-side risk / frozen guard ----
   The UI surfaces risk and disables frozen/critical, but the SERVER is the
   authority (Invariant #3, #5). Before any mutating action we resolve the target
   resource via the read-path get_resource and refuse frozen/critical here, with a
   clear "requires operator unfreeze (CLI)" message — rather than letting the
   daemon refuse opaquely or pretending success. evolution.get_resource is a READ
   (no envelope), so we route it through readTool (read-only atlas envelope). */
interface ResourceMeta {
  rid: string;
  risk_class?: string;
  evolution_policy?: string;
  current_version?: string;
  versions?: Array<{ version: string; created_at?: string; justification?: string }>;
}

async function getResourceMeta(rid: string): Promise<ResourceMeta> {
  return readTool<ResourceMeta>("evolution.get_resource", { rid });
}

/** True for resources the bridge refuses to mutate without an operator CLI
    unfreeze: frozen evolution_policy OR critical risk_class. */
function isFrozenOrCritical(m: ResourceMeta): boolean {
  return m.evolution_policy === "frozen" || m.risk_class === "critical";
}

const FROZEN_REFUSAL =
  "refused: this resource is frozen/critical and requires an operator unfreeze (CLI: `eights evolution unfreeze <rid>`) before it can be changed from the Atlas";

/** Resolve the proposal_id -> its target resource_rid via list_pending so the
    risk/frozen guard can run on approve/reject (which take a proposal_id, not a
    rid). Returns null if the proposal is not found in the pending set. */
async function ridForProposal(proposalId: string): Promise<string | null> {
  const pending = await readTool<Array<{ proposal_id?: string; resource_rid?: string }>>(
    "evolution.list_pending",
  );
  const hit = (Array.isArray(pending) ? pending : []).find((p) => p.proposal_id === proposalId);
  return hit?.resource_rid ?? null;
}

/* ---- write-path input validation ----
   The browser supplies ONLY: proposal_id, reason (string), to_version, rid.
   Tool names are NEVER client-supplied. We validate shape defensively. */
const PROPOSAL_ID_RE = /^prop_[A-Za-z0-9_-]{1,64}$/;
const VERSION_RE = /^sha256:[0-9a-f]{64}$/;
const RID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,200}$/;

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      raw += c.toString("utf8");
      if (raw.length > 64 * 1024) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return reject(new Error("request body too large"));
      if (!raw.trim()) return resolve({});
      try {
        const v = JSON.parse(raw) as unknown;
        if (v && typeof v === "object" && !Array.isArray(v)) resolve(v as Record<string, unknown>);
        else reject(new Error("body must be a JSON object"));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/* ---- chain status ----
   audit.verify is a FULL-CHAIN walk (~20s on a 658k-event chain). It must NEVER
   run inside the /api/atlas/live request path: it shares the single-call mutex
   (one sqlite connection on the daemon child), so awaiting it there would stall
   every other read behind it and keep the UI on the offline fallback. Instead we
   keep a cached result, refresh it in the BACKGROUND (one at a time, rarely), and
   hand callers the cached value instantly. */
let lastVerify = 0;
let verifyInFlight = false;
let lastVerifyResult: { ok: boolean | null; brokenAt?: number | null; checkedAt: string | null } = {
  ok: null,
  brokenAt: null,
  checkedAt: null,
};

/** Instant: the last-known chain status, no daemon call. */
function chainSnapshot(): typeof lastVerifyResult {
  return lastVerifyResult;
}

/** Fire-and-forget: refresh the chain status in the background iff it's stale
    and no verify is already running. Goes through the mutex like any read, so it
    yields to in-flight calls and only occupies the connection when it's its turn. */
function refreshChainInBackground(): void {
  if (verifyInFlight) return;
  if (lastVerifyResult.checkedAt && Date.now() - lastVerify < VERIFY_MIN_INTERVAL_MS) return;
  verifyInFlight = true;
  lastVerify = Date.now();
  void readTool<{ ok?: boolean; broken_at?: number }>("audit.verify")
    .then((r) => {
      lastVerifyResult = { ok: r.ok ?? null, brokenAt: r.broken_at ?? null, checkedAt: new Date().toISOString() };
    })
    .catch(() => {
      lastVerifyResult = { ok: null, brokenAt: null, checkedAt: new Date().toISOString() };
    })
    .finally(() => {
      verifyInFlight = false;
    });
}

/** On-demand chain status for /api/chain/status: kick a background refresh,
    return whatever we have cached right now (never blocks on the walk). */
async function chainStatus(): Promise<typeof lastVerifyResult> {
  refreshChainInBackground();
  return chainSnapshot();
}

/* ---- consumer mapping: live resources → static graph cons-<id> ---- */
const CONSUMER_KEYS = ["pp", "hydra", "execsuite", "rlm", "marketbliss", "agentsmith", "eights"];

/** Map a recent audit event to a static-graph edge so the live hook can pulse it. */
function mapEventToEdge(ev: { actor?: string; kind?: string }): { s?: string; t?: string } {
  const actor = (ev.actor ?? "").toLowerCase();
  for (const c of CONSUMER_KEYS) {
    if (actor.includes(c)) return { s: `cons-${c}`, t: "core" };
  }
  const kind = (ev.kind ?? "").toLowerCase();
  if (kind.includes("memory")) return { s: "mem-episodic", t: "eng-memory" };
  if (kind.includes("evolution") || kind.includes("propose")) return { s: "eng-evolution", t: "eng-policy" };
  if (kind.includes("hydra") || kind.includes("envelope")) return { s: "eng-hydra", t: "core" };
  if (kind.includes("audit")) return { s: "eng-audit", t: "store-eventlog" };
  return { s: "core", t: "hub-mcp" };
}

/* ---- pending-proposal risk cache ----
   eights.evolution.list_pending returns `resource_rid` (NOT `rid`) and omits
   `risk_class`. We map the rid correctly and resolve risk once per rid via
   get_resource, caching it so /api/atlas/live stays cheap on every poll
   (after the first poll, all pending rids are cached → zero extra calls). */
const riskCache = new Map<string, string>();
let riskEnriching = false;
/** Fire-and-forget: resolve risk_class for any uncached pending rids in the
    background (one get_resource each, serialized via the mutex). NEVER awaited by
    the snapshot — risk simply appears on the next poll once cached. This keeps the
    /api/atlas/live path to its ~7 core calls instead of +20 on a cold cache. */
function enrichRiskInBackground(rids: string[]): void {
  if (riskEnriching) return;
  const missing = [...new Set(rids)].filter((r) => r && !riskCache.has(r));
  if (!missing.length) return;
  riskEnriching = true;
  void (async () => {
    for (const rid of missing) {
      try {
        const r = await readTool<{ risk_class?: string }>("evolution.get_resource", { rid });
        riskCache.set(rid, r.risk_class ?? "");
      } catch {
        riskCache.set(rid, "");
      }
    }
  })().finally(() => {
    riskEnriching = false;
  });
}

/* ---------------- aggregate snapshot ---------------- */
async function buildSnapshot(): Promise<Record<string, unknown>> {
  const settle = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  };

  // Sequential, not Promise.all: every daemon call goes through the serialize()
  // mutex anyway (single in-flight call to the shared sqlite connection), so we
  // await them in order for clarity and to keep collisions impossible.
  const resources = await settle(readTool<Array<{ consumer?: string }>>("evolution.list_resources"), []);
  const pending = await settle(
    readTool<
      Array<{
        resource_rid?: string;
        risk_class?: string;
        consumer?: string;
        proposal_id?: string;
        status?: string;
        proposed_by?: string;
        proposed_at?: string;
        candidate_version?: string;
        justification?: string;
        candidate_content?: string;
      }>
    >("evolution.list_pending"),
    [],
  );
  const hitl = await settle(readTool<{ items?: Array<{ id?: string; reason?: string }> }>("governance.hitl.list", { status: "pending" }), { items: [] });
  const cells = await settle(readTool<Record<string, number>>("cells.distribution", { scope: {} }), {});
  const envelopes = await settle(readTool<{ count?: number; items?: unknown[] }>("hydra.envelope.query", { workflow_id: "" }), {});
  const handoffs = await settle(readTool<{ count?: number; items?: unknown[] }>("hydra.handoff.list", { workflow_id: "" }), {});
  const recent = await settle(readTool<Array<{ actor?: string; kind?: string; ts?: string }>>("audit.trace", { limit: 40 }), []);
  // Non-blocking: use the cached chain status and refresh it in the background.
  // The expensive full-chain audit.verify never stalls this snapshot.
  refreshChainInBackground();
  const chain = chainSnapshot();

  const resourcesByConsumer: Record<string, number> = {};
  for (const r of resources) {
    const c = r.consumer ?? "unknown";
    resourcesByConsumer[c] = (resourcesByConsumer[c] ?? 0) + 1;
  }

  enrichRiskInBackground(pending.map((p) => p.resource_rid ?? ""));

  const hitlItems = Array.isArray(hitl.items) ? hitl.items : [];
  const recentEvents = (Array.isArray(recent) ? recent : []).map((ev) => ({
    ...mapEventToEdge(ev),
    actor: ev.actor,
    kind: ev.kind,
    ts: ev.ts,
  }));

  const envCount = Array.isArray((envelopes as { items?: unknown[] }).items)
    ? (envelopes as { items: unknown[] }).items.length
    : ((envelopes as { count?: number }).count ?? 0);
  const hoCount = Array.isArray((handoffs as { items?: unknown[] }).items)
    ? (handoffs as { items: unknown[] }).items.length
    : ((handoffs as { count?: number }).count ?? 0);

  return {
    generatedAt: new Date().toISOString(),
    counts: {
      // Total event count is not cheaply available over the read-only surface
      // (a full-chain count would be expensive); the frontend falls back to the
      // baked value when this is null. recentEventsWindow exposes the live tail.
      events: null,
      resources: resources.length,
      pending: pending.length,
    },
    recentEventsWindow: recentEvents.length,
    chain,
    pending: pending.map((p) => {
      const rid = p.resource_rid ?? "";
      // Carry the full proposal record so the inspector can show it on click.
      // Cap candidate_content so a few large proposals can't bloat the snapshot.
      const content = p.candidate_content ?? "";
      const CAP = 8000;
      return {
        rid,
        risk: p.risk_class ?? riskCache.get(rid) ?? "",
        consumer: p.consumer,
        proposal_id: p.proposal_id,
        status: p.status,
        proposed_by: p.proposed_by,
        proposed_at: p.proposed_at,
        candidate_version: p.candidate_version,
        justification: p.justification ?? "",
        candidate_content: content.length > CAP ? content.slice(0, CAP) + "\n… (truncated)" : content,
      };
    }),
    hitl: { pending: hitlItems.length, items: hitlItems },
    resourcesByConsumer,
    cells: cells ?? {},
    envelopes: { count: envCount },
    handoffs: { count: hoCount },
    recentEvents,
  };
}

/* ---------------- HTTP plumbing ---------------- */
function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

/* ---------------- governed write endpoints ----------------
   POST-only. Each one: verify CSRF token -> validate args -> server-side
   risk/frozen guard -> invoke the GOVERNED eights.evolution.* tool with the
   operator envelope -> return a structured result {ok, action, ..., result}.
   The daemon audits every action under actor operator-rob. */

/** Shared CSRF gate for every write. Returns true iff the X-Atlas-Token header
    matches the session token; otherwise writes a 403 and returns false. */
function csrfOk(req: IncomingMessage, res: ServerResponse): boolean {
  const presented = req.headers["x-atlas-token"];
  const token = Array.isArray(presented) ? presented[0] : presented;
  if (!verifyToken(token)) {
    json(res, 403, { error: "missing or invalid X-Atlas-Token (CSRF)", code: "CSRF" });
    return false;
  }
  return true;
}

async function handleApprove(
  res: ServerResponse,
  proposalId: string,
): Promise<void> {
  if (!PROPOSAL_ID_RE.test(proposalId)) {
    json(res, 400, { error: "invalid proposal_id" });
    return;
  }
  const rid = await ridForProposal(proposalId);
  if (!rid) {
    json(res, 404, { error: "proposal not found in pending set", proposal_id: proposalId });
    return;
  }
  const meta = await getResourceMeta(rid);
  if (isFrozenOrCritical(meta)) {
    json(res, 409, { error: FROZEN_REFUSAL, code: "FROZEN", rid, risk: meta.risk_class, policy: meta.evolution_policy });
    return;
  }
  const result = await writeTool("evolution.approve", { proposal_id: proposalId });
  json(res, 200, { ok: true, action: "approve", proposal_id: proposalId, rid, result });
}

async function handleReject(
  req: IncomingMessage,
  res: ServerResponse,
  proposalId: string,
): Promise<void> {
  if (!PROPOSAL_ID_RE.test(proposalId)) {
    json(res, 400, { error: "invalid proposal_id" });
    return;
  }
  const body = await readBody(req);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    json(res, 400, { error: "reject requires a non-empty reason" });
    return;
  }
  if (reason.length > 2000) {
    json(res, 400, { error: "reason too long (max 2000 chars)" });
    return;
  }
  const rid = await ridForProposal(proposalId);
  if (!rid) {
    json(res, 404, { error: "proposal not found in pending set", proposal_id: proposalId });
    return;
  }
  const meta = await getResourceMeta(rid);
  if (isFrozenOrCritical(meta)) {
    json(res, 409, { error: FROZEN_REFUSAL, code: "FROZEN", rid, risk: meta.risk_class, policy: meta.evolution_policy });
    return;
  }
  const result = await writeTool("evolution.reject", { proposal_id: proposalId, reason });
  json(res, 200, { ok: true, action: "reject", proposal_id: proposalId, rid, result });
}

async function handleRollback(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const rid = typeof body.rid === "string" ? body.rid : "";
  const toVersion = typeof body.to_version === "string" ? body.to_version : "";
  if (!RID_RE.test(rid)) {
    json(res, 400, { error: "invalid rid" });
    return;
  }
  if (!VERSION_RE.test(toVersion)) {
    json(res, 400, { error: "invalid to_version (expected sha256:<64 hex>)" });
    return;
  }
  const meta = await getResourceMeta(rid);
  if (isFrozenOrCritical(meta)) {
    json(res, 409, { error: FROZEN_REFUSAL, code: "FROZEN", rid, risk: meta.risk_class, policy: meta.evolution_policy });
    return;
  }
  // Validate to_version against the resource's REAL version list — the browser
  // cannot roll back to an arbitrary/forged hash.
  const known = (meta.versions ?? []).some((v) => v.version === toVersion);
  if (!known) {
    json(res, 400, { error: "to_version is not a known version of this resource", rid });
    return;
  }
  const result = await writeTool("evolution.rollback", { rid, to_version: toVersion });
  json(res, 200, { ok: true, action: "rollback", rid, to_version: toVersion, result });
}

/** Route a POST write request. Patterns:
      POST /api/proposals/:id/approve
      POST /api/proposals/:id/reject     { reason }
      POST /api/resources/rollback       { rid, to_version } */
async function handleWrite(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (!csrfOk(req, res)) return;
  const approve = /^\/api\/proposals\/([^/]+)\/approve$/.exec(path);
  if (approve) return handleApprove(res, decodeURIComponent(approve[1]!));
  const reject = /^\/api\/proposals\/([^/]+)\/reject$/.exec(path);
  if (reject) return handleReject(req, res, decodeURIComponent(reject[1]!));
  if (path === "/api/resources/rollback") return handleRollback(req, res);
  json(res, 404, { error: "not found" });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Reject any request whose Host header is not loopback (defense in depth on
  // top of the 127.0.0.1 bind — blocks DNS-rebinding). Applies to BOTH read and
  // write paths.
  const host = (req.headers.host ?? "").split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost") {
    json(res, 403, { error: "loopback only" });
    return;
  }

  const url = new URL(req.url ?? "/", `http://${HOST}:${boundPort}`);
  const path = url.pathname;

  // GOVERNED WRITE PATH: POST-only, CSRF-gated, separate write allowlist.
  if (req.method === "POST") {
    try {
      await handleWrite(req, res, path);
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "FORBIDDEN_TOOL") {
        json(res, 403, { error: err.message });
        return;
      }
      json(res, 502, { error: "bridge upstream error", detail: err.message });
    }
    return;
  }

  // READ PATH: only GET is allowed (unchanged). Everything else is rejected.
  if (req.method !== "GET") {
    json(res, 405, { error: "method not allowed (GET reads / POST governed writes only)" });
    return;
  }

  try {
    switch (path) {
      case "/api/health":
        json(res, 200, {
          ok: true,
          whitelist: READ_ONLY_TOOLS,
          writeWhitelist: WRITE_TOOLS,
          daemon: client.connected,
        });
        return;
      case "/api/session":
        // Same-origin only (Host already verified loopback above). Hands the
        // browser the per-session CSRF token it must echo as X-Atlas-Token on
        // every write. Never set on a write response; only mintable via this GET.
        json(res, 200, { token: sessionToken(), actor: "operator-rob" });
        return;
      case "/api/atlas/live":
        json(res, 200, await buildSnapshot());
        return;
      case "/api/events/recent":
        json(res, 200, { items: await readTool("audit.trace", { limit: Number(url.searchParams.get("limit") ?? 40) }) });
        return;
      case "/api/hitl":
        json(res, 200, await readTool("governance.hitl.list", { status: "pending" }));
        return;
      case "/api/resources/counts": {
        const resources = await readTool<Array<{ consumer?: string }>>("evolution.list_resources");
        const byConsumer: Record<string, number> = {};
        for (const r of resources) byConsumer[r.consumer ?? "unknown"] = (byConsumer[r.consumer ?? "unknown"] ?? 0) + 1;
        json(res, 200, { total: resources.length, byConsumer });
        return;
      }
      case "/api/chain/status":
        json(res, 200, await chainStatus());
        return;
      case "/api/resources/detail": {
        // Read-path: resolve a resource's version history for the rollback
        // version picker. Goes through readTool (read-only atlas envelope,
        // evolution.get_resource is whitelisted). The rid is validated; only the
        // fields the picker needs are returned.
        const rid = url.searchParams.get("rid") ?? "";
        if (!RID_RE.test(rid)) {
          json(res, 400, { error: "invalid rid" });
          return;
        }
        const m = await getResourceMeta(rid);
        json(res, 200, {
          rid: m.rid,
          risk_class: m.risk_class,
          evolution_policy: m.evolution_policy,
          current_version: m.current_version,
          versions: (m.versions ?? []).map((v) => ({
            version: v.version,
            created_at: v.created_at,
            justification: v.justification,
          })),
        });
        return;
      }
      default:
        json(res, 404, { error: "not found" });
        return;
    }
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === "FORBIDDEN_TOOL") {
      json(res, 403, { error: err.message });
      return;
    }
    json(res, 502, { error: "bridge upstream error", detail: err.message });
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => json(res, 500, { error: String(e) }));
});

const shutdown = (): void => {
  try {
    rmSync(PORT_FILE, { force: true });
  } catch {
    /* ignore */
  }
  server.close();
  void client.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main(): Promise<void> {
  boundPort = await choosePort();

  // Catch a late EADDRINUSE (lost the race between preflight probe and bind)
  // instead of dying with an unhandled 'error' event.
  server.once("error", (err: NodeJS.ErrnoException) => {
    process.stderr.write(
      err.code === "EADDRINUSE"
        ? `[atlas-bridge] FATAL: port ${boundPort} became busy between preflight and bind. ` +
            `Retry, or set EIGHTS_ATLAS_BRIDGE_PORT to a free port.\n`
        : `[atlas-bridge] FATAL: ${String(err)}\n`,
    );
    process.exit(1);
  });

  server.listen(boundPort, HOST, () => {
    // Record the ACTUAL port so the vite dev proxy can find us even if we rolled
    // forward off the preferred one.
    try {
      writeFileSync(PORT_FILE, String(boundPort), "utf8");
    } catch {
      /* non-fatal — vite falls back to env/default */
    }
    const rolled = boundPort !== PREFERRED_PORT ? ` (preferred ${PREFERRED_PORT} was busy)` : "";
    process.stderr.write(
      `[atlas-bridge] MCP bridge listening on http://${HOST}:${boundPort}${rolled} ` +
        `(loopback only · ${READ_ONLY_TOOLS.length} read tools [eights-atlas envelope] · ` +
        `${WRITE_TOOLS.length} governed write tools [operator-rob envelope, CSRF-gated])\n`,
    );
  });
}

void main().catch((err) => {
  process.stderr.write(`[atlas-bridge] startup failed: ${String(err)}\n`);
  process.exit(1);
});
