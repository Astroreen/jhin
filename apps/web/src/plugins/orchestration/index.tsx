import { OrchestrationThreadEvents, ThreadEvents } from "@jhin/agent-api";
import {
  CONNECTIONS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREADS_CAPABILITY,
  type ChatThreadDetailsProps,
  type ChatTurnItemProps,
  type Connections,
  type Navigation,
  type NodeTarget,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin } from "@jhin/sdk";
import {
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";

import { builtin } from "../../lib/builtin.ts";
import { lazyChunk } from "../../lib/lazy-chunk.tsx";
import type { DelegatedWorkServices } from "./view.tsx";

/**
 * `jhin.orchestration-view`: delegated tasks, workflows and launched threads
 * in the turn that started them, live from the node's records
 * (docs/plans/orchestration.md, D864). The rows and their store are a chunk
 * of their own, loaded with the first mark.
 */
export const orchestrationViewPlugin = builtin(
  "jhin.orchestration-view",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
    },
    optional: { [UI_TOASTS_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      // The rows, their store and the Lineage rows are one chunk, loaded with the first of them.
      let chunk:
        | undefined
        | Promise<{ module: typeof import("./view.tsx"); services: DelegatedWorkServices }>;
      const load = () =>
        (chunk ??= import("./view.tsx")
          .then((module) => ({
            module,
            services: {
              store: context.subscriptions.add(
                module.createDelegationStore(connections, threads, context.log),
              ),
              open: (target: NodeTarget, threadId: string) =>
                navigation.navigate({
                  node: target.node,
                  ...(target.remote === undefined ? {} : { remote: target.remote }),
                  thread: threadId,
                }),
              threads,
              toasts,
            },
          }))
          .catch((error: unknown) => {
            // A chunk that failed to load is tried again by the next mark, not given up for good.
            chunk = undefined;
            throw error;
          }));
      const DelegatedWork = lazyChunk<ChatTurnItemProps>(
        () =>
          load().then(
            ({ module, services }) =>
              function Loaded(props: ChatTurnItemProps) {
                return <module.DelegatedWork {...props} services={services} />;
              },
          ),
        { loading: () => null, failed: () => null },
      );
      const Lineage = lazyChunk<ChatThreadDetailsProps>(
        () =>
          load().then(
            ({ module, services }) =>
              function Loaded(props: ChatThreadDetailsProps) {
                return <module.Lineage {...props} services={services} />;
              },
          ),
        { loading: () => null, failed: () => null },
      );
      context.subscriptions.add(
        slots.contribute<ChatThreadDetailsProps>("chat.thread.lineage", {
          id: "jhin.orchestration.lineage",
          component: Lineage,
        }),
      );
      // One contribution per kind of mark, so each can be hidden by its id (D12).
      for (const [id, type] of [
        ["jhin.orchestration.subagent", OrchestrationThreadEvents.taskDelegated],
        ["jhin.orchestration.workflow", OrchestrationThreadEvents.workflowStarted],
        ["jhin.orchestration.launched", OrchestrationThreadEvents.threadLaunched],
        ["jhin.orchestration.provider-subagent", ThreadEvents.subagentStarted],
      ] as const) {
        context.subscriptions.add(
          slots.contribute<ChatTurnItemProps>("chat.turn.item", {
            id,
            component: (props) => (props.event.type === type ? <DelegatedWork {...props} /> : null),
          }),
        );
      }
    },
  }),
);
