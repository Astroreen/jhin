import { ThreadEvents, THREADS_STREAM } from "@jhin/agent-api";
import {
  CONNECTIONS_CAPABILITY,
  MESH_CAPABILITY,
  THREADS_CAPABILITY,
  targetKey,
  type Connections,
  type MeshMembership,
  type NodeCatalog,
  type NodeTarget,
  type ProjectRecord,
  type ThreadRecord,
  type ThreadsCatalog,
} from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { definePlugin, toDisposable, type Disposable } from "@jhin/sdk";

import { builtin } from "../lib/builtin.ts";

const LOADING: NodeCatalog = { status: "loading", projects: [], threads: [] };

/** One target's catalog, kept current while somebody subscribes. */
interface Feed {
  readonly target: NodeTarget;
  readonly listeners: Set<() => void>;
  catalog: NodeCatalog;
  /** The client the feed reads from; undefined while the connection is not open. */
  client: RpcClient | undefined;
  stop: (() => void) | undefined;
  /** Bumped on every (re)start, so answers of an older start are dropped. */
  generation: number;
  /** For a remote target: whether the connection's node reaches it. */
  reachable: boolean;
}

const sortProjects = (projects: ProjectRecord[]) =>
  projects.toSorted(
    (a, b) => Number(b.scratch) - Number(a.scratch) || a.createdAt.localeCompare(b.createdAt),
  );
const sortThreads = (threads: ThreadRecord[]) =>
  threads.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));

/** Applies one event of a node's `threads` index to a catalog. */
export function applyIndexEvent(
  catalog: NodeCatalog,
  event: { type: string; payload: unknown },
): NodeCatalog {
  const payload = event.payload as { id?: unknown } | null;
  const id = typeof payload?.id === "string" ? payload.id : undefined;
  if (id === undefined) return catalog;
  switch (event.type) {
    case ThreadEvents.threadCreated:
    case ThreadEvents.threadUpdated: {
      const thread = payload as unknown as ThreadRecord;
      return {
        ...catalog,
        threads: sortThreads([...catalog.threads.filter((item) => item.id !== id), thread]),
      };
    }
    case ThreadEvents.threadDeleted:
      return { ...catalog, threads: catalog.threads.filter((item) => item.id !== id) };
    case ThreadEvents.projectCreated:
    case ThreadEvents.projectUpdated: {
      const project = payload as unknown as ProjectRecord;
      return {
        ...catalog,
        projects: sortProjects([...catalog.projects.filter((item) => item.id !== id), project]),
      };
    }
    case ThreadEvents.projectDeleted:
      return {
        ...catalog,
        projects: catalog.projects.filter((item) => item.id !== id),
        threads: catalog.threads.filter((item) => item.projectId !== id),
      };
    default:
      return catalog;
  }
}

