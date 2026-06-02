import { ATLAS } from "../atlas/data.ts";
import type { AtlasSim } from "../atlas/sim.ts";
import type { LiveSnapshot } from "../atlas/live.ts";
import type { ProposalActionsApi } from "../atlas/useProposalActions.ts";
import { isActionable } from "../atlas/actions.ts";

interface InspectorProps {
  sim: AtlasSim | null;
  selected: string | null;
  live: LiveSnapshot;
  actions: ProposalActionsApi;
  onSelect: (id: string) => void;
  onCenter: (id: string) => void;
  onClose: () => void;
}

export function Inspector({
  sim,
  selected,
  live,
  actions,
  onSelect,
  onCenter,
  onClose,
}: InspectorProps): JSX.Element {
  if (!sim || !selected || !sim.byId[selected]) {
    return <div id="inspector" />;
  }
  const n = sim.byId[selected]!;
  const prop = n.liveProposal;
  const groupLabel = ATLAS.groups[n.group]?.label ?? n.group;
  const neighbors = [...(sim.adj[selected] ?? [])]
    .map((nid) => sim.byId[nid])
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
  const byGroup: Record<string, typeof neighbors> = {};
  neighbors.forEach((m) => (byGroup[m.group] = byGroup[m.group] || []).push(m));

  // Live overlay: show a live line for nodes whose facts we hydrate.
  let liveLine: string | null = null;
  if (live.live) {
    if (selected === "hitl")
      liveLine = `live · ${live.counts.pending ?? live.pending.length} proposals awaiting HITL approval`;
    else if (selected === "hub-inv")
      liveLine = live.chain.ok ? "live · chain ok · 10/10 held" : "live · chain BROKEN";
    else if (selected === "core")
      liveLine = `live · ${live.counts.events ?? "?"} events · ${live.counts.resources ?? "?"} resources`;
    else if (selected.startsWith("cons-")) {
      const key = selected.slice(5);
      const c = live.resourcesByConsumer[key];
      if (c !== undefined) liveLine = `live · ${c} governed resources`;
    }
  }

  return (
    <div id="inspector" className="open">
      <button className="ix" onClick={onClose}>
        ✕
      </button>
      <div className="ik">
        <span className="kdot" style={{ background: n.color }} />
        {groupLabel}
      </div>
      <div className="it">{n.label}</div>
      {n.path ? <div className="ipath">{n.path}</div> : null}
      {n.meta ? <div className="imeta">{n.meta}</div> : null}
      {liveLine ? <div className="ilive">{liveLine}</div> : null}
      {prop ? (
        <div className="iprop">
          <div className="iprop-grid">
            <span>status</span>
            <b>{prop.status ?? "pending"}</b>
            <span>risk</span>
            <b>{prop.risk || "—"}</b>
            <span>proposed by</span>
            <b>{prop.proposed_by ?? "—"}</b>
            {prop.proposed_at ? (
              <>
                <span>proposed</span>
                <b>{new Date(prop.proposed_at).toLocaleString()}</b>
              </>
            ) : null}
            {prop.candidate_version ? (
              <>
                <span>candidate</span>
                <b className="mono">{prop.candidate_version.replace(/^sha256:/, "").slice(0, 12)}…</b>
              </>
            ) : null}
          </div>
          {prop.justification ? (
            <>
              <div className="conn-title">Justification</div>
              <p className="idesc">{prop.justification}</p>
            </>
          ) : null}
          {prop.candidate_content ? (
            <>
              <div className="conn-title">Candidate content</div>
              <pre className="icode">{prop.candidate_content}</pre>
            </>
          ) : null}

          {/* Governed action footer — only when a live proposal is selected. */}
          <div className="conn-title">Operator actions</div>
          {isActionable(prop.risk, undefined) ? (
            <div className="iprop-actions">
              <button className="btn btn-sm btn-primary" onClick={() => actions.beginApprove(prop)}>
                Approve
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => actions.beginReject(prop)}>
                Reject
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => void actions.beginRollback(prop)}>
                Rollback
              </button>
            </div>
          ) : (
            <div className="iprop-frozen">
              {prop.risk || "frozen/critical"} — refused server-side; requires operator unfreeze (CLI:{" "}
              <code className="mono">eights evolution unfreeze {prop.rid}</code>)
            </div>
          )}
        </div>
      ) : (
        <p className="idesc">{n.desc || ""}</p>
      )}
      {neighbors.length ? (
        <>
          <div className="conn-title">Connections · {neighbors.length}</div>
          {Object.entries(byGroup).map(([g, list]) => (
            <div className="conn-group" key={g}>
              <div className="conn-h">
                <span className="lsw" style={{ background: sim.colorOf[g] }} />
                {ATLAS.groups[g]?.label ?? g} · {list.length}
              </div>
              <div className="conn-list">
                {list.map((m) => (
                  <span
                    key={m.id}
                    className="chip"
                    onClick={() => {
                      if (sim.byId[m.id] && sim.byId[m.id]!.active) {
                        onSelect(m.id);
                        onCenter(m.id);
                      }
                    }}
                  >
                    {m.label}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
