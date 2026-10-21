// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md),
// apps/web/src/components/settings/ScheduledTasksSettings.tsx at v0.1.1-nightly.20261020.3411:
// the actions menu of a scheduled task's row (Edit, Run now or Deliveries, Delete).
import type { ScheduledTask } from "@jhin/scheduler-api";
import { MenuItem, MenuSeparator } from "@jhin/ui";
import { InboxIcon, PencilIcon, PlayIcon, Trash2Icon } from "lucide-react";
import type { ComponentType } from "react";

/** The actions menu of a task's row on Settings → Scheduled tasks. */
export const TASK_ACTIONS_SLOT = "scheduler.task.actions";

/** What a contribution to `scheduler.task.actions` gets. */
export interface TaskActionProps {
  readonly connection: string;
  readonly task: ScheduledTask;
  edit(): void;
  openDeliveries(): void;
  run(): void;
  remove(): void;
}

/** The built-in actions, in T3's order: [id, order, component]. */
export const taskActions: readonly [string, number, ComponentType<TaskActionProps>][] = [
  [
    "edit",
    0,
    ({ edit }) => (
      <MenuItem onClick={edit}>
        <PencilIcon />
        Edit
      </MenuItem>
    ),
  ],
  [
    "run-now",
    10,
    ({ task, run }) =>
      task.schedule.type === "webhook" ? null : (
        <MenuItem onClick={run}>
          <PlayIcon />
          Run now
        </MenuItem>
      ),
  ],
  [
    "deliveries",
    10,
    ({ task, openDeliveries }) =>
      task.schedule.type !== "webhook" ? null : (
        <MenuItem onClick={openDeliveries}>
          <InboxIcon />
          Deliveries
        </MenuItem>
      ),
  ],
  ["separator", 80, () => <MenuSeparator />],
  [
    "delete",
    90,
    ({ remove }) => (
      <MenuItem onClick={remove}>
        <Trash2Icon />
        Delete
      </MenuItem>
    ),
  ],
];