export const threadsStorePlugin = builtin(
  "jhin.threads-store",
  {
    provides: { [THREADS_CAPABILITY]: "1.0.0" },
    requires: { [CONNECTIONS_CAPABILITY]: "^1", [MESH_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const mesh = context.services.get<MeshMembership>(MESH_CAPABILITY);
      const feeds = new Map<string, Feed>();

      const clientOf = (target: NodeTarget): RpcClient | undefined => {
        const node = connections.get(target.node);
        return node?.state === "open" ? node.client : undefined;
      };
      const call = <T>(target: NodeTarget, method: string, params?: unknown): Promise<T> => {
        const node = connections.get(target.node);
        if (node === undefined) {
          return Promise.reject(
            Object.assign(new Error(`Not connected to ${target.node}`), { code: "DISCONNECTED" }),
          );
        }
        return target.remote === undefined
          ? node.client.call<T>(method, params ?? {})
          : node.client.call<T>("mesh.call", {
              node: target.remote,
              method,
              params: params ?? {},
            });
      };
      const open = async (target: NodeTarget, stream: string): Promise<string> => {
        if (target.remote === undefined) return stream;
        const node = connections.get(target.node);
        if (node === undefined) throw new Error(`Not connected to ${target.node}`);
        return (
          await node.client.call<{ stream: string }>("mesh.open", { node: target.remote, stream })
        ).stream;
      };

      const notify = (feed: Feed) => {
        for (const listener of Array.from(feed.listeners)) {
          // One faulty consumer (e.g. a user plugin) never keeps the update from the others.
          try {
            listener();
          } catch (error) {
            context.log.error("a client.threads listener failed", { error: String(error) });
          }
        }
      };
      const set = (feed: Feed, catalog: NodeCatalog) => {
        if (catalog === feed.catalog) return;
        feed.catalog = catalog;
        notify(feed);
      };

      /** Loads the catalog, then follows the index from the head it reflects. */
      const start = (feed: Feed, client: RpcClient) => {
        const generation = ++feed.generation;
        let subscription: Disposable | undefined;
        let stopped = false;
        const current = () => !stopped && feed.generation === generation;
        void (async () => {
          let head = 0;
          let refetchOnEvent = false;
          try {
            try {
              const loaded = await call<{
                head: number;
                projects: ProjectRecord[];
                threads: ThreadRecord[];
              }>(feed.target, "threads.catalog");
              head = loaded.head;
              if (!current()) return;
              set(feed, {
                status: "ready",
                projects: sortProjects(loaded.projects),
                threads: sortThreads(loaded.threads),
              });
            } catch (error) {
              // A node from before threads.catalog: lists, then a refetch on every change.
              if ((error as { code?: unknown }).code !== "COMMAND_NOT_FOUND") throw error;
              refetchOnEvent = true;
              await reload(feed, generation);
            }
            const stream = await open(feed.target, THREADS_STREAM);
            if (!current()) return;
            let pending = false;
            subscription = client.subscribe(
              stream,
              {
                after: head,
                onError: (error: unknown) =>
                  current() &&
                  set(feed, { ...feed.catalog, status: "error", error: String(error) }),
              },
              (event) => {
                if (!current()) return;
                if (!refetchOnEvent) {
                  set(feed, applyIndexEvent(feed.catalog, event));
                  return;
                }
                if (pending) return;
                pending = true;
                queueMicrotask(() => {
                  pending = false;
                  void reload(feed, generation).catch((error: unknown) => {
                    if (!current()) return;
                    set(feed, {
                      ...feed.catalog,
                      status: "error",
                      error: (error as Error).message ?? String(error),
                    });
                  });
                });
              },
            );
            if (stopped) subscription.dispose();
          } catch (error) {
            if (current()) {
              set(feed, {
                ...feed.catalog,
                status: "error",
                error: (error as Error).message ?? String(error),
              });
            }
          }
        })();
        return () => {
          stopped = true;
          subscription?.dispose();
        };
      };

      const reload = async (feed: Feed, generation: number) => {
        const [projects, threads] = await Promise.all([
          call<ProjectRecord[]>(feed.target, "projects.list"),
          call<ThreadRecord[]>(feed.target, "threads.list"),
        ]);
        if (feed.generation !== generation) return;
        set(feed, {
          status: "ready",
          projects: sortProjects(projects),
          threads: sortThreads(threads),
        });
      };

      /** (Re)starts or stops a feed to match its connection and, for a remote, the mesh. */
      const sync = (feed: Feed) => {
        const client = clientOf(feed.target);
        const reachable =
          feed.target.remote === undefined ||
          (mesh.members(feed.target.node) ?? []).some(
            (member) => member.nodeId === feed.target.remote && member.reachable,
          );
        if (client === feed.client && reachable === feed.reachable) return;
        feed.reachable = reachable;
        feed.stop?.();
        feed.stop = undefined;
        feed.client = client;
        // A stopped feed keeps its last catalog; it starts over once the node is back.
        if (client !== undefined && reachable) feed.stop = start(feed, client);
      };

      const meshFollowers = new Map<string, Disposable>();
      const followMesh = (feed: Feed) => {
        if (feed.target.remote === undefined || meshFollowers.has(targetKey(feed.target))) return;
        meshFollowers.set(
          targetKey(feed.target),
          mesh.subscribe(feed.target.node, () => sync(feed)),
        );
      };

      const store: ThreadsCatalog = {
        catalog: (target) => feeds.get(targetKey(target))?.catalog ?? LOADING,
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
              catalog: LOADING,
              client: undefined,
              stop: undefined,
              generation: 0,
              // Unknown until the first sync, which then always starts the feed it can.
              reachable: false,
            };
            feeds.set(key, feed);
            followMesh(feed);
            sync(feed);
          }
          const current = feed;
          const entry = () => listener();
          current.listeners.add(entry);
          return toDisposable(() => {
            current.listeners.delete(entry);
            // A subscriber back within the same tick (a re-render, a view moved by a
            // route change) keeps the feed and its catalog: no refetch.
            queueMicrotask(() => {
              if (current.listeners.size > 0 || feeds.get(key) !== current) return;
              current.stop?.();
              current.generation += 1;
              feeds.delete(key);
              meshFollowers.get(key)?.dispose();
              meshFollowers.delete(key);
            });
          });
        },
        call,
        open: (target, threadId) => open(target, `thread/${threadId}`),
      };

      context.subscriptions.add(
        connections.subscribe(() => {
          for (const feed of feeds.values()) sync(feed);
        }),
      );
      context.subscriptions.add({
        dispose() {
          for (const feed of feeds.values()) {
            feed.stop?.();
            feed.generation += 1;
          }
          feeds.clear();
          for (const follower of meshFollowers.values()) follower.dispose();
          meshFollowers.clear();
        },
      });
      context.services.provide(THREADS_CAPABILITY, store);
    },
  }),
);
