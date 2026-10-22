// Who can be assigned on a node, for the mission view's titles and pickers
// (docs/plans/agents.md, C2: D1082). Part of the view's chunk (D440).
import { ownerAddress, type AgentRecord } from "@jhin/agent-api";
import { targetKey, type NodeTarget, type ThreadsCatalog } from "@jhin/client-api";
import { useEffect, useMemo, useState } from "react";

/** A node's own id and its defined agents, as far as this client may read them. */
export interface Directory {
  /** The node's id (`host.identity`), for the owner's address; undefined until known. */
  readonly nodeId: string | undefined;
  readonly agents: readonly AgentRecord[];
  /** Titles by address: each agent's, and "Owner" for the node's owner. */
  readonly titles: ReadonlyMap<string, string>;
}

const EMPTY: Directory = { nodeId: undefined, agents: [], titles: new Map() };

/**
 * Reads `host.identity` and `agents.catalog` of the target once per view that
 * shows it. A node without agents, or a token that may not read them, has none:
 * the view then shows an assignee's id (D645).
 */
export function useDirectory(threads: ThreadsCatalog, target: NodeTarget | undefined): Directory {
  const key = target === undefined ? undefined : targetKey(target);
  const [read, setRead] = useState<
    { key: string; nodeId?: string; agents: readonly AgentRecord[] } | undefined
  >();
  useEffect(() => {
    if (target === undefined || key === undefined) return;
    let current = true;
    void Promise.all([
      threads
        .call<{ nodeId: string }>(target, "host.identity", {})
        .then((identity) => identity.nodeId)
        .catch(() => undefined),
      threads
        .call<{ agents: AgentRecord[] }>(target, "agents.catalog", {})
        .then((catalog) => catalog.agents)
        .catch(() => [] as AgentRecord[]),
    ]).then(([nodeId, agents]) => {
      if (current) setRead({ key, agents, ...(nodeId === undefined ? {} : { nodeId }) });
    });
    return () => {
      current = false;
    };
  }, [threads, key]);
  return useMemo(() => {
    if (read === undefined || read.key !== key) return EMPTY;
    const titles = new Map(read.agents.map((agent) => [agent.address, agent.title]));
    if (read.nodeId !== undefined) titles.set(ownerAddress(read.nodeId), "Owner");
    return { nodeId: read.nodeId, agents: read.agents, titles };
  }, [read, key]);
}
