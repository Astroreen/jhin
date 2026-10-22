export const MCP_SERVER_CAPABILITY = "mcp.server";

/** The name a thread's agent knows the node's MCP server by (T3's `t3-code`). */
export const MCP_SERVER_NAME = "jhin";

/**
 * What an agent is told about the node's MCP server (T3's orchestration section): one text
 * for every agent; `shownAs` says how the agent itself names a tool, when it names it
 * otherwise (Claude Code's `mcp__jhin__threads_send`).
 */
export function jhinToolsInstructions(shownAs?: (tool: string) => string): string {
  const shown = shownAs === undefined ? "" : ` (${shownAs("threads_send")})`;
  return `## Jhin tools

The \`${MCP_SERVER_NAME}\` MCP server exposes this Jhin node's commands as tools: a command \`threads.send\` is the tool \`threads_send\`${shown}. Use them when the user asks you to work with Jhin itself: list and read projects and threads (\`projects_list\`, \`threads_list\`, \`threads_get\`, \`threads_events\`), start a thread in a project (\`threads_create\`) and send it a message (\`threads_send\`). Calls act for the current thread and only reach what this thread's agent may do. Threads you start are ordinary top-level threads the user sees in the sidebar: start one only when the user asks for a separate thread. Message other agents and the owner by address (\`jhin://<node>/agents/<id>\`, \`jhin://<node>/owner\`): \`agents_send\` delivers a message, \`agents_ask\` waits for an agent's answer (the owner answers later, as a message); a team member's alias (\`builder@workshop\`) works as its address, and \`teams_list\` lists the teams with their leads.`;
}

/**
 * What a thread's agent may do through the node's MCP server (D341), whichever agent runs
 * it: Claude Code (D340) or Codex (D889).
 */
export const AGENT_PERMISSIONS: readonly string[] = [
  "threads.read",
  "threads.write",
  "projects.read",
  "projects.write",
  "projects.browse",
  "git.read",
  "git.write",
  "mesh.read",
  "missions.read",
  "missions.write",
  // Messaging between agents (agents.md D628); never `agents.inbox`, the owner's.
  "agents.read",
  "agents.message",
  // A lead finds other teams' leads (agents.md D688, D690); never `teams.write`.
  "teams.read",
];

/** Who a credential acts as, and for which thread's agent (docs/plans/providers.md, D340). */
export interface McpGrant {
  /** The caller id its calls run as, e.g. `jhin.agent-claude:<threadId>`. */
  readonly id: string;
  /** The permissions its calls have; never `*`. */
  readonly permissions: readonly string[];
  /** The thread whose agent holds it; commands see it as `Invocation.threadId`. */
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
