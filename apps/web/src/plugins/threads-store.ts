import { ThreadEvents, THREADS_STREAM } from "@jhin/agent-api";
import {
  CONNECTIONS_CAPABILITY,
  HISTORY_CACHE_CAPABILITY,
  MESH_CAPABILITY,
  THREADS_CAPABILITY,
  targetKey,
  type Connections,
  type HistoryCache,
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
      // An agent's generation is Civilization mode's, not a thread of the list (D745).
      if (thread.generationOf !== undefined) {
        return { ...catalog, threads: catalog.threads.filter((item) => item.id !== id) };
      }
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
    optional: { [HISTORY_CACHE_CAPABILITY]: "^1.1" },
  },
  definePlugin({
    activate(context) {
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const mesh = context.services.get<MeshMembership>(MESH_CAPABILITY);
      const cache = context.services.tryGet<HistoryCache>(HISTORY_CACHE_CAPABILITY);
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

      /**
       * Loads the catalog, then follows the index from the head it reflects.
       * A target of the connected node starts from the catalog the history
       * cache kept, when the node's epoch is still that one and its index has
       * not gone back, and follows the index after the kept head; a gap or a
       * refused subscription then reads the catalog after all (D1591).
       */
      const start = (feed: Feed, client: RpcClient) => {
        const generation = ++feed.generation;
        let subscription: Disposable | undefined;
        let stopped = false;
        /** Bumped when a start from the cache gives way to reading the catalog. */
        let attempt = 0;
        const connection = feed.target.node;
        const cacheable =
          feed.target.remote === undefined &&
          cache?.readCatalog !== undefined &&
          cache.writeCatalog !== undefined &&
          cache.enabled();
        /** The epoch the catalog is kept under; undefined while it is not kept. */
        let keeping: string | undefined;
        let keptHead = 0;
        let writing = false;
        /** Keeps the catalog as of `head`: one write for what changed within a tick. */
        const keep = (head: number) => {
          if (keeping === undefined) return;
          keptHead = head;
          if (writing) return;
          writing = true;
          queueMicrotask(() => {
            writing = false;
            if (stopped || feed.generation !== generation || keeping === undefined) return;
            void cache
              ?.writeCatalog?.(connection, {
                epoch: keeping,
                head: keptHead,
                projects: feed.catalog.projects,
                threads: feed.catalog.threads,
              })
              .catch(() => undefined);
          });
        };
        /** A thread gone from the catalog takes what the cache keeps of it along (D1590). */
        const forget = (before: NodeCatalog, after: NodeCatalog) => {
          if (!cacheable || before.threads.length === 0) return;
          const kept = new Set(after.threads.map((thread) => thread.id));
          for (const thread of before.threads) {
            if (!kept.has(thread.id))
              void cache?.drop(connection, `thread/${thread.id}`).catch(() => undefined);
          }
        };
        const update = (catalog: NodeCatalog) => {
          forget(feed.catalog, catalog);
          set(feed, catalog);
        };

        const run = (fromCache: boolean) => {
          const round = ++attempt;
          const current = () => !stopped && feed.generation === generation && attempt === round;
          /** Reads the catalog after all: what the cache kept cannot be followed. */
          const fallBack = () => {
            subscription?.dispose();
            subscription = undefined;
            keeping = undefined;
            run(false);
          };
          void (async () => {
            let head = 0;
            let refetchOnEvent = false;
            let followingKept = false;
            try {
              if (fromCache && cacheable) {
                const kept = await cache!.readCatalog!(connection).catch(() => undefined);
                if (!current()) return;
                if (kept !== undefined) {
                  set(feed, {
                    status: "ready",
                    projects: sortProjects([...kept.projects]),
                    threads: sortThreads([...kept.threads]),
                  });
                  const now = await call<{ epoch: string; head: number }>(
                    feed.target,
                    "threads.epoch",
                  ).catch(() => undefined);
                  if (!current()) return;
                  if (now !== undefined && now.epoch === kept.epoch && now.head >= kept.head) {
                    head = kept.head;
                    keeping = kept.epoch;
                    followingKept = true;
                  }
                }
              }
              if (!followingKept) {
                try {
                  const loaded = await call<{
                    head: number;
                    epoch?: string;
                    projects: ProjectRecord[];
                    threads: ThreadRecord[];
                  }>(feed.target, "threads.catalog");
                  head = loaded.head;
                  if (!current()) return;
                  update({
                    status: "ready",
                    projects: sortProjects(loaded.projects),
                    threads: sortThreads(loaded.threads),
                  });
                  if (cacheable && loaded.epoch !== undefined) {
                    keeping = loaded.epoch;
                    keep(head);
                  }
                } catch (error) {
                  // A node from before threads.catalog: lists, then a refetch on every change.
                  if ((error as { code?: unknown }).code !== "COMMAND_NOT_FOUND") throw error;
                  refetchOnEvent = true;
                  await reload(feed, generation);
                }
              }
              const stream = await open(feed.target, THREADS_STREAM);
              if (!current()) return;
              let pending = false;
              let last = head;
              subscription = client.subscribe(
                stream,
                {
                  after: head,
                  onError: (error: unknown) => {
                    if (!current()) return;
                    if (followingKept) fallBack();
                    else set(feed, { ...feed.catalog, status: "error", error: String(error) });
                  },
                },
                (event) => {
                  if (!current()) return;
                  // A gap (D498): what was kept cannot be brought up to date.
                  if (followingKept && event.sequence !== last + 1) {
                    fallBack();
                    return;
                  }
                  last = event.sequence;
                  if (!refetchOnEvent) {
                    update(applyIndexEvent(feed.catalog, event));
                    keep(event.sequence);
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
              if (!current()) subscription.dispose();
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
        };
        run(true);
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
