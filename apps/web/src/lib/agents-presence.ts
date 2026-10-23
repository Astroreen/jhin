import type { RpcClient } from "@jhin/rpc";

/**
 * Answers that are final for this opening: a command the node lacks (as
 * `@jhin/host-api` checks), or a token that may not read its agents.
 */
const NO_AGENTS = new Set(["COMMAND_NOT_FOUND", "METHOD_NOT_FOUND", "PERMISSION_DENIED"]);

/**
 * What `agents.catalog` told of a node's agents: `some`, `none` (an empty
 * catalog), `missing` (no agents plugin, maybe not active yet), `denied` (a
 * token that may not read them, final for the opening) or `unknown` (a timeout,
 * a node still starting).
 */
export type AgentsAnswer = "some" | "none" | "missing" | "denied" | "unknown";

export function askAgents(client: Pick<RpcClient, "call">): Promise<{
  answer: AgentsAnswer;
  /** The `agents` stream's head at the catalog, when it answered. */ head?: number;
}> {
  return client.call<{ head?: number; agents: readonly unknown[] }>("agents.catalog", {}).then(
    ({ head, agents }) => ({
      answer: agents.length > 0 ? ("some" as const) : ("none" as const),
      ...(typeof head === "number" ? { head } : {}),
    }),
    (error: unknown) => {
      const code = String((error as { code?: unknown } | null)?.code);
      return {
        answer:
          code === "PERMISSION_DENIED" ? "denied" : NO_AGENTS.has(code) ? "missing" : "unknown",
      } as const;
    },
  );
}

/**
 * Whether a node has a defined agent (A1's `agents.catalog`, D747): `false`
 * when it has none, no agents plugin or no right to read them, `undefined` when the answer is not
 * known (a timeout, a node still starting), so the caller asks again later.
 */
export async function hasAgents(client: Pick<RpcClient, "call">): Promise<boolean | undefined> {
  const { answer } = await askAgents(client);
  return answer === "unknown" ? undefined : answer === "some";
}
