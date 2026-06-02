/* Shared types for the live observability overlay. Mirrors the REST facade
   exposed by web/server/index.ts (the read-only MCP bridge). */

export interface LiveProposal {
  rid: string;
  risk: string;
  consumer?: string;
  proposal_id?: string;
  status?: string;
  proposed_by?: string;
  proposed_at?: string;
  candidate_version?: string;
  justification?: string;
  candidate_content?: string;
}

export interface LiveEvent {
  /** logical edge endpoints in the static graph, if the bridge could map it */
  s?: string;
  t?: string;
  actor?: string;
  kind?: string;
  ts?: string;
}

export interface LiveSnapshot {
  /** true when the snapshot came from a reachable daemon; false = baked fallback */
  live: boolean;
  generatedAt: string;
  counts: {
    events: number | null;
    resources: number | null;
    pending: number | null;
  };
  chain: { ok: boolean | null; brokenAt?: number | null; checkedAt?: string | null };
  pending: LiveProposal[];
  hitl: { pending: number; items: Array<{ id?: string; reason?: string }> };
  resourcesByConsumer: Record<string, number>;
  cells: Record<string, number>;
  envelopes: { count: number };
  handoffs: { count: number };
  recentEvents: LiveEvent[];
}

/** The baked, static fallback — the values the prototype shipped with. Used
    whenever the bridge/daemon is unreachable so the Atlas always renders. */
export const OFFLINE_SNAPSHOT: LiveSnapshot = {
  live: false,
  generatedAt: new Date(0).toISOString(),
  counts: { events: 658280, resources: 1288, pending: 21 },
  chain: { ok: true, brokenAt: null, checkedAt: null },
  pending: [],
  hitl: { pending: 21, items: [] },
  resourcesByConsumer: {},
  cells: {},
  envelopes: { count: 0 },
  handoffs: { count: 0 },
  recentEvents: [],
};

const API_BASE = import.meta.env.VITE_ATLAS_API ?? "/api";

export async function fetchLive(signal?: AbortSignal): Promise<LiveSnapshot> {
  const res = await fetch(`${API_BASE}/atlas/live`, { signal });
  if (!res.ok) throw new Error(`bridge ${res.status}`);
  const json = (await res.json()) as Partial<LiveSnapshot>;
  return { ...OFFLINE_SNAPSHOT, ...json, live: true } as LiveSnapshot;
}
