import { useCallback, useMemo, useRef, useState } from "react";
import { ATLAS, type AtlasNode, type Lens } from "./atlas/data.ts";
import type { AtlasSim } from "./atlas/sim.ts";
import { useAtlasLive } from "./atlas/useAtlasLive.ts";
import { useProposalActions } from "./atlas/useProposalActions.ts";
import { Atlas, type TooltipState } from "./components/Atlas.tsx";
import { LensBar } from "./components/LensBar.tsx";
import { Legend } from "./components/Legend.tsx";
import { Inspector } from "./components/Inspector.tsx";
import { SearchBox } from "./components/SearchBox.tsx";
import { StatBar } from "./components/StatBar.tsx";
import { HitlPanel } from "./components/HitlPanel.tsx";
import { ConfirmDialog } from "./components/ConfirmDialog.tsx";
import { ToastHost } from "./components/Toast.tsx";

/* App shell — the React home of design-reference/project/atlas/app.js orchestration:
   lens application, legend group-filtering, search, recompute + fitView, and the
   inspector selection. The graph + interaction live in <Atlas>; the live overlay
   in useAtlasLive. */

export function App(): JSX.Element {
  const [sim, setSim] = useState<AtlasSim | null>(null);
  const [lens, setLens] = useState<Lens>(ATLAS.lenses[0]!);
  const [legendOff, setLegendOff] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tooltip, setTooltip] = useState<TooltipState>({ show: false, x: 0, y: 0, label: "", sub: "" });
  const [stat, setStat] = useState({ nodes: 0, edges: 0 });
  const [hitlOpen, setHitlOpen] = useState(false);

  // Use a ref mirror of the current lens/off so recompute reads fresh values.
  const lensRef = useRef(lens);
  lensRef.current = lens;
  const offRef = useRef(legendOff);
  offRef.current = legendOff;

  const { snap: live, refetch } = useAtlasLive(sim);
  // ONE shared governed-action instance, used by the Inspector footer AND the
  // HITL panel. It owns CSRF token bootstrap (/api/session), the confirm +
  // typed-confirm flow, the POST calls, toasts, and the optimistic refetch.
  const actions = useProposalActions(refetch);

  const nodeVisible = useCallback((n: AtlasNode): boolean => {
    const l = lensRef.current;
    return (
      l.groups.includes(n.group) &&
      !offRef.current.has(n.group) &&
      !(Boolean(l.collapseLeaves) && n.r < 6)
    );
  }, []);

  const recompute = useCallback(
    (s: AtlasSim) => {
      const ids = new Set(ATLAS.nodes.filter(nodeVisible).map((n) => n.id));
      ids.add("core");
      s.setActive(ids);
      s.fitView();
      const edges = s.links.filter((l) => l.s.active && l.t.active).length;
      setStat({ nodes: ids.size, edges });
    },
    [nodeVisible],
  );

  const applyLens = useCallback(
    (next: Lens) => {
      setLens(next);
      lensRef.current = next;
      const cleared = new Set<string>();
      setLegendOff(cleared);
      offRef.current = cleared;
      if (sim) {
        recompute(sim);
        setSelected(null);
        sim.setSelected(null);
      }
    },
    [sim, recompute],
  );

  const onSimReady = useCallback(
    (s: AtlasSim) => {
      setSim(s);
      recompute(s);
    },
    [recompute],
  );

  const centerOn = useCallback(
    (id: string) => {
      if (!sim) return;
      const n = sim.byId[id];
      if (!n) return;
      sim.view.x = -n.x * sim.view.k;
      sim.view.y = -n.y * sim.view.k;
      sim.applyView();
      sim.reheat(0.25);
    },
    [sim],
  );

  const onSelect = useCallback(
    (id: string | null) => {
      setSelected(id);
      sim?.setSelected(id);
      // Clicking the HITL Queue node opens the HITL Review slide-over.
      if (id === "hitl") setHitlOpen(true);
    },
    [sim],
  );

  const onToggleGroup = useCallback(
    (g: string) => {
      setLegendOff((prev) => {
        const nextOff = new Set(prev);
        if (nextOff.has(g)) nextOff.delete(g);
        else nextOff.add(g);
        offRef.current = nextOff;
        if (sim) recompute(sim);
        return nextOff;
      });
    },
    [sim, recompute],
  );

  const onSearchChange = useCallback(
    (q: string) => {
      setSearch(q);
      sim?.setSearch(q.trim());
      if (q.trim().length >= 2 && sim) {
        const m = ATLAS.nodes.find(
          (n) => sim.byId[n.id]?.active && n.label.toLowerCase().includes(q.toLowerCase()),
        );
        if (m) centerOn(m.id);
      }
    },
    [sim, centerOn],
  );

  const onSearchEnter = useCallback(
    (q: string) => {
      if (!sim) return;
      const m = ATLAS.nodes.find(
        (n) => sim.byId[n.id]?.active && n.label.toLowerCase().includes(q.toLowerCase()),
      );
      if (m) {
        onSelect(m.id);
        centerOn(m.id);
      }
    },
    [sim, onSelect, centerOn],
  );

  const onReset = useCallback(() => {
    setSearch("");
    sim?.setSearch("");
    applyLens(lensRef.current);
  }, [sim, applyLens]);

  const inspectorOpen = useMemo(() => Boolean(selected), [selected]);

  return (
    <>
      <Atlas onSimReady={onSimReady} onSelect={onSelect} onTooltip={setTooltip} />

      <div className="ov brand">
        <div className="t">
          The<b>Eights</b> · Agent-BOM Atlas
        </div>
        <div className="s">every module in the codebase, as one graph · v0.3.0</div>
      </div>

      <LensBar current={lens} onPick={applyLens} />

      <button
        className="hitl-open-btn"
        onClick={() => setHitlOpen(true)}
        title="Open the HITL Review queue"
      >
        HITL Review
        {live.live && live.pending.length ? <span className="hitl-open-badge">{live.pending.length}</span> : null}
      </button>

      <SearchBox value={search} onChange={onSearchChange} onEnter={onSearchEnter} onReset={onReset} />

      <Legend lens={lens} sim={sim} off={legendOff} onToggle={onToggleGroup} />

      <StatBar nodes={stat.nodes} edges={stat.edges} total={ATLAS.nodes.length} live={live} />

      <Inspector
        sim={sim}
        selected={selected}
        live={live}
        actions={actions}
        onSelect={onSelect}
        onCenter={centerOn}
        onClose={() => onSelect(null)}
      />

      <HitlPanel open={hitlOpen} onClose={() => setHitlOpen(false)} live={live} actions={actions} />

      {/* Shared confirm + typed-confirm dialog. For rollback it also hosts the
          version picker, sourced from the resource's REAL version list. */}
      <ConfirmDialog spec={actions.spec} busy={actions.busy} onConfirm={actions.confirm} onCancel={actions.cancel}>
        {actions.rollbackVersions ? (
          <label className="dlg-field">
            <span>Roll back to version</span>
            <select
              value={actions.rollbackTarget ?? ""}
              onChange={(e) => actions.setRollbackTarget(e.target.value)}
            >
              {actions.rollbackVersions.map((v) => (
                <option key={v.version} value={v.version}>
                  {v.version.replace(/^sha256:/, "").slice(0, 12)}…
                  {v.created_at ? ` · ${new Date(v.created_at).toLocaleString()}` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </ConfirmDialog>

      <ToastHost />

      <div
        id="tooltip"
        style={{
          opacity: tooltip.show ? 1 : 0,
          left: tooltip.x,
          top: tooltip.y,
        }}
      >
        <b>{tooltip.label}</b>
        <span>{tooltip.sub}</span>
      </div>

      <div className={"ov hint" + (inspectorOpen ? " dim" : "")}>
        drag node to pull · scroll to zoom · drag bg to pan
        <br />
        click a node to inspect · click groups to filter
      </div>
    </>
  );
}
