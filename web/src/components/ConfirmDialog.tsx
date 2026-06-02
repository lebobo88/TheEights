import { useEffect, useRef, useState } from "react";

/* Confirm dialog for governed actions.

   Every action gets a confirm step. High/critical-risk actions AND every
   rollback ALSO require a TYPED confirmation: the operator must type an exact
   challenge string (the proposal rid, or the literal "APPROVE" / "ROLLBACK")
   before the confirm button enables. This is the in-UI half of the operator-
   signed override; the CSRF token is the transport half. */

export interface ConfirmSpec {
  title: string;
  /** verb shown on the confirm button */
  verb: string;
  /** body lines rendered above the inputs */
  lines: string[];
  /** when set, the operator must type this exact string to enable confirm */
  typedChallenge?: string;
  /** label for the typed-challenge input */
  typedLabel?: string;
  /** when true, render a required free-text reason box; its value is passed back */
  withReason?: boolean;
  /** danger styling (rollback / high-risk) */
  danger?: boolean;
}

interface ConfirmDialogProps {
  spec: ConfirmSpec | null;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
  busy?: boolean;
  /** optional extra content (e.g. the rollback version picker) above the inputs */
  children?: React.ReactNode;
}

export function ConfirmDialog({ spec, onConfirm, onCancel, busy, children }: ConfirmDialogProps): JSX.Element | null {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const firstRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setTyped("");
    setReason("");
    if (spec) setTimeout(() => firstRef.current?.focus(), 30);
  }, [spec]);

  useEffect(() => {
    if (!spec) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [spec, onCancel]);

  if (!spec) return null;

  const typedOk = !spec.typedChallenge || typed === spec.typedChallenge;
  const reasonOk = !spec.withReason || reason.trim().length > 0;
  const canConfirm = typedOk && reasonOk && !busy;

  return (
    <div className="dlg-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className={"dlg" + (spec.danger ? " dlg-danger" : "")} role="dialog" aria-modal="true">
        <div className="dlg-title">{spec.title}</div>
        {spec.lines.map((l, i) => (
          <p className="dlg-line" key={i}>
            {l}
          </p>
        ))}

        {children}

        {spec.withReason ? (
          <label className="dlg-field">
            <span>Reason (required — recorded with the rejection)</span>
            <textarea
              ref={(el) => (firstRef.current = el)}
              value={reason}
              rows={3}
              onChange={(e) => setReason(e.target.value)}
              placeholder="why this proposal is being rejected…"
            />
          </label>
        ) : null}

        {spec.typedChallenge ? (
          <label className="dlg-field">
            <span>
              {spec.typedLabel ?? "Type to confirm"}: <code className="mono">{spec.typedChallenge}</code>
            </span>
            <input
              ref={(el) => {
                if (!spec.withReason) firstRef.current = el;
              }}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder={spec.typedChallenge}
            />
            {!typedOk && typed.length > 0 ? <span className="dlg-warn">does not match</span> : null}
          </label>
        ) : null}

        <div className="dlg-actions">
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className={"btn " + (spec.danger ? "btn-danger" : "btn-primary")}
            onClick={() => onConfirm(spec.withReason ? reason.trim() : undefined)}
            disabled={!canConfirm}
          >
            {busy ? "working…" : spec.verb}
          </button>
        </div>
      </div>
    </div>
  );
}
