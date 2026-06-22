import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HANDSHAKE_GRACE_MS, startTransportThenScheduleBoot } from "../src/boot-sequencing.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("transport-first boot sequencing", () => {
  it("returns after transport attach and defers provider warmup/bootstrap until the handshake grace expires", async () => {
    vi.useFakeTimers();

    const order: string[] = [];
    const pending = new Promise<void>(() => { /* keep warmups/bootstrap pending */ });

    await startTransportThenScheduleBoot({
      startTransport: async () => {
        order.push("transport");
      },
      warmProviders: () => {
        order.push("warmProviders");
        void pending;
      },
      bootstrap: async () => {
        order.push("bootstrap");
        await pending;
      },
    });

    expect(order).toEqual(["transport"]);

    await vi.advanceTimersByTimeAsync(DEFAULT_HANDSHAKE_GRACE_MS - 1);
    expect(order).toEqual(["transport"]);

    await vi.advanceTimersByTimeAsync(1);
    expect(order).toEqual(["transport", "warmProviders", "bootstrap"]);
  });

  it("does not await embedder/completer availability before returning from transport attach", async () => {
    vi.useFakeTimers();

    let resolveEmbedder!: () => void;
    let resolveCompleter!: () => void;
    const embedderProbe = vi.fn(() => new Promise<void>((resolve) => {
      resolveEmbedder = resolve;
    }));
    const completerProbe = vi.fn(() => new Promise<void>((resolve) => {
      resolveCompleter = resolve;
    }));

    await expect(startTransportThenScheduleBoot({
      startTransport: async () => {},
      warmProviders: () => {
        void Promise.all([embedderProbe(), completerProbe()]);
      },
      bootstrap: async () => {},
      handshakeGraceMs: 25,
    })).resolves.toBeUndefined();

    expect(embedderProbe).not.toHaveBeenCalled();
    expect(completerProbe).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);
    expect(embedderProbe).toHaveBeenCalledTimes(1);
    expect(completerProbe).toHaveBeenCalledTimes(1);

    resolveEmbedder();
    resolveCompleter();
    await vi.runAllTimersAsync();
  });

  it("reports deferred bootstrap failures without rejecting transport attach", async () => {
    vi.useFakeTimers();

    const err = new Error("migrate failed");
    const onBootstrapError = vi.fn();

    await expect(startTransportThenScheduleBoot({
      startTransport: async () => {},
      warmProviders: () => {},
      bootstrap: async () => {
        throw err;
      },
      onBootstrapError,
      handshakeGraceMs: 25,
    })).resolves.toBeUndefined();

    await vi.runAllTimersAsync();
    expect(onBootstrapError).toHaveBeenCalledWith(err);
  });
});
