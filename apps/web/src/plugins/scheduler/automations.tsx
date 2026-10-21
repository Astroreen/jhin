// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/ThreadAutomationsPanel.tsx.
// Decisions: docs/plans/orchestration.md (D981).
import type { ChatThreadDetailsProps, Navigation } from "@jhin/client-api";
import type { ScheduledTask } from "@jhin/scheduler-api";
import {
  Switch,
  ThreadDetailsSection,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
  type Toasts,
} from "@jhin/ui";
import { CalendarClockIcon, PencilIcon, PlayIcon, Settings2Icon } from "lucide-react";
import { useState, useSyncExternalStore, type ReactNode } from "react";

import { useNow } from "../../lib/hooks.ts";
import { relativeLabel, scheduleLabel } from "./labels.ts";
import type { SchedulerStore } from "./store.ts";

const STATUS_DOT_CLASS: Record<ScheduledTask["lastRunStatus"], string> = {
  never: "bg-muted-foreground/40",
  running: "bg-sky-500",
  succeeded: "bg-emerald-500",
  failed: "bg-destructive",
};

const ICON_BUTTON =
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-64";

export interface AutomationServices {
  readonly store: SchedulerStore;
  readonly navigation: Navigation;
  readonly toasts: Toasts;
  /** Runs a command on the connection's node. */
  readonly call: (connection: string, method: string, params: unknown) => Promise<unknown>;
}

function IconButton(props: {
  label: string;
  tip: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={props.label}
            className={ICON_BUTTON}
            disabled={props.disabled}
            onClick={props.onClick}
            type="button"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.tip}</TooltipPopup>
    </Tooltip>
  );
}

/** The scheduled tasks bound to the thread, as T3's thread details show them (D981). */
export function ThreadAutomations(
  props: ChatThreadDetailsProps & { readonly services: AutomationServices },
) {
  const { target, thread, services } = props;
  const connection = target.node;
  const view = useSyncExternalStore(services.store.watch(connection), () =>
    services.store.view(connection),
  );
  const nowMs = useNow();
  const [busy, setBusy] = useState<string | null>(null);
  // A mesh member's tasks are not this connection's (orchestration.md W11 Deferred).
  const tasks = view.tasks.filter((task) => task.threadId === thread.id);
  // As T3: shown with the thread's tasks, or with the error that keeps them from showing.
  if (target.remote !== undefined || (view.status !== "error" && tasks.length === 0)) return null;

  const manage = () =>
    services.navigation.navigate({
      node: connection,
      panel: "settings",
      section: "scheduled-tasks",
    });
  const act = async (task: ScheduledTask, title: string, method: string, params: unknown) => {
    if (busy !== null) return;
    setBusy(task.id);
    try {
      await services.call(connection, method, params);
    } catch (error) {
      services.toasts.show({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-automations-heading"
      title="Automations"
      actions={
        <IconButton label="Manage scheduled tasks" tip="Manage scheduled tasks" onClick={manage}>
          <Settings2Icon className="size-3.5" />
        </IconButton>
      }
    >
      {view.status === "error" ? (
        <p className="px-2.5 py-1.5 text-2xs text-destructive">
          Could not load automations: {view.error}
        </p>
      ) : null}
      <ul className="m-0 list-none p-0">
        {tasks.map((task) => (
          <li className="group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5" key={task.id}>
            <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
              <CalendarClockIcon aria-hidden className="size-4 text-muted-foreground" />
              <span
                aria-hidden
                className={cn(
                  "absolute -top-1 -right-1 size-1.5 rounded-full",
                  STATUS_DOT_CLASS[task.lastRunStatus],
                )}
              />
            </span>
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground/80">
                {task.title}
              </span>
              <p className="truncate text-2xs text-muted-foreground">
                {scheduleLabel(task.schedule)}
                {task.enabled && task.nextRunAt !== null
                  ? ` · next ${relativeLabel(task.nextRunAt, nowMs)}`
                  : task.enabled
                    ? ""
                    : " · paused"}
              </p>
            </div>
            <IconButton label={`Edit ${task.title}`} tip="Edit automation" onClick={manage}>
              <PencilIcon className="size-3.5" />
            </IconButton>
            {/* A webhook task runs from its URL; there is no request to run it with. */}
            {task.schedule.type === "webhook" ? null : (
              <IconButton
                disabled={busy !== null || task.lastRunStatus === "running"}
                label={`Run ${task.title} now`}
                tip="Run now"
                onClick={() =>
                  void act(task, "Could not run automation", "scheduler.tasks.run", {
                    id: task.id,
                  })
                }
              >
                <PlayIcon className="size-3.5" />
              </IconButton>
            )}
            <Switch
              aria-label={task.enabled ? `Pause ${task.title}` : `Resume ${task.title}`}
              checked={task.enabled}
              disabled={busy !== null}
              // Only the flag changes, so a toggle never reverts edits made elsewhere.
              onCheckedChange={(enabled) =>
                void act(task, "Could not update automation", "scheduler.tasks.update", {
                  id: task.id,
                  enabled,
                })
              }
            />
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
