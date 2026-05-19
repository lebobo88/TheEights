import { z } from "zod";
import type { IdentityEngine } from "../engines/identity.js";

export const RegisterProjectArgs = z.object({
  name: z.string().min(1),
  domain: z.string().min(1),
  default_scopes: z.array(z.string()).default([]),
});

export const RegisterActorArgs = z.object({
  name: z.string().min(1),
  kind: z.enum(["agent", "human", "system"]),
  parent_id: z.string().optional(),
});

export function registerIdentityTools(engine: IdentityEngine) {
  return {
    "eights.identity.register_project": {
      schema: RegisterProjectArgs,
      handler: (a: z.infer<typeof RegisterProjectArgs>) =>
        ({ project_id: engine.registerProject(a.name, a.domain, a.default_scopes) }),
    },
    "eights.identity.register_actor": {
      schema: RegisterActorArgs,
      handler: (a: z.infer<typeof RegisterActorArgs>) =>
        ({ actor_id: engine.registerActor(a.name, a.kind, a.parent_id) }),
    },
  } as const;
}
