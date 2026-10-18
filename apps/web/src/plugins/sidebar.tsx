import {
  CONNECTIONS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  type Connections,
  type Navigation,
  type NodeConnection,
} from "@jhin/client-api";
import { definePlugin } from "@jhin/sdk";
import { Button, Slot, UI_SLOTS_CAPABILITY, cn, type SlotRegistry } from "@jhin/ui";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { builtin } from "../lib/builtin.ts";
import { useExternal } from "../lib/hooks.ts";

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

      function NodeSection({ node }: { node: NodeConnection }) {
        const route = useExternal(navigation, navigation.current);
        const [projects, setProjects] = useState<readonly Project[]>([]);
        const [threads, setThreads] = useState<readonly Thread[]>([]);

        const refresh = useCallback(async () => {
          if (node.state !== "open") return;
          const [nextProjects, nextThreads] = await Promise.all([
            node.client.call<Project[]>("projects.list"),
            node.client.call<Thread[]>("threads.list"),
          ]);
          setProjects(nextProjects);
          setThreads(nextThreads);
        }, [node]);

        useEffect(() => {
          void refresh().catch(() => undefined);
          const subscription = context.events.on(
            THREADS_CHANGED,
            () => void refresh().catch(() => undefined),
          );
          return () => subscription.dispose();
        }, [refresh]);

        const newThread = async () => {
          const thread = await node.client.call<Thread>("threads.create", {});
          context.events.emit(THREADS_CHANGED, { node: node.id });
          navigation.navigate({ node: node.id, thread: thread.id });
        };

        return (
          <section aria-label={`Node ${node.label}`} className="flex flex-col gap-1 px-2 py-2">
            <div className="flex items-center justify-between px-2">
              <span className="flex items-center gap-2 text-xs font-medium text-sidebar-muted-foreground">
                <span
                  aria-label={`Connection ${node.state}`}
                  className={cn(
                    "size-2 rounded-full",
                    node.state === "open"
                      ? "bg-success"
                      : node.state === "connecting"
                        ? "bg-warning"
                        : "bg-error",
                  )}
                />
                {node.label}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="New thread"
                disabled={node.state !== "open"}
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
                      const selected = route.node === node.id && route.thread === thread.id;
                      return (
                        <li key={thread.id}>
                          <button
                            type="button"
                            aria-current={selected ? "page" : undefined}
                            onClick={() =>
                              navigation.navigate({ node: node.id, thread: thread.id })
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
                nodes.map((node) => <NodeSection key={node.id} node={node} />)
              )}
            </nav>
          </div>
        );
      }

      context.subscriptions.add(
        slots.contribute("app.sidebar", { id: "jhin.sidebar.nodes", component: Sidebar }),
      );
    },
  }),
);
