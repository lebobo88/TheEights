import { describe, expect, it, vi } from "vitest";
import type { Completer } from "../src/completer.js";
import type { Embedder } from "../src/embeddings.js";
import { LazyCompleter, LazyEmbedder } from "../src/providers/lazy.js";

describe("lazy provider wrappers", () => {
  it("does not construct the embedder until first use", async () => {
    const available = vi.fn(async () => true);
    const embed = vi.fn(async () => Float32Array.from([1, 2, 3]));
    const factory = vi.fn(async (): Promise<Embedder> => ({
      dim: () => 3,
      lastError: null,
      available,
      embed,
    }));

    const lazy = new LazyEmbedder(3, factory);
    expect(factory).not.toHaveBeenCalled();

    expect(await lazy.available()).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(available).toHaveBeenCalledTimes(1);

    expect(await lazy.embed("hello")).toEqual(Float32Array.from([1, 2, 3]));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith("hello");
  });

  it("does not construct the completer until first use", async () => {
    const available = vi.fn(async () => true);
    const complete = vi.fn(async () => "ok");
    const factory = vi.fn(async (): Promise<Completer> => ({
      lastError: null,
      available,
      complete,
    }));

    const lazy = new LazyCompleter(factory);
    expect(factory).not.toHaveBeenCalled();

    expect(await lazy.complete("sys", "user")).toBe("ok");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith("sys", "user", undefined);

    expect(await lazy.available()).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(available).toHaveBeenCalledTimes(1);
  });
});
