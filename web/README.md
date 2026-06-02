# web/ — Living Agent-BOM Atlas

A web observability UI for TheEights with a **governed operator-write path**. It renders
the entire codebase as a force-directed graph (the curated *structure* skeleton) and
**hydrates the observability layer with LIVE data** from the running `eights-daemon`.

> **No longer purely read-only.** As of the `atlas-hitl-actions-2026-06-01` campaign the
> Atlas has a SEPARATE, CSRF-gated, governed operator-write path that lets the operator
> **Approve / Reject-with-reason / Rollback** self-evolution proposals from the HITL queue
> in the browser. The READ path below is **unchanged**. The write path is a distinct,
> minimal allowlist of exactly `{evolution.approve, evolution.reject, evolution.rollback}`.
> See [Governed operator-write path](#governed-operator-write-path).

`web/` is a **new top-level package, a sibling of `daemon/` and `cli/`** — never inside
`daemon/src/`. It is a **consumer-style package**: it talks to the daemon ONLY over the
existing MCP stdio boundary, exactly like the CLI. It adds **no new daemon surface** and
makes **no changes under `daemon/src/`** — the write path is still a consumer over the
existing MCP stdio boundary and invokes only the **governed** `eights.evolution.*` tools.

## Two halves

### 1. Frontend (`src/`) — React + Vite + TypeScript (strict, ESM, Node 20)

A pixel-faithful port of the Claude Design prototype in `design-reference/`:

- `src/atlas/data.ts` — verbatim typed port of the node/group/lens model (~250 nodes,
  ~316 edges, 11 lenses). The static structural skeleton.
- `src/atlas/sim.ts` — framework-agnostic `AtlasSim` class: velocity-Verlet force sim
  (cluster anchors, repulsion, link springs) + SVG scene graph + pan/zoom/pulses.
  Driven by a `requestAnimationFrame` loop inside a React effect — physics is **not**
  rebuilt in React state. React owns the shell; the sim owns the SVG.
- `src/components/{Atlas,LensBar,Legend,Inspector,SearchBox,StatBar}.tsx` — the shell.
- `src/atlas/useAtlasLive.ts` — polling hook that overlays live observability onto the
  static graph and fires one edge pulse per genuinely-new recent audit event. Falls
  back to baked static values + a `live: offline` indicator when the bridge is down.
- `src/styles.css` — the prototype's oklch tokens + layout, verbatim. Geist / Geist Mono.

### 2. Read-only MCP bridge (`server/`)

A localhost-only Node `http` server that is **just another MCP client**:

- `server/eights-client.ts` — a self-contained copy of the CLI's `EightsClient` (spawns
  `daemon/dist/index.js` over stdio) plus `atlasEnvelope()`, the **fixed read-only
  envelope**: actor `eights-atlas`, project `TheEights`, domain `infra`, **empty scope**.
- `server/whitelist.ts` — the **hard read-only tool whitelist** (13 read tools) plus a
  **forbidden-verb denylist**. The single source of truth for what the browser-facing
  bridge may ever ask the daemon to do.
- `server/index.ts` — the REST facade:
  - `GET /api/atlas/live` — aggregate live snapshot
  - `GET /api/events/recent` — recent audit events (drives pulses)
  - `GET /api/hitl` — pending HITL queue
  - `GET /api/resources/counts` — per-consumer resource totals
  - `GET /api/chain/status` — `audit.verify` chain status (throttled; the full-chain
    walk is called sparingly)
  - `GET /api/health` — bridge + whitelist + daemon-connected status

## Hard guarantees (inviolable — AGENTS.md + CONSTITUTION.md §III)

| Guarantee | Where enforced |
|---|---|
| **Invariant #1** — no broadening of tenant/scope access | `atlasEnvelope()` is fixed, empty scope, server-injected on every call; the browser can never supply or alter it |
| **READ-ONLY** — no write/commit/approve/charge from the browser | `allowTool()` = `isWhitelisted && !isForbidden`; 13-tool whitelist has zero mutating verbs; denylist blocks `.add/.commit/.approve/.charge/.resolve/.write/.attest/...` (e.g. `memory.add` is rejected on both counts) |
| **Invariant #3** — audit engine untouched | the bridge only reads; every proxied read still produces a daemon audit event — the observability tool is itself observed |
| **Loopback only** | binds `127.0.0.1` (never `0.0.0.0`); rejects non-loopback `Host` header (anti-DNS-rebinding); `GET`-only |
| **No daemon mutation / no new daemon surface** | the bridge spawns `daemon/dist/index.js` over stdio exactly like the CLI; `daemon/src/` is never imported or changed |
| **No outbound** | nothing beyond the daemon stdio; no telemetry |

