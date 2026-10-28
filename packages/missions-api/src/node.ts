import { z, type CommandDefinition, type Invocation } from "@jhin/sdk";

// --- The mission's node (docs/plans/agents.md D1542) ------------------------------

/**
 * `node` of a missions command: the node the mission lives on, when not this
 * one. The command runs there through `mesh.call` (D1542).
 */
export const MissionNode = z.string().min(1).optional().meta({
  description:
    "The node the mission lives on, when not this one: the command runs there through the mesh",
});

/**
 * `by` of a missions command forwarded from another node: the agent who made
 * the call there, as its address. The mission's node records it when the
 * call came from the node the address lives on (D622), else the node.
 */
export const MissionCaller = z.string().min(1).optional().meta({
  description:
    "The agent who made a call forwarded from another node, as its address; recorded only when the address lives on the calling node",
});

const AGENT_ADDRESS = /^jhin:\/\/([^/]+)\/agents\/[^/]+$/;

const agents = new WeakMap<Invocation, string>();

/**
 * Who a record of this call names as `by`: the agent a call of another node
 * named and its node vouched for (D1567), else the caller.
 */
export const recordedBy = (invocation: Invocation): string | undefined =>
  agents.get(invocation) ?? invocation.caller?.id;

type Execute = (name: string, input: unknown, invocation?: Invocation) => Promise<unknown>;

/**
 * Runs `method` on `node` through `mesh.call`, as the caller with no more
 * than `permissions`: the caller held them here, and the node there
 * intersects them with what it grants members (security.md D416). The
 * forward itself needs no `mesh.call` of the caller, as A2's messages to
 * another node need none (D628): naming the mission's node is part of the
 * command, which reaches that node only. A call that came from another node
 * goes back to it only (`RELAY_REFUSED`).
 */
export function forwardToNode<T = unknown>(
  execute: Execute,
  node: string,
  method: string,
  params: unknown,
  invocation: Invocation,
  permissions: readonly string[],
  /** Who calls when `invocation` names nobody: the plugin forwarding. */
  callerId = "jhin.missions",
): Promise<T> {
  // A call from another node goes back to that node only: no node relays a
  // member's call to a third with its own membership (D416).
  const origin =
    invocation.caller?.id.startsWith("node:") === true
      ? invocation.caller.id.slice("node:".length)
      : undefined;
  if (origin !== undefined && origin !== node) {
    return Promise.reject(
      Object.assign(
        new Error(`${method} on node ${node} came from node ${origin}: call that node itself`),
        { code: "RELAY_REFUSED", details: { node, origin } },
      ),
    );
  }
  return execute(
    "mesh.call",
    { node, method, params },
    {
      ...(invocation.traceId === undefined ? {} : { traceId: invocation.traceId }),
      caller: {
        id: invocation.caller?.id ?? callerId,
        permissions: ["mesh.call", ...permissions],
      },
    },
  ) as Promise<T>;
}

/** `schema` with `node` added: an object, or each object of a union. */
function withNode(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) return schema.extend({ node: MissionNode, by: MissionCaller });
  if (schema instanceof z.ZodUnion) {
    const options = (schema.options as readonly z.ZodType[]).map(withNode);
    return z.union(options as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }
  throw new TypeError("A missions command's input is an object or a union of objects");
}

export interface MissionNodeOptions<I extends z.ZodType, O extends z.ZodType> {
  /** This node's id, when known: `node` naming it runs the command here. */
  readonly nodeId?: string;
  readonly execute: Execute;
  /** The plugin registering the command: who forwards an in-process call. */
  readonly callerId?: string;
  /**
   * Runs the command for another node instead of forwarding it as it came,
   * e.g. to name the caller's thread there or to split a long wait.
   */
  readonly remote?: (
    node: string,
    input: z.output<I>,
    invocation: Invocation,
  ) => Promise<z.input<O>> | z.input<O>;
}

/** The address of the agent whose thread makes the call, if a generation of this node's. */
async function agentOf(
  options: { nodeId?: string; execute: Execute },
  invocation: Invocation,
): Promise<string | undefined> {
  if (options.nodeId === undefined || invocation.threadId === undefined) return undefined;
  if (invocation.caller?.id.startsWith("node:") === true) return undefined;
  try {
    const { thread } = (await options.execute(
      "threads.get",
      { threadId: invocation.threadId },
      { caller: { id: "jhin.missions", permissions: ["threads.read"] } },
    )) as { thread: { generationOf?: string } };
    return thread.generationOf === undefined
      ? undefined
      : `jhin://${options.nodeId}/agents/${thread.generationOf}`;
  } catch {
    return undefined;
  }
}

/**
 * Adds `node` to a command about a mission, its slices or its project
 * (D1542): without it, or naming this node, the command runs here; naming
 * another node it runs there through `mesh.call`, with the permissions the
 * command needs, and answers what that node answers.
 */
export function onMissionNode<I extends z.ZodType, O extends z.ZodType>(
  definition: CommandDefinition<I, O>,
  options: MissionNodeOptions<I, O>,
): CommandDefinition<z.ZodType, O> {
  return {
    ...definition,
    input: withNode(definition.input),
    handler: async (given, invocation) => {
      const { node, by, ...input } = given as { node?: string; by?: string } & Record<
        string,
        unknown
      >;
      if (node === undefined || node === options.nodeId) {
        // A node speaks only for its own parties (D622): `by` is taken from
        // a call of node X when its address lives on X, else the node stays.
        const caller = invocation.caller;
        const named =
          caller?.id.startsWith("node:") === true &&
          by !== undefined &&
          AGENT_ADDRESS.exec(by)?.[1] === caller.id.slice("node:".length);
        if (!named || by === undefined) return definition.handler(input as z.output<I>, invocation);
        // The caller stays `node:X`: relay guards read it. Only records of `by` read the agent.
        const carried = { ...invocation };
        agents.set(carried, by);
        return definition.handler(input as z.output<I>, carried);
      }
      if (options.remote !== undefined) {
        return options.remote(node, input as z.output<I>, invocation);
      }
      // The agent calling here, so the record there names it, not this node.
      const agent = await agentOf(options, invocation);
      return forwardToNode<z.input<O>>(
        options.execute,
        node,
        definition.name,
        agent === undefined ? input : { ...input, by: agent },
        invocation,
        definition.permissions ?? [],
        options.callerId,
      );
    },
  };
}
