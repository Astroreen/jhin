import {
  CONNECTIONS_CAPABILITY,
  THREADS_CAPABILITY,
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
import { ScheduledTasksSection, SchedulerProvider, type SchedulerServices } from "./page.tsx";
import { createSchedulerStore } from "./store.ts";

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
      const services: SchedulerServices = {
        store: context.subscriptions.add(createSchedulerStore(connections, context.log)),
        connections,
        threads: context.services.get<ThreadsCatalog>(THREADS_CAPABILITY),
        toasts: context.services.get<Toasts>(UI_TOASTS_CAPABILITY),
        dialogs: context.services.tryGet<Dialogs>(UI_DIALOGS_CAPABILITY),
      };
      function Section() {
        return (
          <SchedulerProvider services={services}>
            <ScheduledTasksSection />
          </SchedulerProvider>
        );
      }
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
