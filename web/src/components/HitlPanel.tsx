import { useMemo, useState } from "react";
import type { LiveSnapshot, LiveProposal } from "../atlas/live.ts";
import type { ProposalActionsApi } from "../atlas/useProposalActions.ts";
import { isActionable } from "../atlas/actions.ts";

/* HITL Review slide-over.

   Lists every live pending proposal from the snapshot, with per-row Approve /
   Reject / Rollback actions and risk + consumer filters. Actions route through
   the SHARED useProposalActions instance (same confirm + typed-confirm + CSRF +
   toast pipeline as the Inspector footer). Frozen/critical rows are visibly
   disabled with the "requires operator unfreeze (CLI)" reason — never faked.

   It is opened from a control in the App shell (a button near the lens bar and
   by clicking the HITL Queue node). */

interface HitlPanelProps {
  open: boolean;
  onClose: () => void;
  live: LiveSnapshot;
  actions: ProposalActionsApi;
}

const RISK_ORDER = ["critical", "high", "medium", "low", ""];

function riskRank(r: string): number {
  const i = RISK_ORDER.indexOf((r || "").toLowerCase());
  return i === -1 ? RISK_ORDER.length : i;
}

export function HitlPanel({ open, onClose, live, actions }: HitlPanelProps): JSX.Element {
  const [riskFilter, setRiskFilter] = useState<string>("all");
  const [consumerFilter, setConsumerFilter] = useState<string>("all");

  const proposals = live.pending ?? [];

  const consumers = useMemo(() => {
    const s = new Set<string>();
    for (const p of proposals) if (p.consumer) s.add(p.consumer);
    return ["all", ...[...s].sort()];
  }, [proposals]);

  const risks = useMemo(() => {
    const s = new Set<string>();
    for (const p of proposals) s.add((p.risk || "").toLowerCase() || "—");
    return ["all", ...[...s].sort((a, b) => riskRank(a) - riskRank(b))];
  }, [proposals]);

  const filtered = useMemo(() => {
    return proposals
      .filter((p) => riskFilter === "all" || (p.risk || "").toLowerCase() === riskFilter || (riskFilter === "—" && !p.risk))
      .filter((p) => consumerFilter === "all" || p.consumer === consumerFilter)
      .slice()
      .sort((a, b) => riskRank(a.risk) - riskRank(b.risk));
  }, [proposals, riskFilter, consumerFilter]);

  return (
    <>
      <div className={"hitl-scrim" + (open ? " open" : "")} onClick={onClose} />
      <aside className={"hitl-panel" + (open ? " open" : "")} aria-hidden={!open}>
        <div className="hitl-head">
          <div className="hitl-title">
            HITL Review<span className="hitl-count">{proposals.length} pending</span>
          </div>
          <button className="ix" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>

        {!live.live ? (
          <div className="hitl-offline">
            bridge offline — showing no live proposals. Start the bridge to review the queue.
          </div>
        ) : null}

        <div className="hitl-filters">
          <label>
            risk
            <select value={riskFilter} onChange={(e) => setRiskFilter(e.target.value)}>
              {risks.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label>
            consumer
            <select value={consumerFilter} onChange={(e) => setConsumerFilter(e.target.value)}>
              {consumers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="hitl-list">
          {filtered.length === 0 ? (
            <div className="hitl-empty">no proposals match the current filters</div>
          ) : (
            filtered.map((p) => <HitlRow key={p.proposal_id ?? p.rid} p={p} actions={actions} />)
          )}
        </div>
      </aside>
    </>
  );
}

function HitlRow({ p, actions }: { p: LiveProposal; actions: ProposalActionsApi }): JSX.Element {
  const actionable = isActionable(p.risk, undefined);
  const risk = (p.risk || "—").toLowerCase();
  return (
    <div className={"hitl-row risk-" + risk}>
      <div className="hitl-row-main">
        <div className="hitl-rid mono">{p.rid}</div>
        <div className="hitl-row-meta">
          <span className={"risk-pill risk-" + risk}>{p.risk || "—"}</span>
          {p.consumer ? <span className="hitl-consumer">{p.consumer}</span> : null}
          {p.proposed_by ? <span className="hitl-by">by {p.proposed_by}</span> : null}
        </div>
        {p.justification ? <div className="hitl-just">{p.justification}</div> : null}
      </div>
      <div className="hitl-row-actions">
        {actionable ? (
          <>
            <button className="btn btn-sm btn-primary" onClick={() => actions.beginApprove(p)}>
              Approve
            </button>
            <button className="btn btn-sm btn-danger" onClick={() => actions.beginReject(p)}>
              Reject
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => void actions.beginRollback(p)}>
              Rollback
            </button>
          </>
        ) : (
          <div className="hitl-frozen" title="frozen/critical — server refuses without operator unfreeze">
            requires operator unfreeze (CLI)
          </div>
        )}
      </div>
    </div>
  );
}
