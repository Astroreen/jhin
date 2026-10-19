import {
  isMachineKind,
  targetKey,
  type Connections,
  type MachineKind,
  type NodeConnection,
  type NodeMachine,
  type NodeMachines,
  type NodeTarget,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { toDisposable, z, type Disposable } from "@jhin/sdk";
import { useSyncExternalStore } from "react";

/** What `host.identity` answers; kinds this client does not know are read as a server. */
const Identity = z.object({
  hostname: z.string(),
  platform: z.string(),
  machine: z.string(),
  detectedMachine: z.string().optional(),
});

export function parseIdentity(answer: unknown): NodeMachine | undefined {
  const parsed = Identity.safeParse(answer);
  if (!parsed.success) return undefined;
  const { hostname, platform, machine, detectedMachine } = parsed.data;
  return {
    kind: isMachineKind(machine) ? machine : "server",
    ...(isMachineKind(detectedMachine) ? { detected: detectedMachine } : {}),
    hostname,
    platform,
  };
}

const sameMachine = (a: NodeMachine | undefined, b: NodeMachine) =>
  a !== undefined &&
  a.kind === b.kind &&
  a.detected === b.detected &&
  a.hostname === b.hostname &&
  a.platform === b.platform;

interface Feed {
  readonly target: NodeTarget;
  readonly listeners: Set<() => void>;
  machine: NodeMachine | undefined;
  /** The newest request; only its answer may update the feed. */
  latest: number;
}

export interface NodeMachineStore extends NodeMachines {
  /** Asks the followed nodes behind `connection` again (the one `remote`, when given). */
  refresh(target: NodeTarget): void;
}

/**
 * `client.machines@1` over `host.identity`: one request per followed node,
 * shared by every subscriber, asked again only when its connection opens
 * again or on `refresh`. A node that could not answer (older than
 * `host.identity`) is not asked again by every view that follows it.
 */
export function createNodeMachines(
  connections: Pick<Connections, "list" | "subscribe">,
  threads: Pick<ThreadsCatalog, "call">,
  onListenerError: (error: unknown) => void = () => undefined,
  /** A node did not answer `host.identity`: older than it, out of reach, or not permitted. */
  onIdentityError: (target: NodeTarget, error: unknown) => void = () => undefined,
): NodeMachineStore & Disposable {
  const feeds = new Map<string, Feed>();
  const states = new Map<string, NodeConnection["state"]>();
  let connectionFeed: Disposable | undefined;

  const notify = (feed: Feed) => {
    for (const listener of Array.from(feed.listeners)) {
      // One faulty consumer (e.g. a user plugin) never keeps the update from the others.
      try {
        listener();
      } catch (error) {
        onListenerError(error);
      }
    }
  };

  const load = (key: string, feed: Feed) => {
    const request = ++feed.latest;
    threads.call(feed.target, "host.identity").then(
      (answer) => {
        if (feeds.get(key) !== feed || request !== feed.latest) return;
        const machine = parseIdentity(answer);
        if (machine === undefined || sameMachine(feed.machine, machine)) return;
        feed.machine = machine;
        notify(feed);
      },
      // What is known stays, else the node shows as a server; the caller logs why.
      (error: unknown) => {
        if (feeds.get(key) === feed && request === feed.latest) onIdentityError(feed.target, error);
      },
    );
  };

  const reconnected = () => {
    const reopened = new Set<string>();
    const listed = connections.list();
    for (const connection of listed) {
      if (connection.state === "open" && states.get(connection.id) !== "open")
        reopened.add(connection.id);
      states.set(connection.id, connection.state);
    }
    // A removed connection is forgotten: added again, it opens as a new one.
    for (const id of states.keys())
      if (!listed.some((connection) => connection.id === id)) states.delete(id);
    for (const [key, feed] of feeds) if (reopened.has(feed.target.node)) load(key, feed);
  };

  return {
    get: (target) => feeds.get(targetKey(target))?.machine,
    subscribe(target, listener) {
      const key = targetKey(target);
      let feed = feeds.get(key);
      if (feed === undefined) {
        feed = {
          target: {
            node: target.node,
            ...(target.remote === undefined ? {} : { remote: target.remote }),
          },
          listeners: new Set(),
          machine: undefined,
          latest: 0,
        };
        feeds.set(key, feed);
        load(key, feed);
      }
      if (connectionFeed === undefined) {
        for (const connection of connections.list()) states.set(connection.id, connection.state);
        connectionFeed = connections.subscribe(reconnected);
      }
      const current = feed;
      // A wrapper per subscription: the same listener may subscribe twice.
      const entry = () => listener();
      current.listeners.add(entry);
      return toDisposable(() => {
        current.listeners.delete(entry);
        if (current.listeners.size > 0 || feeds.get(key) !== current) return;
        feeds.delete(key);
        if (feeds.size > 0) return;
        connectionFeed?.dispose();
        connectionFeed = undefined;
        states.clear();
      });
    },
    refresh(target) {
      for (const [key, feed] of feeds)
        if (
          feed.target.node === target.node &&
          (target.remote === undefined || feed.target.remote === target.remote)
        )
          load(key, feed);
    },
    dispose() {
      connectionFeed?.dispose();
      connectionFeed = undefined;
      feeds.clear();
      states.clear();
    },
  };
}

type Subscribe = (listener: () => void) => () => void;
const noSubscription: Subscribe = () => () => undefined;
const machineSubscribers = new WeakMap<NodeMachines, Map<string, Subscribe>>();

/** One subscribe function per store and target, as React wants it (see `useCatalog`). */
function subscriberFor(machines: NodeMachines | undefined, target: NodeTarget | undefined) {
  if (machines === undefined || target === undefined) return noSubscription;
  const byTarget = machineSubscribers.get(machines) ?? new Map<string, Subscribe>();
  machineSubscribers.set(machines, byTarget);
  const key = targetKey(target);
  let subscribe = byTarget.get(key);
  if (subscribe === undefined) {
    const fixed = { ...target };
    subscribe = (listener) => {
      const subscription = machines.subscribe(fixed, listener);
      return () => subscription.dispose();
    };
    byTarget.set(key, subscribe);
  }
  return subscribe;
}

/** What a node reported, kept current; `undefined` until it answers and without `client.machines`. */
export function useMachine(
  machines: NodeMachines | undefined,
  target: NodeTarget | undefined,
): NodeMachine | undefined {
  return useSyncExternalStore(subscriberFor(machines, target), () =>
    target === undefined ? undefined : machines?.get(target),
  );
}

/** The machine kind of a node, kept current: a server's until the node says otherwise. */
export function useMachineKind(
  machines: NodeMachines | undefined,
  target: NodeTarget | undefined,
): MachineKind {
  return useMachine(machines, target)?.kind ?? "server";
}
