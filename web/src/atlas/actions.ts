/* Client for the Atlas GOVERNED operator-write path.

   This is the browser side of the bridge's POST endpoints. It:
     - bootstraps the per-session CSRF token from GET /api/session and echoes it
       as X-Atlas-Token on every write (the bridge refuses 403 without it);
     - exposes approve / reject / rollback, each returning a structured result
       carrying the daemon audit event id + the new status, or a typed error
       (including the server-side frozen/critical refusal) so the UI can show the
       "requires operator unfreeze (CLI)" state truthfully instead of faking
       success.

   Tool names are NEVER sent from here — the bridge owns the literal tool name.
   We send only proposal_id (in the URL), reason, rid, to_version. */

const API_BASE = (import.meta.env.VITE_ATLAS_API as string | undefined) ?? "/api";

export interface ActionResult {
  ok: boolean;
  action: "approve" | "reject" | "rollback";
  proposal_id?: string;
  rid?: string;
  to_version?: string;
  /** structured daemon result (carries audit event id + new status when present) */
  result?: unknown;
  /** the daemon audit event id, best-effort extracted from `result` */
  auditId?: string;
  /** the new resource/proposal status, best-effort extracted from `result` */
  newStatus?: string;
}

export interface ActionError {
  ok: false;
  status: number;
  /** machine code when the bridge supplies one: CSRF | FROZEN | FORBIDDEN_TOOL */
  code?: string;
  error: string;
  rid?: string;
  risk?: string;
  policy?: string;
}

export class WriteActionError extends Error {
  constructor(public readonly detail: ActionError) {
    super(detail.error);
    this.name = "WriteActionError";
  }
}

/* ---- per-session CSRF token bootstrap ---- */
let cachedToken: string | null = null;

export async function getSessionToken(force = false): Promise<string> {
  if (cachedToken && !force) return cachedToken;
  const res = await fetch(`${API_BASE}/session`, { method: "GET" });
  if (!res.ok) throw new Error(`session bootstrap failed: ${res.status}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("session bootstrap returned no token");
  cachedToken = body.token;
  return cachedToken;
}

/** Best-effort pull of an audit event id + status out of an arbitrary daemon
    result shape. The daemon returns slightly different shapes per tool; we look
    for the common fields without assuming a single schema. */
function extract(result: unknown): { auditId?: string; newStatus?: string } {
  if (!result || typeof result !== "object") return {};
  const r = result as Record<string, unknown>;
  const auditId =
    (typeof r.audit_event_id === "string" && r.audit_event_id) ||
    (typeof r.audit_id === "string" && r.audit_id) ||
    (typeof r.event_id === "string" && r.event_id) ||
    undefined;
  const newStatus =
    (typeof r.status === "string" && r.status) ||
    (typeof r.new_status === "string" && r.new_status) ||
    undefined;
  return { auditId: auditId || undefined, newStatus: newStatus || undefined };
}

async function postWrite(path: string, body?: Record<string, unknown>): Promise<ActionResult> {
  const token = await getSessionToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-atlas-token": token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const p = (parsed ?? {}) as Record<string, unknown>;
    // A 403 CSRF most likely means the token rotated (bridge restarted). Drop the
    // cache so the next attempt re-bootstraps.
    if (res.status === 403 && p.code === "CSRF") cachedToken = null;
    throw new WriteActionError({
      ok: false,
      status: res.status,
      code: typeof p.code === "string" ? p.code : undefined,
      error: typeof p.error === "string" ? p.error : `write failed (${res.status})`,
      rid: typeof p.rid === "string" ? p.rid : undefined,
      risk: typeof p.risk === "string" ? p.risk : undefined,
      policy: typeof p.policy === "string" ? p.policy : undefined,
    });
  }
  const r = (parsed ?? {}) as ActionResult;
  const { auditId, newStatus } = extract(r.result);
  return { ...r, auditId, newStatus };
}

export function approveProposal(proposalId: string): Promise<ActionResult> {
  return postWrite(`/proposals/${encodeURIComponent(proposalId)}/approve`);
}

export function rejectProposal(proposalId: string, reason: string): Promise<ActionResult> {
  return postWrite(`/proposals/${encodeURIComponent(proposalId)}/reject`, { reason });
}

export function rollbackResource(rid: string, toVersion: string): Promise<ActionResult> {
  return postWrite(`/resources/rollback`, { rid, to_version: toVersion });
}

/* ---- version list for the rollback picker ----
   Sourced from the read path's get_resource (already whitelisted). We expose a
   thin fetch here so the rollback dialog can offer the resource's REAL versions;
   the bridge re-validates to_version against this same list server-side. */
export interface ResourceVersion {
  version: string;
  created_at?: string;
  justification?: string;
}
export interface ResourceDetail {
  rid: string;
  risk_class?: string;
  evolution_policy?: string;
  current_version?: string;
  versions: ResourceVersion[];
}

export async function fetchResourceDetail(rid: string): Promise<ResourceDetail> {
  // The bridge does not expose a generic get_resource GET (read whitelist is by
  // endpoint, not arbitrary tool). The rollback picker instead reads versions
  // from a dedicated read endpoint. If absent, callers fall back to the snapshot.
  const res = await fetch(`${API_BASE}/resources/detail?rid=${encodeURIComponent(rid)}`, {
    method: "GET",
  });
  if (!res.ok) throw new Error(`resource detail failed: ${res.status}`);
  return (await res.json()) as ResourceDetail;
}

/** Risk levels that require a TYPED confirmation (operator types the rid or the
    word APPROVE/ROLLBACK) per the operator decision. */
export function requiresTypedConfirm(risk: string | undefined, action: ActionResult["action"]): boolean {
  if (action === "rollback") return true; // every rollback is typed-confirm
  const r = (risk ?? "").toLowerCase();
  return r === "high" || r === "critical";
}

/** Frozen/critical resources are refused server-side; the UI disables their
    actions and explains why. */
export function isActionable(risk: string | undefined, policy: string | undefined): boolean {
  return (risk ?? "").toLowerCase() !== "critical" && (policy ?? "").toLowerCase() !== "frozen";
}
