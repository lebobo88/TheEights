import { useEffect, useRef } from "react";
import { ATLAS, type AtlasNode } from "../atlas/data.ts";
import { AtlasSim, type SimNode } from "../atlas/sim.ts";

/* The graph surface. Owns the SVG + AtlasSim + the rAF loop and all pointer
   interaction (drag node / pan bg / wheel zoom / hover tooltip / click select).
   This is the React home of design-reference/project/atlas/app.js interaction. */

export interface TooltipState {
  show: boolean;
  x: number;
  y: number;
  label: string;
  sub: string;
}

interface AtlasProps {
  onSimReady: (sim: AtlasSim) => void;
  onSelect: (id: string | null) => void;
  onTooltip: (t: TooltipState) => void;
}

export function Atlas({ onSimReady, onSelect, onTooltip }: AtlasProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const simRef = useRef<AtlasSim | null>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    let pointer = { x: 0, y: 0 };
    const rectPos = (e: PointerEvent | WheelEvent): { x: number; y: number } => {
      const r = svg.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    let drag: SimNode | null = null;
    let pan: { sx: number; sy: number; vx: number; vy: number } | null = null;
    let moved = false;

    const showTip = (n: AtlasNode): void => {
      const g = ATLAS.groups[n.group];
      onTooltip({
        show: true,
        x: pointer.x + 16,
        y: pointer.y + 16,
        label: n.label,
        sub: `${g?.label ?? ""}${n.meta ? " · " + n.meta : ""}`,
      });
    };

    const sim = new AtlasSim(
      svg,
      ATLAS,
      (n) => {
        if (drag || pan) return;
        sim.setHovered(n.id);
        showTip(n);
      },
      () => {
        if (drag || pan) return;
        sim.setHovered(null);
        onTooltip({ show: false, x: 0, y: 0, label: "", sub: "" });
      },
    );
    simRef.current = sim;
    onSimReady(sim);

    const onPointerDown = (e: PointerEvent): void => {
      pointer = rectPos(e);
      moved = false;
      const t = e.target as Element;
      if (t.classList && t.classList.contains("gnode")) {
        const n = sim.byId[t.getAttribute("data-id") ?? ""];
        if (n) {
          drag = n;
          n.fixed = true;
          onTooltip({ show: false, x: 0, y: 0, label: "", sub: "" });
        }
      } else {
        pan = { sx: pointer.x, sy: pointer.y, vx: sim.view.x, vy: sim.view.y };
        svg.style.cursor = "grabbing";
      }
    };
    const onPointerMove = (e: PointerEvent): void => {
      pointer = rectPos(e);
      if (drag) {
        const w = sim.screenToWorld(pointer.x, pointer.y);
        drag.x = w.x;
        drag.y = w.y;
        drag.vx = 0;
        drag.vy = 0;
        sim.reheat(0.35);
        moved = true;
      } else if (pan) {
        sim.view.x = pan.vx + (pointer.x - pan.sx);
        sim.view.y = pan.vy + (pointer.y - pan.sy);
        sim.applyView();
        moved = true;
      } else if (sim.state.hovered) {
        const n = sim.byId[sim.state.hovered];
        if (n) showTip(n);
      }
    };
    const onPointerUp = (): void => {
      if (drag) {
        drag.fixed = false;
        if (!moved) onSelect(drag.id);
        drag = null;
      } else if (pan) {
        if (!moved) onSelect(null);
        pan = null;
      }
      svg.style.cursor = "grab";
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const p = rectPos(e),
        before = sim.screenToWorld(p.x, p.y);
      sim.view.k = Math.min(2.8, Math.max(0.28, sim.view.k * Math.exp(-e.deltaY * 0.0012)));
      sim.view.x = p.x - sim.cx() - before.x * sim.view.k;
      sim.view.y = p.y - sim.cy() - before.y * sim.view.k;
      sim.applyView();
    };
    const onResize = (): void => sim.applyView();

    svg.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    svg.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", onResize);

    let last = performance.now();
    let raf = 0;
    const frame = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      sim.tick(dt);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const pulseTimer = setInterval(() => sim.spawnPulse(), 260);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(pulseTimer);
      svg.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      svg.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", onResize);
      sim.destroy();
      simRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <svg id="graph" ref={svgRef} />;
}
