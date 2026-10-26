// Who can be assigned on a node, for the mission view's titles and pickers
// (docs/plans/agents.md, C2: D1082), and on every other node the client
// shows (M1, D1532). Part of the view's chunk (D440).
import { ownerAddress, type AgentRecord } from "@jhin/agent-api";
import { targetKey, type NodeTarget, type ThreadsCatalog } from "@jhin/client-api";
import { useEffect, useMemo, useState } from "react";

import type { MeshTarget } from "../../lib/mesh-targets.ts";

/** A node's own id and its defined agents, as far as this client may read them. */
export interface Directory {
  /** The node's id (`host.identity`), for the owner's address; undefined until known. */
  readonly nodeId: string | undefined;
  readonly agents: readonly AgentRecord[];
  /** Titles by address: each agent's, and "Owner" for the node's owner, of every node read. */
  readonly titles: ReadonlyMap<string, string>;
  /** Why a source failed, one short line each (D1277); none when both were read. */
  readonly notices: readonly string[];
  /** The other nodes the client shows, each with its owner and agents (D1532). */
  readonly others: readonly OtherNode[];
}

/** Another node of the mesh, for titles and the assignee picker (D1532). */
interface OtherNode {
  readonly label: string;
  /** Its id, for its owner's address; undefined when `host.identity` did not answer. */
  readonly nodeId: string | undefined;
  readonly agents: readonly AgentRecord[];
}

const EMPTY: Directory = {
  nodeId: undefined,
  agents: [],
  titles: new Map(),
  notices: [],
  others: [],
};

/** What failed to be read, with the command's message (D1277). */
export interface DirectoryProblems {
  readonly identity?: string;
  readonly catalog?: string;
}

/** A node without the command has nothing to say; any other failure is a problem. */
const ABSENT = new Set(["COMMAND_NOT_FOUND", "METHOD_NOT_FOUND"]);

/** The failure of a read as a message, or undefined when the node simply lacks the command. */
export function problemOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && ABSENT.has(code)) return undefined;
  return error instanceof Error ? error.message : String(error);
}

/** The quiet lines the view shows for what failed (D1277). */
export function directoryNotices(problems: DirectoryProblems): string[] {
  return [
    ...(problems.identity === undefined
      ? []
      : [`Owner unavailable: host.identity failed: ${problems.identity}`]),
    ...(problems.catalog === undefined
      ? []
      : [`Agent titles unavailable: agents.catalog failed: ${problems.catalog}`]),
  ];
}

/** What one node said: its id and agents, and what failed to be read. */
interface NodeRead {
  readonly nodeId?: string;
  readonly agents: readonly AgentRecord[];
  readonly problems: DirectoryProblems;
}

/** Reads `host.identity` and `agents.catalog` of a node; never fails. */
async function readNode(threads: ThreadsCatalog, target: NodeTarget): Promise<NodeRead> {
  const identity: { nodeId?: string; problem?: string } = {};
  const catalog: { agents: AgentRecord[]; problem?: string } = { agents: [] };
  await Promise.all([
    threads.call<{ nodeId: string }>(target, "host.identity", {}).then(
      (answer) => {
        identity.nodeId = answer.nodeId;
      },
      (error: unknown) => {
        const problem = problemOf(error);
        if (problem !== undefined) identity.problem = problem;
      },
    ),
    threads.call<{ agents: AgentRecord[] }>(target, "agents.catalog", {}).then(
      (answer) => {
        catalog.agents = answer.agents;
      },
      (error: unknown) => {
        const problem = problemOf(error);
        if (problem !== undefined) catalog.problem = problem;
      },
    ),
  ]);
  return {
    agents: catalog.agents,
    problems: {
      ...(identity.problem === undefined ? {} : { identity: identity.problem }),
      ...(catalog.problem === undefined ? {} : { catalog: catalog.problem }),
    },
    ...(identity.nodeId === undefined ? {} : { nodeId: identity.nodeId }),
  };
}

/**
 * Reads `host.identity` and `agents.catalog` of the target once per view that
 * shows it, and of every other node in `nodes` (D1532). A node without agents,
 * or a token that may not read them, has none: the view then shows an
 * assignee's id (D645).
 */
export function useDirectory(
  threads: ThreadsCatalog,
  target: NodeTarget | undefined,
  nodes: readonly MeshTarget[] = [],
): Directory {
  const own = target === undefined ? undefined : targetKey(target);
  const others = nodes.filter((node) => node.key !== own);
  const key = own === undefined ? undefined : [own, ...others.map((node) => node.key)].join("\n");
  const [read, setRead] = useState<
    | {
        key: string;
        own: NodeRead;
        others: readonly (NodeRead & { label: string })[];
      }
    | undefined
  >();
  useEffect(() => {
    if (target === undefined || key === undefined) return;
    let current = true;
    void Promise.all([
      readNode(threads, target),
      ...others.map((node) =>
        readNode(threads, node.target).then((answer) => ({ ...answer, label: node.label })),
      ),
    ]).then(([mine, ...theirs]) => {
      if (current) setRead({ key, own: mine!, others: theirs as (NodeRead & { label: string })[] });
    });
    return () => {
      current = false;
    };
    // `key` names the target and every other node.
  }, [threads, key]);
  return useMemo(() => {
    if (read === undefined || read.key !== key) return EMPTY;
    const titles = new Map<string, string>();
    for (const other of read.others) {
      for (const agent of other.agents) titles.set(agent.address, agent.title);
      if (other.nodeId !== undefined)
        titles.set(ownerAddress(other.nodeId), `Owner (${other.label})`);
    }
    for (const agent of read.own.agents) titles.set(agent.address, agent.title);
    if (read.own.nodeId !== undefined) titles.set(ownerAddress(read.own.nodeId), "Owner");
    return {
      nodeId: read.own.nodeId,
      agents: read.own.agents,
      titles,
      notices: [
        ...directoryNotices(read.own.problems),
        ...read.others.flatMap((other) =>
          directoryNotices(other.problems).map((notice) => `${other.label}: ${notice}`),
        ),
      ],
      others: read.others.map((other) => ({
        label: other.label,
        nodeId: other.nodeId,
        agents: other.agents,
      })),
    };
  }, [read, key]);
}
