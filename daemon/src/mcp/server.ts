/**
 * MCP stdio server wiring.
 *
 * The @modelcontextprotocol/sdk shape changes between minor versions; this file
 * is the single seam that owns that coupling. Engines, schemas, and tools
 * elsewhere are SDK-agnostic.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "./zod-to-json.js";

export interface ToolDef<T extends ZodTypeAny = ZodTypeAny> {
  schema: T;
  handler: (args: ReturnType<T["parse"]>) => unknown | Promise<unknown>;
  description?: string;
}

export type ToolMap = Record<string, ToolDef>;

/**
 * Fail-closed readiness gate. The daemon brings the stdio transport up before
 * the audit chain has been verified (so the MCP handshake completes fast and
 * the Hydra gateway doesn't time out connecting). Until `ready()` returns
 * `{ ok: true }`, every tool call is refused. No audited read/write ever runs
 * on an unverified chain — only the protocol handshake completes first, which
 * keeps AGENTS.md hard rule #1 intact.
 */
export type ReadinessGate = () => { ok: boolean; reason?: string };

export async function startMcpServer(
  tools: ToolMap,
  opts: { name: string; version: string; ready?: ReadinessGate },
): Promise<void> {
  const server = new Server(
    { name: opts.name, version: opts.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools).map(([name, def]) => ({
      name,
      description: def.description ?? "",
      inputSchema: zodToJsonSchema(def.schema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const def = tools[name];
    if (!def) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `unknown tool: ${name}` }) }],
        isError: true,
      };
    }
    if (opts.ready) {
      const gate = opts.ready();
      if (!gate.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: gate.reason ?? "eights-daemon not ready" }) }],
          isError: true,
        };
      }
    }
    try {
      const parsed = def.schema.parse(req.params.arguments ?? {});
      const result = await def.handler(parsed);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
