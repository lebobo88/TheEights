import { mkdirSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import pino from "pino";

export function makeLogger(logsDir: string) {
  mkdirSync(logsDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = join(logsDir, `eights-daemon-${day}.log`);
  return pino(
    { level: process.env.EIGHTS_LOG_LEVEL ?? "info" },
    createWriteStream(file, { flags: "a" }),
  );
}
