/**
 * Transport-first startup sequencing.
 *
 * `startTransport` attaches stdio MCP immediately so the downstream client can
 * land `initialize`/`tools/list` before heavyweight boot work begins. The
 * deferred tasks wait through a short handshake grace window instead of running
 * inline, because a long synchronous migration immediately after
 * `server.connect()` can still win the next turn and starve the handshake even
 * though the transport is technically attached.
 */
export interface DeferredBootPlan {
  startTransport: () => Promise<void>;
  warmProviders: () => void;
  bootstrap: () => Promise<void>;
  onBootstrapError?: (err: unknown) => void;
  handshakeGraceMs?: number;
}

export const DEFAULT_HANDSHAKE_GRACE_MS = 250;

export async function startTransportThenScheduleBoot(plan: DeferredBootPlan): Promise<void> {
  await plan.startTransport();
  const timer = setTimeout(() => {
    plan.warmProviders();
    void plan.bootstrap().catch((err: unknown) => {
      plan.onBootstrapError?.(err);
    });
  }, plan.handshakeGraceMs ?? DEFAULT_HANDSHAKE_GRACE_MS);
  timer.unref?.();
}
