import { z } from "zod";
import type { PpWatcher } from "../engines/pp-watcher.js";
import type { ExecSuiteWatcher } from "../engines/execsuite-watcher.js";
import type { RlmWatcher } from "../engines/rlm-watcher.js";
import type { Miner } from "../engines/miner.js";
import type { BomEngine } from "../engines/bom.js";

const Empty = z.object({});
const BomArgs = z.object({ project_id: z.string().optional(), since: z.string().optional() });

export function registerAdapterTools(opts: {
  pp: PpWatcher;
  exec: ExecSuiteWatcher;
  rlm: RlmWatcher;
  miner: Miner;
  bom: BomEngine;
}) {
  return {
    "eights.adapters.pp.start": { description: "Start pair-programmer state.db watcher.", schema: Empty, handler: async () => { opts.pp.start(); return { started: true }; } },
    "eights.adapters.pp.stop":  { description: "Stop pair-programmer watcher.",          schema: Empty, handler: async () => { opts.pp.stop(); return { stopped: true }; } },
    "eights.adapters.pp.sync_now": { description: "Force one pp-watcher cycle.",          schema: Empty, handler: async () => opts.pp.syncNow() },

    "eights.adapters.exec.start": { description: "Start ExecutiveSuite output watcher.",   schema: Empty, handler: async () => { opts.exec.start(); return { started: true }; } },
    "eights.adapters.exec.stop":  { description: "Stop ExecutiveSuite watcher.",           schema: Empty, handler: async () => { opts.exec.stop(); return { stopped: true }; } },
    "eights.adapters.exec.sync_now": { description: "Force one ExecutiveSuite cycle.",     schema: Empty, handler: async () => opts.exec.syncNow() },

    "eights.adapters.rlm.start": { description: "Start RLM-family events.jsonl watcher.",  schema: Empty, handler: async () => { opts.rlm.start(); return { started: true }; } },
    "eights.adapters.rlm.stop":  { description: "Stop RLM watcher.",                       schema: Empty, handler: async () => { opts.rlm.stop(); return { stopped: true }; } },
    "eights.adapters.rlm.sync_now": { description: "Force one RLM cycle.",                 schema: Empty, handler: async () => opts.rlm.syncNow() },

    "eights.miner.run_now": { description: "Run the cross-project pattern miner once.",    schema: Empty, handler: async () => opts.miner.runOnce() },

    "eights.audit.bom": { description: "Emit a CycloneDX ML-BOM v1.7 of the eights footprint.", schema: BomArgs, handler: async (a: z.infer<typeof BomArgs>) => opts.bom.emit(a) },
  } as const;
}
