import {
  CONNECTIONS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREADS_CAPABILITY,
  type ChatThreadDetailsProps,
  type Navigation,
  type Connections,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin } from "@jhin/sdk";
import {
  UI_DIALOGS_CAPABILITY,
  UI_SETTINGS_CAPABILITY,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type Dialogs,
  type SettingsPages,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import { CalendarClockIcon } from "lucide-react";

import { builtin } from "../../lib/builtin.ts";
import { TASK_ACTIONS_SLOT, taskActions } from "./actions.tsx";
import { ChunkFailed, lazyChunk } from "../../lib/lazy-chunk.tsx";
import type { SchedulerServices } from "./page.tsx";

/**
 * Scheduled tasks in the web client (docs/plans/orchestration.md, D389): the
 * settings section listing every connected node's tasks, with their editor
 * and webhook deliveries, on the node's `scheduler.*` commands and stream.
 */
export const schedulerPlugin = builtin(
  "jhin.scheduler.ui",
  {
    requires: {
      [UI_SETTINGS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      // Every failure and refused save is told through a toast: without one it would go unseen.
      [UI_TOASTS_CAPABILITY]: "^1",
      [UI_SLOTS_CAPABILITY]: "^1",
    },
    optional: { [UI_DIALOGS_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const settings = context.services.get<SettingsPages>(UI_SETTINGS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      // A task's actions are contributions, so a plugin can add, hide or reorder them.
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      for (const [id, order, component] of taskActions) {
        context.subscriptions.add(
          slots.contribute(TASK_ACTIONS_SLOT, { id: `jhin.scheduler.${id}`, order, component }),
        );
      }
      const shared: Omit<SchedulerServices, "store"> = {
        connections,
        threads: context.services.get<ThreadsCatalog>(THREADS_CAPABILITY),
        toasts: context.services.get<Toasts>(UI_TOASTS_CAPABILITY),
        dialogs: context.services.tryGet<Dialogs>(UI_DIALOGS_CAPABILITY),
      };
      // A chunk of its own with the store, loaded with the section or the thread's automations,
      // whichever comes first (D440, D982); one that failed to load is tried again.
      let chunk:
        | Promise<{ module: typeof import("./page.tsx"); services: SchedulerServices }>
        | undefined;
      const load = () =>
        (chunk ??= import("./page.tsx")
          .then((module) => ({
            module,
            services: {
              ...shared,
              store: context.subscriptions.add(
                module.createSchedulerStore(connections, context.log),
              ),
            },
          }))
          .catch((error: unknown) => {
            chunk = undefined;
            throw error;
          }));
      const Section = lazyChunk(
        () =>
          load().then(
            ({ module: { SchedulerProvider, ScheduledTasksSection }, services }) =>
              function Section() {
                return (
                  <SchedulerProvider services={services}>
                    <ScheduledTasksSection />
                  </SchedulerProvider>
                );
              },
          ),
        {
          loading: () => null,
          failed: (_props, retry) => (
            <ChunkFailed retry={retry}>Couldn't load this section.</ChunkFailed>
          ),
        },
      );
      // T3's thread automations, in the thread details panel (D981).
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const Automations = lazyChunk<ChatThreadDetailsProps>(
        () =>
          load().then(
            ({ module, services }) =>
              function Automations(props: ChatThreadDetailsProps) {
                return (
                  <module.ThreadAutomations
                    {...props}
                    services={{
                      store: services.store,
                      navigation,
                      toasts: services.toasts,
                      call: (connection, method, params) => {
                        const node = connections.get(connection);
                        return node === undefined || node.state !== "open"
                          ? Promise.reject(new Error("The node is not connected."))
                          : node.client.call(method, params);
                      },
                    }}
                  />
                );
              },
          ),
        { loading: () => null, failed: () => null },
      );
      context.subscriptions.add(
        slots.contribute<ChatThreadDetailsProps>("chat.thread.details", {
          id: "jhin.scheduler.automations",
          order: 30,
          component: Automations,
        }),
      );
      context.subscriptions.add(
        settings.addSection({
          id: "scheduled-tasks",
          label: "Scheduled tasks",
          icon: CalendarClockIcon,
          order: 60,
          component: Section,
        }),
      );
    },
  }),
);
