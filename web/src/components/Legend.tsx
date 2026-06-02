import { ATLAS, type Lens } from "../atlas/data.ts";
import type { AtlasSim } from "../atlas/sim.ts";

interface LegendProps {
  lens: Lens;
  sim: AtlasSim | null;
  off: Set<string>;
  onToggle: (group: string) => void;
}

export function Legend({ lens, sim, off, onToggle }: LegendProps): JSX.Element {
  const counts: Record<string, number> = {};
  ATLAS.nodes.forEach((n) => (counts[n.group] = (counts[n.group] || 0) + 1));

  return (
    <div className="ov legend-card">
      <div className="lt">
        <span>Node groups</span>
        <span>click to filter</span>
      </div>
      <div id="legend">
        {lens.groups
          .filter((g) => g !== "core")
          .map((g) => {
            const def = ATLAS.groups[g];
            if (!def) return null;
            const color = sim?.colorOf[g] ?? def.color;
            return (
              <div
                key={g}
                className={"lrow" + (off.has(g) ? " off" : "")}
                onClick={() => onToggle(g)}
              >
                <span className="lsw" style={{ background: color }} />
                <span className="lname">{def.label}</span>
                <span className="lcnt">{counts[g] || 0}</span>
              </div>
            );
          })}
      </div>
    </div>
  );
}
