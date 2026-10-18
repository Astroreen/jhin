import {
  CONNECTIONS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  type Connections,
  type Navigation,
  type NodeConnection,
} from "@jhin/client-api";
import { definePlugin } from "@jhin/sdk";
import { Button, Slot, UI_SLOTS_CAPABILITY, cn, type SlotRegistry } from "@jhin/ui";
import { PlusIcon, ServerIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { builtin } from "../lib/builtin.ts";
import { useExternal } from "../lib/hooks.ts";
import { useMeshNodes } from "../lib/mesh.ts";
import { threadTarget, type ThreadTarget } from "../lib/target.ts";

interface Project {
  readonly id: string;
  readonly name: string;
  readonly scratch: boolean;
}

interface Thread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
}

/** Emitted on the client kernel whenever a thread list may have changed. */
export const THREADS_CHANGED = "ui.threads.changed";

export const sidebarPlugin = builtin(
  "jhin.sidebar",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
    },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);

      /** Projects and threads of one node: the connected one, or one reached through it. */
      function ThreadsSection(props: {
        node: NodeConnection;
        remote: string | undefined;
        label: string;
        state: "open" | "connecting" | "closed";
      }) {
        const { node, remote, label, state } = props;
        const route = useExternal(navigation, navigation.current);
        const [projects, setProjects] = useState<readonly Project[]>([]);
        const [threads, setThreads] = useState<readonly Thread[]>([]);
        const target: ThreadTarget = useMemo(() => threadTarget(node, remote), [node, remote]);

        const refresh = useCallback(async () => {
          if (state !== "open") return;
          const [nextProjects, nextThreads] = await Promise.all([
            target.call<Project[]>("projects.list"),
            target.call<Thread[]>("threads.list"),
          ]);
          setProjects(nextProjects);
          setThreads(nextThreads);
        }, [target, state]);

        useEffect(() => {
          void refresh().catch(() => undefined);
          const subscription = context.events.on(
            THREADS_CHANGED,
            () => void refresh().catch(() => undefined),
          );
          return () => subscription.dispose();
        }, [refresh]);

        const newThread = async () => {
          const thread = await target.call<Thread>("threads.create", {});
          context.events.emit(THREADS_CHANGED, { node: node.id, remote });
          navigation.navigate({
            node: node.id,
            ...(remote === undefined ? {} : { remote }),
            thread: thread.id,
          });
        };

        return (
          <section aria-label={`Node ${label}`} className="flex flex-col gap-1 px-2 py-2">
            <div className="flex items-center justify-between px-2">
              <span className="flex items-center gap-2 text-xs font-medium text-sidebar-muted-foreground">
                {remote === undefined ? (
                  <span
                    aria-label={`Connection ${state}`}
                    className={cn(
                      "size-2 rounded-full",
                      state === "open"
                        ? "bg-success"
                        : state === "connecting"
                          ? "bg-warning"
                          : "bg-error",
                    )}
                  />
                ) : (
                  <ServerIcon aria-hidden className="size-3" />
                )}
                {label}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="New thread"
                disabled={state !== "open"}
                onClick={() => void newThread()}
              >
                <PlusIcon />
              </Button>
            </div>
            {projects.map((project) => {
              const own = threads.filter((thread) => thread.projectId === project.id);
              if (own.length === 0 && project.scratch) return null;
              return (
                <div key={project.id} className="flex flex-col">
                  <span className="px-2 pt-1 text-2xs uppercase tracking-wide text-sidebar-muted-foreground">
                    {project.name}
                  </span>
                  <ul aria-label={`Threads of ${project.name}`} className="flex flex-col">
                    {own.map((thread) => {
                      const selected =
                        route.node === node.id &&
                        route.remote === remote &&
                        route.thread === thread.id;
                      return (
                        <li key={thread.id}>
                          <button
                            type="button"
                            aria-current={selected ? "page" : undefined}
                            onClick={() =>
                              navigation.navigate({
                                node: node.id,
                                ...(remote === undefined ? {} : { remote }),
                                thread: thread.id,
                              })
                            }
                            className={cn(
                              "w-full truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-sidebar-row-hover",
                              selected && "bg-sidebar-row-selected font-medium",
                            )}
                          >
                            {thread.title}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </section>
        );
      }

      /** The other nodes of a connected node's mesh, reached through it. */
      function MeshNodes({ node }: { node: NodeConnection }) {
        const members = useMeshNodes(node) ?? [];
        return (
          <>
            {members
              .filter((member) => !member.self && member.reachable)
              .map((member) => (
                <ThreadsSection
                  key={member.nodeId}
                  node={node}
                  remote={member.nodeId}
                  label={member.name}
                  state="open"
                />
              ))}
          </>
        );
      }

      function Sidebar() {
        const nodes = useExternal(connections, connections.list);
        return (
          <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex h-12 items-center justify-between border-b border-sidebar-border px-4">
              <span className="font-semibold">Jhin</span>
              <div role="toolbar" aria-label="Sidebar actions" className="flex items-center gap-1">
                <Slot name="sidebar.actions" />
              </div>
            </header>
            <nav aria-label="Nodes" className="min-h-0 flex-1 overflow-y-auto">
              {nodes.length === 0 ? (
                <p className="p-4 text-sm text-sidebar-muted-foreground">No node connected.</p>
              ) : (
                nodes.map((node) => (
                  <div key={node.id}>
                    <ThreadsSection
                      node={node}
                      remote={undefined}
                      label={node.label}
                      state={node.state}
                    />
                    <MeshNodes node={node} />
                  </div>
                ))
              )}
            </nav>
          </div>
        );
      }

      function AddNode() {
        const route = useExternal(navigation, navigation.current);
        return (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Add node"
            onClick={() => navigation.navigate({ ...route, panel: "connect" })}
          >
            <PlusIcon />
          </Button>
        );
      }

      context.subscriptions.add(
        slots.contribute("app.sidebar", { id: "jhin.sidebar.nodes", component: Sidebar }),
      );
      context.subscriptions.add(
        slots.contribute("sidebar.actions", {
          id: "jhin.sidebar.add-node",
          order: -10,
          component: AddNode,
        }),
      );
    },
  }),
);
