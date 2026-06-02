import { ATLAS, type Lens } from "../atlas/data.ts";

interface LensBarProps {
  current: Lens;
  onPick: (lens: Lens) => void;
}

export function LensBar({ current, onPick }: LensBarProps): JSX.Element {
  return (
    <div className="ov lensbar-wrap">
      <div id="lensBar">
        {ATLAS.lenses.map((lens) => (
          <button
            key={lens.id}
            className={"lens" + (lens.id === current.id ? " on" : "")}
            onClick={() => onPick(lens)}
          >
            {lens.label}
          </button>
        ))}
      </div>
      <div id="lensDesc">{current.desc}</div>
    </div>
  );
}
