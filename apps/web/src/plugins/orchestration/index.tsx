import { OrchestrationThreadEvents } from "@jhin/agent-api";
import {
  CONNECTIONS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREADS_CAPABILITY,
  type ChatTurnItemProps,
  type Connections,
  type Navigation,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin } from "@jhin/sdk";
import { UI_SLOTS_CAPABILITY, type SlotRegistry } from "@jhin/ui";

import { builtin } from "../../lib/builtin.ts";
import { lazyChunk } from "../../lib/lazy-chunk.tsx";
import { createDelegationStore } from "./store.ts";
import type { DelegatedWorkServices } from "./view.tsx";

/**
 * `jhin.orchestration-view`: delegated tasks, workflows and launched threads
 * in the turn that started them, live from the node's records
 * (docs/plans/orchestration.md, D864). The rows are a chunk of their own,
 * loaded with the first mark.
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
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const services: DelegatedWorkServices = {
        store: context.subscriptions.add(
          createDelegationStore(
            context.services.get<Connections>(CONNECTIONS_CAPABILITY),
            context.services.get<ThreadsCatalog>(THREADS_CAPABILITY),
            context.log,
          ),
        ),
        open: (target, threadId) =>
          navigation.navigate({
            node: target.node,
            ...(target.remote === undefined ? {} : { remote: target.remote }),
            thread: threadId,
          }),
      };
      const DelegatedWork = lazyChunk(
        () => import("./view.tsx").then((module) => module.DelegatedWork),
        { loading: () => null, failed: () => null },
      );
      // One contribution per kind of mark, so each can be hidden by its id (D12).
      for (const [id, type] of [
        ["jhin.orchestration.subagent", OrchestrationThreadEvents.taskDelegated],
        ["jhin.orchestration.workflow", OrchestrationThreadEvents.workflowStarted],
        ["jhin.orchestration.launched", OrchestrationThreadEvents.threadLaunched],
      ] as const) {
        context.subscriptions.add(
          slots.contribute<ChatTurnItemProps>("chat.turn.item", {
            id,
            component: (props) =>
              props.event.type === type ? <DelegatedWork {...props} services={services} /> : null,
          }),
        );
      }
    },
  }),
);
