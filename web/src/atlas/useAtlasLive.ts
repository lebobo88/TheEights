import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLive, OFFLINE_SNAPSHOT, type LiveSnapshot } from "./live.ts";
import type { AtlasSim } from "./sim.ts";

/* Live-overlay hook. Polls the read-only bridge and merges live observability
   onto the static graph skeleton. Gracefully falls back to OFFLINE_SNAPSHOT
   (baked static values) when the bridge/daemon is unreachable, and flips the
   stat bar to "live: offline".

   The hook NEVER mutates the structural graph topology — it only:
     - overlays header counts + HITL-node meta via sim.setNodeText
     - fires sim.spawnPulseOnEdge for each NEW real recent audit event
   Physics + topology remain owned by AtlasSim.

   Returns { snap, refetch }. `refetch` triggers an out-of-cycle poll so that an
   operator action (approve/reject/rollback) can refresh the queue immediately
   instead of waiting for the next poll tick — the optimistic-update path. */

const POLL_MS = Number(import.meta.env.VITE_ATLAS_POLL_MS ?? 8000);

export interface UseAtlasLive {
  snap: LiveSnapshot;
  refetch: () => void;
}

export function useAtlasLive(sim: AtlasSim | null): UseAtlasLive {
  const [snap, setSnap] = useState<LiveSnapshot>(OFFLINE_SNAPSHOT);
  const [nonce, setNonce] = useState(0);
  const seenEvents = useRef<Set<string>>(new Set());

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();

    async function poll(): Promise<void> {
      let next: LiveSnapshot;
      try {
        next = await fetchLive(ctrl.signal);
      } catch {
        next = { ...OFFLINE_SNAPSHOT, generatedAt: new Date().toISOString() };
      }
      if (stopped) return;
      setSnap(next);

      // Overlay live header facts onto the HITL node + invariants hub.
      if (sim) {
        if (next.live && next.counts.pending !== null) {
          sim.setNodeText("hitl", "HITL Queue", `${next.pending.length} awaiting approval · live`);
        }
        // Bind the real pending proposals onto the proposal leaf nodes so each
        // shows full detail (justification, candidate content, proposer, status)
        // in the inspector on click.
        if (next.live && next.pending.length) {
          sim.attachProposals(next.pending);
        }
        if (next.live && next.chain.ok !== null) {
          sim.setNodeText("hub-inv", "Hard Invariants", next.chain.ok ? "10 / 10 held · chain ok" : "chain BROKEN");
        }
        // Fire a pulse per genuinely-new recent event along its mapped edge.
        for (const ev of next.recentEvents) {
          const key = `${ev.ts ?? ""}|${ev.actor ?? ""}|${ev.kind ?? ""}|${ev.s ?? ""}|${ev.t ?? ""}`;
          if (seenEvents.current.has(key)) continue;
          seenEvents.current.add(key);
          if (ev.s && ev.t) sim.spawnPulseOnEdge(ev.s, ev.t);
        }
        // Bound the seen-set so it cannot grow unbounded.
        if (seenEvents.current.size > 4000) {
          seenEvents.current = new Set(Array.from(seenEvents.current).slice(-2000));
        }
      }

      if (!stopped) timer = setTimeout(poll, POLL_MS);
    }

    poll();
    return () => {
      stopped = true;
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
    // `nonce` is in the dep list so refetch() re-runs the effect (immediate poll).
  }, [sim, nonce]);

  return { snap, refetch };
}
