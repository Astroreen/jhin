import type { RpcClient } from "@jhin/rpc";

/**
 * Answers that are final for this opening: a command the node lacks (as
 * `@jhin/host-api` checks), or a token that may not read its agents.
 */
const NO_AGENTS = new Set(["COMMAND_NOT_FOUND", "METHOD_NOT_FOUND", "PERMISSION_DENIED"]);

/**
 * Whether a node has a defined agent (A1's `agents.catalog`, D747): `false`
 * when it has none, no agents plugin or no right to read them, `undefined` when the answer is not
 * known (a timeout, a node still starting), so the caller asks again later.
 */
export function hasAgents(client: Pick<RpcClient, "call">): Promise<boolean | undefined> {
  return client.call<{ agents: readonly unknown[] }>("agents.catalog", {}).then(
    ({ agents }) => agents.length > 0,
    (error: unknown) =>
      NO_AGENTS.has(String((error as { code?: unknown } | null)?.code)) ? false : undefined,
  );
}
