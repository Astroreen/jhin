import type { CommandInfo } from "@jhin/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Where the tools come from: a kernel, or a running node over RPC. */
export interface CommandSource {
  list(): Promise<readonly CommandInfo[]>;
  execute(name: string, input: unknown): Promise<unknown>;
}

/**
 * MCP tool name of a command: dots become underscores (`threads.send` →
 * `threads_send`). Command names never contain underscores, so this is
 * reversible, and the result fits tool-name rules of model APIs.
 */
export const toolName = (command: string): string => command.replaceAll(".", "_");

type JsonSchema = { type?: unknown; [key: string]: unknown };

/** MCP tools take objects; a command whose input is not an object gets it as `input`. */
function toolInput(schema: unknown): { schema: JsonSchema & { type: "object" }; wrapped: boolean } {
  const { $schema: _ignored, ...rest } = (schema ?? {}) as JsonSchema;
  if (rest.type === "object")
    return { schema: rest as JsonSchema & { type: "object" }, wrapped: false };
  return {
    schema: { type: "object", properties: { input: rest }, required: ["input"] },
    wrapped: true,
  };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function createMcpServer(
  source: CommandSource,
  info: { name: string; version: string } = { name: "jhin", version: "0.1.0" },
): Server {
  const server = new Server(info, {
    capabilities: { tools: {} },
    instructions:
      "Tools are this Jhin node's commands (D17). Threads: threads_create, threads_send, " +
      "threads_events; the live state of the node: host_inspect.",
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await source.list()).map((command) => ({
      name: toolName(command.name),
      description: command.description,
      inputSchema: toolInput(command.inputSchema).schema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const command = (await source.list()).find(
      (candidate) => toolName(candidate.name) === request.params.name,
    );
    if (command === undefined) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool ${request.params.name}` }],
      };
    }
    const args = request.params.arguments ?? {};
    const input = toolInput(command.inputSchema).wrapped
      ? (args as { input?: unknown }).input
      : args;
    try {
      const result = await source.execute(command.name, input);
      return {
        content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }],
        ...(isPlainObject(result) ? { structuredContent: result } : {}),
      };
    } catch (error) {
      const failure = error as { code?: unknown; message?: unknown; details?: unknown };
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { code: failure.code, message: failure.message, details: failure.details },
              null,
              2,
            ),
          },
        ],
      };
    }
  });

  return server;
}
