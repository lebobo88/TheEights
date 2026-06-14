import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualCompleter } from "../src/providers/manual-completer.js";

describe("ManualCompleter — human/agent judge bridge", () => {
  it("first call emits a request marker and fails closed (null)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eights-manual-"));
    try {
      const c = new ManualCompleter(dir);
      const r = await c.complete("SYS", "USER");
      expect(r).toBeNull();
      const reqs = readdirSync(dir).filter((f) => f.endsWith(".request.json"));
      expect(reqs.length).toBe(1);
      expect(c.lastError).toMatch(/awaiting operator verdict/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns the staged verdict on the second call and clears the request marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eights-manual-"));
    try {
      const c = new ManualCompleter(dir);
      // Pass 1: emit the prompt.
      await c.complete("SYS", "USER");
      const reqFile = readdirSync(dir).find((f) => f.endsWith(".request.json"))!;
      const key = reqFile.replace(".request.json", "");
      // Operator/agent stages a verdict.
      const verdict = JSON.stringify({ current: 0.0, candidate: 0.5, notes: "ok" });
      writeFileSync(join(dir, `${key}.json`), verdict, "utf8");
      // Pass 2: same prompt → returns the verdict, request marker gone.
      const r = await c.complete("SYS", "USER");
      expect(r).toBe(verdict);
      expect(existsSync(join(dir, `${key}.request.json`))).toBe(false);
      expect(c.lastError).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("is keyed by prompt content — a different prompt does not reuse a verdict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eights-manual-"));
    try {
      const c = new ManualCompleter(dir);
      await c.complete("SYS", "USER-A");
      const reqFile = readdirSync(dir).find((f) => f.endsWith(".request.json"))!;
      const key = reqFile.replace(".request.json", "");
      writeFileSync(join(dir, `${key}.json`), JSON.stringify({ current: 0, candidate: 1, notes: "a" }), "utf8");
      // Different user prompt → different key → no staged verdict yet → null.
      const r = await c.complete("SYS", "USER-B");
      expect(r).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
