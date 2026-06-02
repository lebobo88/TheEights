import { useCallback, useState } from "react";
import {
  approveProposal,
  rejectProposal,
  rollbackResource,
  fetchResourceDetail,
  requiresTypedConfirm,
  isActionable,
  WriteActionError,
  type ActionResult,
  type ResourceVersion,
} from "./actions.ts";
import type { LiveProposal } from "./live.ts";
import type { ConfirmSpec } from "../components/ConfirmDialog.tsx";
import { pushToast } from "../components/Toast.tsx";

/* Orchestration hook shared by the Inspector action footer and the HITL panel.

   Responsibilities:
     - build the right ConfirmSpec for the action+risk (typed-confirm for high/
       critical + every rollback);
     - run the governed write through actions.ts;
     - surface result/error via toasts (with the daemon audit id);
     - trigger the caller's refetch so the queue reflects the new state;
     - keep frozen/critical truthful: actions are pre-disabled, and a server-side
       FROZEN refusal is shown verbatim ("requires operator unfreeze (CLI)"). */

type Pending =
  | { kind: "approve"; proposal: LiveProposal }
  | { kind: "reject"; proposal: LiveProposal }
  | { kind: "rollback"; proposal: LiveProposal; versions: ResourceVersion[]; toVersion: string };

export interface ProposalActionsApi {
  spec: ConfirmSpec | null;
  busy: boolean;
  /** rollback picker state, when a rollback is being staged */
  rollbackVersions: ResourceVersion[] | null;
  rollbackTarget: string | null;
  setRollbackTarget: (v: string) => void;
  beginApprove: (p: LiveProposal) => void;
  beginReject: (p: LiveProposal) => void;
  beginRollback: (p: LiveProposal) => Promise<void>;
  confirm: (reason?: string) => Promise<void>;
  cancel: () => void;
}

function riskNeedsType(risk: string | undefined): boolean {
  const r = (risk ?? "").toLowerCase();
  return r === "high" || r === "critical";
}

