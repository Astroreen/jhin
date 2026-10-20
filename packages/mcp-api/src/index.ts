export const MCP_SERVER_CAPABILITY = "mcp.server";

/** Who a credential acts as, and for which thread's agent (docs/plans/providers.md, D340). */
export interface McpGrant {
  /** The caller id its calls run as, e.g. `jhin.agent-claude:<threadId>`. */
  readonly id: string;
  /** The permissions its calls have; never `*`. */
  readonly permissions: readonly string[];
  /** The thread whose agent holds it; commands see it as `caller.threadId`. */
  readonly threadId?: string;
}

/** A credential for one agent process; disposing it revokes it. */
export interface McpCredential {
  /** The endpoint, reachable from the node's own machine. */
  readonly url: string;
  /** The headers each request sends (`Authorization`). Secret: never log them. */
  readonly headers: Readonly<Record<string, string>>;
  dispose(): void;
}

/** `mcp.server@1`: the node's MCP endpoint and credentials for the agents it runs. */
export interface McpServer {
  /** The endpoint, reachable from the node's own machine. */
  readonly url: string;
  issue(grant: McpGrant): McpCredential;
}
