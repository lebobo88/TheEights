import { useEffect, useState } from "react";

/* Minimal toast surface for governed-action results. A toast carries the result
   summary AND the daemon audit event id when present, so the operator can see
   "approved · audit evt_… · status committed" — proof the action was governed +
   audited, not faked. */

export interface Toast {
  id: number;
  kind: "ok" | "error" | "info";
  title: string;
  detail?: string;
  auditId?: string;
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l(toasts);
}

export function pushToast(t: Omit<Toast, "id">): number {
  const id = nextId++;
  toasts = [...toasts, { ...t, id }];
  emit();
  // auto-dismiss after a while (errors linger longer)
  const ttl = t.kind === "error" ? 9000 : 5500;
  setTimeout(() => dismissToast(id), ttl);
  return id;
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function ToastHost(): JSX.Element {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return (
    <div id="toast-host">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role="status">
          <button className="toast-x" onClick={() => dismissToast(t.id)} aria-label="dismiss">
            ✕
          </button>
          <div className="toast-title">{t.title}</div>
          {t.detail ? <div className="toast-detail">{t.detail}</div> : null}
          {t.auditId ? <div className="toast-audit mono">audit · {t.auditId}</div> : null}
        </div>
      ))}
    </div>
  );
}