export function useProposalActions(onChanged: () => void): ProposalActionsApi {
  const [pending, setPending] = useState<Pending | null>(null);
  const [spec, setSpec] = useState<ConfirmSpec | null>(null);
  const [busy, setBusy] = useState(false);
  const [rollbackVersions, setRollbackVersions] = useState<ResourceVersion[] | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null);

  const cancel = useCallback(() => {
    setPending(null);
    setSpec(null);
    setRollbackVersions(null);
    setRollbackTarget(null);
    setBusy(false);
  }, []);

  const guardActionable = useCallback((p: LiveProposal): boolean => {
    if (!isActionable(p.risk, undefined)) {
      pushToast({
        kind: "error",
        title: "Action refused",
        detail:
          `${p.rid} is ${p.risk || "frozen/critical"} — requires an operator unfreeze (CLI: ` +
          "`eights evolution unfreeze <rid>`) before it can be changed here.",
      });
      return false;
    }
    return true;
  }, []);

  const beginApprove = useCallback(
    (p: LiveProposal) => {
      if (!guardActionable(p)) return;
      const typed = requiresTypedConfirm(p.risk, "approve");
      setPending({ kind: "approve", proposal: p });
      setSpec({
        title: "Approve proposal",
        verb: "Approve",
        danger: riskNeedsType(p.risk),
        lines: [
          `Approve ${p.rid}?`,
          `This invokes the governed eights.evolution.approve. Risk: ${p.risk || "—"}.`,
          ...(typed ? ["High-risk action — type the proposal rid to confirm."] : []),
        ],
        typedChallenge: typed ? p.rid : undefined,
        typedLabel: typed ? "Type the proposal rid" : undefined,
      });
    },
    [guardActionable],
  );

  const beginReject = useCallback(
    (p: LiveProposal) => {
      if (!guardActionable(p)) return;
      const typed = requiresTypedConfirm(p.risk, "reject");
      setPending({ kind: "reject", proposal: p });
      setSpec({
        title: "Reject proposal",
        verb: "Reject",
        danger: true,
        withReason: true,
        lines: [
          `Reject ${p.rid}?`,
          `This invokes the governed eights.evolution.reject. Risk: ${p.risk || "—"}.`,
          ...(typed ? ["High-risk action — also type the proposal rid to confirm."] : []),
        ],
        typedChallenge: typed ? p.rid : undefined,
        typedLabel: typed ? "Type the proposal rid" : undefined,
      });
    },
    [guardActionable],
  );

  const beginRollback = useCallback(
    async (p: LiveProposal) => {
      if (!guardActionable(p)) return;
      setBusy(true);
      let versions: ResourceVersion[] = [];
      try {
        const detail = await fetchResourceDetail(p.rid);
        versions = detail.versions ?? [];
        if (!isActionable(detail.risk_class, detail.evolution_policy)) {
          pushToast({
            kind: "error",
            title: "Rollback refused",
            detail: `${p.rid} is ${detail.risk_class}/${detail.evolution_policy} — requires operator unfreeze (CLI).`,
          });
          cancel();
          return;
        }
      } catch {
        pushToast({ kind: "error", title: "Could not load versions", detail: `for ${p.rid}` });
        cancel();
        return;
      } finally {
        setBusy(false);
      }
      if (!versions.length) {
        pushToast({ kind: "info", title: "No prior versions", detail: `${p.rid} has nothing to roll back to.` });
        cancel();
        return;
      }
      const target = versions[0]!.version;
      setRollbackVersions(versions);
      setRollbackTarget(target);
      setPending({ kind: "rollback", proposal: p, versions, toVersion: target });
      // Every rollback is typed-confirm.
      setSpec({
        title: "Roll back resource",
        verb: "Roll back",
        danger: true,
        lines: [
          `Roll back ${p.rid} to a prior version?`,
          "Pick the target version below, then type ROLLBACK to confirm.",
          "This invokes the governed eights.evolution.rollback.",
        ],
        typedChallenge: "ROLLBACK",
        typedLabel: 'Type "ROLLBACK"',
      });
    },
    [guardActionable, cancel],
  );

  const confirm = useCallback(
    async (reason?: string) => {
      if (!pending) return;
      setBusy(true);
      const p = pending.proposal;
      try {
        let result: ActionResult;
        if (pending.kind === "approve") {
          result = await approveProposal(p.proposal_id ?? "");
        } else if (pending.kind === "reject") {
          result = await rejectProposal(p.proposal_id ?? "", reason ?? "");
        } else {
          const target = rollbackTarget ?? pending.toVersion;
          result = await rollbackResource(p.rid, target);
        }
        pushToast({
          kind: "ok",
          title: `${pending.kind} · ${p.rid}`,
          detail: result.newStatus ? `new status: ${result.newStatus}` : "done",
          auditId: result.auditId,
        });
        cancel();
        onChanged();
      } catch (e) {
        if (e instanceof WriteActionError) {
          const d = e.detail;
          const isFrozen = d.code === "FROZEN";
          pushToast({
            kind: "error",
            title: isFrozen ? "Refused — frozen/critical" : `Action failed (${d.status})`,
            detail: d.error,
          });
        } else {
          pushToast({ kind: "error", title: "Action failed", detail: String(e) });
        }
        setBusy(false);
      }
    },
    [pending, rollbackTarget, cancel, onChanged],
  );

  const setTarget = useCallback(
    (v: string) => {
      setRollbackTarget(v);
      setPending((prev) => (prev && prev.kind === "rollback" ? { ...prev, toVersion: v } : prev));
    },
    [],
  );

  return {
    spec,
    busy,
    rollbackVersions,
    rollbackTarget,
    setRollbackTarget: setTarget,
    beginApprove,
    beginReject,
    beginRollback,
    confirm,
    cancel,
  };
}
