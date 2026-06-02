import type { LiveSnapshot } from "../atlas/live.ts";

interface StatBarProps {
  nodes: number;
  edges: number;
  total: number;
  live: LiveSnapshot;
}

export function StatBar({ nodes, edges, total, live }: StatBarProps): JSX.Element {
  const fmt = (n: number | null): string => (n === null ? "—" : n.toLocaleString());
  return (
    <div className="ov statbar">
      <span className={"live-dot " + (live.live ? "live-on" : "live-off")} />
      <span className="live-tag">{live.live ? "live" : "live: offline"}</span>
      <span className="sep">·</span>
      <span>
        {nodes} nodes · {edges} edges visible · {total} total in codebase
      </span>
      <span className="sep">·</span>
      <span>
        {fmt(live.counts.events)} events · {fmt(live.counts.resources)} resources ·{" "}
        {fmt(live.counts.pending)} pending
      </span>
    </div>
  );
}
