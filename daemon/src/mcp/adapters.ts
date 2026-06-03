import { z } from "zod";
import { Envelope } from "../schemas/envelope.js";
import type { PpWatcher } from "../engines/pp-watcher.js";
import type { ExecSuiteWatcher } from "../engines/execsuite-watcher.js";
import type { RlmWatcher } from "../engines/rlm-watcher.js";
import type { XeniaWatcher } from "../engines/xenia-watcher.js";
import type { Miner } from "../engines/miner.js";
import type { BomEngine } from "../engines/bom.js";
import type { PpRegistrar } from "../engines/registrars/pp-registrar.js";
import type { HydraRegistrar } from "../engines/registrars/hydra-registrar.js";
import type { ExecSuiteRegistrar } from "../engines/registrars/execsuite-registrar.js";
import type { RlmRegistrar } from "../engines/registrars/rlm-registrar.js";
import type { XeniaRegistrar } from "../engines/registrars/xenia-registrar.js";

const Empty = z.object({});
const BomArgs = z.object({ project_id: z.string().optional(), since: z.string().optional() });
const RegisterEnv = z.object({ envelope: Envelope });
const RegisterRlmArgs = z.object({ envelope: Envelope, sibling: z.string().optional() });

export function registerAdapterTools(opts: {
  pp: PpWatcher; exec: ExecSuiteWatcher; rlm: RlmWatcher; xenia: XeniaWatcher;
  miner: Miner; bom: BomEngine;
  registrars: {
    pp: PpRegistrar; hydra: HydraRegistrar; exec: ExecSuiteRegistrar; rlm: RlmRegistrar;
    xenia: XeniaRegistrar;
  };
}) {
  return {
    "eights.adapters.pp.start":          { description: "Start pp state.db watcher.",         schema: Empty,        handler: async () => { opts.pp.start(); return { started: true }; } },
    "eights.adapters.pp.stop":           { description: "Stop pp watcher.",                   schema: Empty,        handler: async () => { opts.pp.stop(); return { stopped: true }; } },
    "eights.adapters.pp.sync_now":       { description: "Force one pp-watcher cycle.",        schema: Empty,        handler: async () => opts.pp.syncNow() },
    "eights.adapters.pp.register_now":   { description: "Bulk-register pair-programmer artifacts as RSPL resources.", schema: RegisterEnv, handler: async (a: z.infer<typeof RegisterEnv>) => opts.registrars.pp.run(a.envelope) },

    "eights.adapters.exec.start":        { description: "Start ExecutiveSuite watcher.",      schema: Empty,        handler: async () => { opts.exec.start(); return { started: true }; } },
    "eights.adapters.exec.stop":         { description: "Stop ExecutiveSuite watcher.",       schema: Empty,        handler: async () => { opts.exec.stop(); return { stopped: true }; } },
    "eights.adapters.exec.sync_now":     { description: "Force one ExecutiveSuite cycle.",    schema: Empty,        handler: async () => opts.exec.syncNow() },
    "eights.adapters.exec.register_now": { description: "Bulk-register ExecutiveSuite artifacts.", schema: RegisterEnv, handler: async (a: z.infer<typeof RegisterEnv>) => opts.registrars.exec.run(a.envelope) },

    "eights.adapters.rlm.start":         { description: "Start RLM events.jsonl watcher.",    schema: Empty,        handler: async () => { opts.rlm.start(); return { started: true }; } },
    "eights.adapters.rlm.stop":          { description: "Stop RLM watcher.",                  schema: Empty,        handler: async () => { opts.rlm.stop(); return { stopped: true }; } },
    "eights.adapters.rlm.sync_now":      { description: "Force one RLM cycle.",               schema: Empty,        handler: async () => opts.rlm.syncNow() },
    "eights.adapters.rlm.register_now":  { description: "Bulk-register RLM family artifacts.", schema: RegisterRlmArgs, handler: async (a: z.infer<typeof RegisterRlmArgs>) => opts.registrars.rlm.run(a.envelope, a.sibling) },

    "eights.adapters.xenia.start":       { description: "Start Xenia hearth events.jsonl watcher.", schema: Empty,   handler: async () => { opts.xenia.start(); return { started: true }; } },
    "eights.adapters.xenia.stop":        { description: "Stop Xenia watcher.",                schema: Empty,        handler: async () => { opts.xenia.stop(); return { stopped: true }; } },
    "eights.adapters.xenia.sync_now":    { description: "Force one Xenia cycle.",             schema: Empty,        handler: async () => opts.xenia.syncNow() },
    "eights.adapters.xenia.register_now":{ description: "Bulk-register Xenia customer-support artifacts as RSPL resources.", schema: RegisterEnv, handler: async (a: z.infer<typeof RegisterEnv>) => opts.registrars.xenia.run(a.envelope) },

    "eights.adapters.hydra.register_now":{ description: "Bulk-register Hydra squad artifacts.", schema: RegisterEnv, handler: async (a: z.infer<typeof RegisterEnv>) => opts.registrars.hydra.run(a.envelope) },

    "eights.miner.run_now":              { description: "Run the cross-project pattern miner once.", schema: Empty,  handler: async () => opts.miner.runOnce() },
    "eights.audit.bom":                  { description: "Emit a CycloneDX ML-BOM v1.7 of the eights footprint.", schema: BomArgs, handler: async (a: z.infer<typeof BomArgs>) => opts.bom.emit(a) },
  } as const;
}