Tool names are **always server-controlled string literals** — no request path lets a
browser specify an arbitrary tool name. The only client-influenced value is a numeric
`limit` on `/api/events/recent`, coerced via `Number(...)`.

## Governed operator-write path

A **separate** path, added without touching the read path above. It lets the operator
act on self-evolution proposals from the browser. Everything is governed: the only tools
it can ever invoke are the daemon's `eights.evolution.*` governed tools, which enforce
policy, HITL, frozen-refusal, write-back, and audit on the daemon side. The UI **invokes**
governance; it never bypasses it.

### Write modules (`server/`)

- `server/write-whitelist.ts` — the **write allowlist**: EXACTLY three tools
  `{evolution.approve, evolution.reject, evolution.rollback}` and nothing else. Adding a
  tool here is a governance event. This is a closed set, separate from the read whitelist.
- `server/operator.ts` — the distinct **operator envelope** (actor `operator-rob`, project
  `TheEights`, domain `governance`, **minimal scope** = exactly those three actions,
  hard-coded — no request path widens it, Invariant #1) plus the **per-session CSRF token**
  (`randomBytes(32)` minted at startup, exposed only to a same-origin `GET /api/session`,
  `timingSafeEqual`-verified).
- `server/index.ts` — the write endpoints (POST-only):
  - `GET  /api/session` — issues the per-session CSRF token (same-origin only)
  - `POST /api/proposals/:id/approve` — `eights.evolution.approve`
  - `POST /api/proposals/:id/reject` `{reason}` — `eights.evolution.reject`
  - `POST /api/resources/rollback` `{rid, to_version}` — `eights.evolution.rollback`
  - `GET  /api/resources/detail?rid=…` — version list for the rollback picker (read path)

### Auth model (per-session CSRF + loopback + typed confirm)

1. The bridge mints a random token at startup and serves it ONLY via same-origin
   `GET /api/session`. Every write POST MUST present it as an `X-Atlas-Token` header;
   a write without a valid token is refused **403** before any daemon call. This is the
   CSRF defense: an unauthenticated / cross-origin caller cannot forge a write.
2. Writes are **POST-only**, keep the existing **`127.0.0.1` bind + `Host` loopback check**.
3. In the UI, **every** action requires an in-app confirm dialog; **high/critical-risk**
   actions and **every rollback** additionally require a **typed confirmation** (the
   operator types the proposal rid, or the literal `APPROVE` / `ROLLBACK`).
4. The operator action is the **operator-signed override** Invariant #5 requires for
   non-`low` risk classes; the daemon audits every action under actor `operator-rob`.

### Risk policy + frozen refusal

All risk classes are actionable from the UI (typed-confirm for high+). **Frozen/critical**
resources are refused **server-side** (`409 FROZEN`) with a clear
`requires operator unfreeze (CLI: eights evolution unfreeze <rid>)` message — the UI shows
this truthfully and does **not** pretend success. `to_version` on rollback is validated
server-side against the resource's **real** version list (from `evolution.get_resource`).

### Frontend surfaces (`src/`)

- `src/atlas/actions.ts` — write client: CSRF bootstrap + approve/reject/rollback + typed
  errors (incl. the `FROZEN` refusal) + version fetch for the picker.
- `src/atlas/useProposalActions.ts` — shared action orchestration (confirm/typed-confirm
  spec, POST, toasts with audit id, optimistic refetch). One instance, used by both the
  Inspector footer and the HITL panel.
- `src/components/Inspector.tsx` — **action footer** (Approve / Reject / Rollback) when a
  live proposal node is selected; frozen/critical shows the disabled + explained state.
- `src/components/HitlPanel.tsx` — **HITL Review slide-over**: every pending proposal with
  per-row actions + risk/consumer filters.
- `src/components/ConfirmDialog.tsx` — confirm + typed-confirm dialog (hosts the rollback
  version picker).
- `src/components/Toast.tsx` — result toasts showing the new status + the daemon audit id.

### Governed-write guarantees (in addition to the read-path table above)

| Guarantee | Where enforced |
|---|---|
| **Invariant #1** — no scope broadening | `operatorEnvelope()` scope is hard-coded to the three actions; no request path widens it |
| **Closed write allowlist** | `write-whitelist.ts` is exactly `{approve, reject, rollback}`; no `.commit/.unfreeze/.register` is reachable (no route maps to them) |
| **CSRF** | `X-Atlas-Token` required + `timingSafeEqual`-verified on every write; missing/invalid ⇒ 403 |
| **POST-only + loopback** | writes are POST; `127.0.0.1` bind + `Host` loopback check retained |
| **Invariant #5** — operator-signed override | the in-UI confirm + typed-confirm + CSRF token IS the operator signature; daemon audits under `operator-rob` |
| **Invariant #3** — frozen/critical refused | server-side `409 FROZEN` from `get_resource` policy/risk; surfaced truthfully, not faked |
| **Governed tools only** | every action invokes `eights.evolution.*`; the daemon enforces policy/HITL/frozen/write-back/audit |

## Develop / build / run

```bash
# 0. the bridge needs the daemon build
cd ../daemon && npm run build

# 1. install + build the web package
cd ../web && npm install && npm run build

# 2. typecheck (frontend + server)
npm run typecheck

# 3. run the read-only bridge (loopback only)
npm run bridge          # http://127.0.0.1:8788

# 4. dev server (proxies /api -> 127.0.0.1:8788), or preview the prod build
npm run dev             # http://127.0.0.1:5174
npm run preview
```

Environment:

| var | default | meaning |
|---|---|---|
| `EIGHTS_ATLAS_BRIDGE_PORT` | `8788` | bridge listen port (loopback) |
| `EIGHTS_ATLAS_DEV_PORT` | `5174` | vite dev port (loopback) |
| `EIGHTS_ATLAS_VERIFY_MS` | `30000` | min interval between `audit.verify` full-chain walks |
| `EIGHTS_DAEMON_JS` | auto | path to `daemon/dist/index.js` |
| `VITE_ATLAS_POLL_MS` | `4000` | live-overlay poll cadence |

## Verifying read-only + audit

```bash
# read path: real live counts; the bridge's reads are audited under eights-atlas:
curl -s "http://127.0.0.1:8788/api/atlas/live"
eights audit trace --limit 20    # shows eights-atlas read events
```

## Verifying the governed write path

```bash
# 1. a write WITHOUT a token is refused 403 (CSRF):
curl -s -X POST http://127.0.0.1:8788/api/proposals/prop_x/approve         # {"code":"CSRF"} 403

# 2. /api/session issues a same-origin token:
TOKEN=$(curl -s http://127.0.0.1:8788/api/session | jq -r .token)

# 3. a non-whitelisted write tool is unreachable (no route maps to it):
curl -s -X POST -H "X-Atlas-Token: $TOKEN" http://127.0.0.1:8788/api/proposals/x/commit   # 404
curl -s -X POST -H "X-Atlas-Token: $TOKEN" http://127.0.0.1:8788/api/evolution/unfreeze   # 404

# 4. a frozen/critical resource is refused SERVER-SIDE with the unfreeze message:
curl -s -X POST -H "X-Atlas-Token: $TOKEN" -H 'content-type: application/json' \
  -d '{"rid":"resource:eights.constitution","to_version":"sha256:…"}' \
  http://127.0.0.1:8788/api/resources/rollback                            # {"code":"FROZEN"} 409

# 5. operator write actions are audited under actor operator-rob:
eights audit trace --limit 20    # shows operator-rob approve/reject/rollback events
```

## Provenance

The read surface was built via the `atlas-campaign-2026-06-01` Hydra campaign. The
**governed operator-write path** was added via the `atlas-hitl-actions-2026-06-01` Hydra
campaign under TheEights constitution attestation (receipt `0ca6f720…`,
`sha256:d742d65c…`). Enabling the write surface is gated on an operator HITL sign-off
(`enable_governed_write_surface`, request `hitl_tAhLFaavy2sCHwa8XNO9Z`) following an
AgentSmith sentinel review + a constitution-invariant security review. See the campaign
DECISION_RECORD in Hydra Memory.
