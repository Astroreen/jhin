// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md),
// apps/web/src/components/settings/ScheduledTasksSettings.tsx at v0.1.1-nightly.20261020.3411:
// the Scheduled tasks settings page, its rows and actions, the task editor and the webhook
// deliveries dialog, with T3's wording.
import type { Connections, NodeConnection, ThreadsCatalog } from "@jhin/client-api";
import type { Delivery, DeliverySummary, ScheduledTask } from "@jhin/scheduler-api";
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
  Label,
  Menu,
  MenuPopup,
  MenuTrigger,
  Slot,
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
  type Dialogs,
  type Toasts,
} from "@jhin/ui";
import { CopyIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { useCatalog, useCopy, useExternal, useNow } from "../../lib/hooks.ts";
import { SettingsRow, SettingsSection } from "../../lib/settings-layout.tsx";
import {
  DEFAULT_WEBHOOK_PROMPT,
  DELIVERY_OUTCOME_LABELS,
  EMPTY_DRAFT,
  WEEKDAY_LABELS,
  WEEKDAY_ORDER,
  WEEKDAY_SHORT,
  deliveryOutcomeVariant,
  relativeLabel,
  scheduleFromDraft,
  scheduleLabel,
  statusVariant,
  taskToDraft,
  type DraftState,
  type ScheduleMode,
  draftProblem,
} from "./labels.ts";
import { TASK_ACTIONS_SLOT, type TaskActionProps } from "./actions.tsx";
import type { SchedulerStore, SchedulerView } from "./store.ts";

export { createSchedulerStore } from "./store.ts";

export interface SchedulerServices {
  readonly store: SchedulerStore;
  readonly connections: Connections;
  readonly threads: ThreadsCatalog;
  readonly toasts: Toasts;
  readonly dialogs: Dialogs | undefined;
}

const SchedulerContext = createContext<SchedulerServices | undefined>(undefined);

export function SchedulerProvider(props: { services: SchedulerServices; children: ReactNode }) {
  return (
    <SchedulerContext.Provider value={props.services}>{props.children}</SchedulerContext.Provider>
  );
}

function useServices(): SchedulerServices {
  const services = useContext(SchedulerContext);
  if (services === undefined) throw new Error("The scheduled tasks page needs its services");
  return services;
}

/** A node's tasks, kept current: one subscription per connection however often the caller renders. */
function useSchedulerView(store: SchedulerStore, connection: string): SchedulerView {
  return useSyncExternalStore(store.watch(connection), () => store.view(connection));
}

/**
 * Which of `ids` have a scheduler, kept current: every node's view is
 * followed, so the list changes when a node turns out to have none.
 */
function useNodesWithScheduler(store: SchedulerStore, ids: readonly string[]): readonly string[] {
  const key = ids.join("\n");
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribes = (key === "" ? [] : key.split("\n")).map((id) =>
        store.watch(id)(listener),
      );
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    [store, key],
  );
  // A string, so an unchanged answer is the same snapshot.
  const snapshot = useSyncExternalStore(subscribe, () =>
    (key === "" ? [] : key.split("\n"))
      .filter((id) => store.view(id).status !== "unavailable")
      .join("\n"),
  );
  return snapshot === "" ? [] : snapshot.split("\n");
}

/** A rejection may be anything, not only an Error. */
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Runs a command on a connection's node. */
function useCall() {
  const { connections } = useServices();
  return <T,>(connection: string, method: string, params: unknown): Promise<T> => {
    const node = connections.get(connection);
    if (node === undefined || node.state !== "open") {
      return Promise.reject(new Error("The node is not connected."));
    }
    return node.client.call<T>(method, params);
  };
}

function useReportFailure() {
  const { toasts } = useServices();
  return (title: string, error: unknown) =>
    toasts.show({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    });
}

function RelativeLabel(props: { value: string | null }) {
  const now = useNow();
  return relativeLabel(props.value, now);
}

interface EditorTarget {
  readonly connection: string;
  readonly task: ScheduledTask | null;
}

/** Settings → Scheduled tasks: the tasks of every connected node. */
export function ScheduledTasksSection() {
  const { connections } = useServices();
  const nodes = useExternal(connections, connections.list);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  /** "New task" on a node's own section, so it always names a node with a scheduler. */
  const newTask = (connection: string, disabled: boolean) => (
    <Button
      disabled={disabled}
      onClick={() => setEditor({ connection, task: null })}
      size="xs"
      variant="ghost-muted"
    >
      <PlusIcon className="size-3" />
      New task
    </Button>
  );
  return (
    <>
      {nodes.length === 0 ? (
        <SettingsSection headerAction={newTask("", true)} title="Scheduled tasks">
          <SettingsRow
            description="Connect a node to manage scheduled tasks."
            title="No nodes available"
          />
        </SettingsSection>
      ) : (
        nodes.map((node) => (
          <NodeTasks
            key={node.id}
            newTask={newTask}
            node={node}
            onEdit={(task) => setEditor({ connection: node.id, task })}
            title={nodes.length > 1 ? node.label : "Scheduled tasks"}
          />
        ))
      )}
      {editor === null ? null : (
        <EditorDialog
          initialConnection={editor.connection}
          key={`${editor.connection}:${editor.task?.id ?? "new"}`}
          onClose={() => setEditor(null)}
          task={editor.task}
        />
      )}
    </>
  );
}

function NodeTasks(props: {
  node: NodeConnection;
  title: string;
  newTask(connection: string, disabled: boolean): ReactNode;
  onEdit(task: ScheduledTask): void;
}) {
  const { node, title, newTask, onEdit } = props;
  const { store } = useServices();
  const view = useSchedulerView(store, node.id);
  const headerAction = newTask(
    node.id,
    node.state !== "open" || view.status === "unavailable" || view.status === "loading",
  );
  if (view.status === "unavailable") {
    return (
      <SettingsSection headerAction={headerAction} title={title}>
        <SettingsRow
          description={`${node.label} has no scheduler plugin.`}
          title="Scheduled tasks unavailable"
        />
      </SettingsSection>
    );
  }
  return (
    <SettingsSection headerAction={headerAction} title={title}>
      {node.state !== "open" ? (
        <SettingsRow
          description={`Reconnect ${node.label} to view its scheduled tasks.`}
          title="Node disconnected"
        />
      ) : view.status === "error" ? (
        <SettingsRow description={view.error} title="Could not load scheduled tasks" />
      ) : view.status === "loading" ? (
        <SettingsRow title="Loading scheduled tasks…" />
      ) : view.tasks.length === 0 ? (
        <SettingsRow
          description="Run a prompt automatically — on an interval, at a fixed time, or when a webhook is called."
          title="No scheduled tasks"
        />
      ) : (
        view.tasks.map((task) => (
          <TaskRow connection={node.id} key={task.id} onEdit={() => onEdit(task)} task={task} />
        ))
      )}
    </SettingsSection>
  );
}

function TaskRow(props: { connection: string; task: ScheduledTask; onEdit(): void }) {
  const { connection, task, onEdit } = props;
  const call = useCall();
  const report = useReportFailure();
  const [busy, setBusy] = useState(false);
  const [deliveriesOpen, setDeliveriesOpen] = useState(false);
  const isWebhook = task.schedule.type === "webhook";
  const act = async (action: "toggle" | "run" | "delete") => {
    if (busy) return;
    setBusy(true);
    try {
      if (action === "toggle") {
        await call(connection, "scheduler.tasks.update", { id: task.id, enabled: !task.enabled });
      } else if (action === "run") {
        await call(connection, "scheduler.tasks.run", { id: task.id });
      } else {
        await call(connection, "scheduler.tasks.delete", { id: task.id });
      }
    } catch (error) {
      report("Could not update scheduled task", error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      control={
        <div className="flex items-center gap-2">
          <Switch
            aria-label={`Enable ${task.title}`}
            checked={task.enabled}
            disabled={busy}
            onCheckedChange={() => void act("toggle")}
          />
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label={`Actions for ${task.title}`}
                  disabled={busy}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <MoreHorizontalIcon className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end">
              <Slot
                name={TASK_ACTIONS_SLOT}
                props={
                  {
                    connection,
                    task,
                    edit: onEdit,
                    openDeliveries: () => setDeliveriesOpen(true),
                    run: () => void act("run"),
                    remove: () => void act("delete"),
                  } satisfies TaskActionProps
                }
              />
            </MenuPopup>
          </Menu>
          {deliveriesOpen ? (
            <DeliveriesDialog
              connection={connection}
              onClose={() => setDeliveriesOpen(false)}
              task={task}
            />
          ) : null}
        </div>
      }
      description={<span className="line-clamp-2">{task.prompt}</span>}
      status={
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {scheduleLabel(task.schedule)} ·{" "}
            {!task.enabled ? (
              "Paused"
            ) : isWebhook ? (
              "Listening"
            ) : task.nextRunAt ? (
              <>
                Next run <RelativeLabel value={task.nextRunAt} />
              </>
            ) : (
              "Not scheduled"
            )}
          </span>
          {task.lastRunStatus !== "never" ? (
            <Badge variant={statusVariant(task.lastRunStatus)}>{task.lastRunStatus}</Badge>
          ) : null}
          {task.lastRunError ? <span className="text-destructive">{task.lastRunError}</span> : null}
        </div>
      }
      title={task.title}
    />
  );
}

function DeliveryBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label>{title}</Label>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs break-all whitespace-pre-wrap">
        {children}
      </pre>
    </div>
  );
}

function DeliveriesDialog(props: { connection: string; task: ScheduledTask; onClose(): void }) {
  const { connection, task, onClose } = props;
  const call = useCall();
  const [deliveries, setDeliveries] = useState<readonly DeliverySummary[] | null>(null);
  const [selected, setSelected] = useState<Delivery | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Only the latest list and the latest detail count, and none after the dialog closed.
  const requests = useRef({ list: 0, detail: 0, open: true });
  useEffect(() => {
    const current = requests.current;
    current.open = true;
    return () => {
      current.open = false;
    };
  }, []);
  const refresh = () => {
    const request = ++requests.current.list;
    const latest = () => requests.current.open && requests.current.list === request;
    setLoading(true);
    setError(null);
    call<{ deliveries: DeliverySummary[] }>(connection, "scheduler.deliveries.list", {
      id: task.id,
    })
      .then((result) => latest() && setDeliveries(result.deliveries))
      .catch((cause: unknown) => latest() && setError(messageOf(cause)))
      .finally(() => latest() && setLoading(false));
  };
  // The list is read once when the dialog opens; Refresh reads it again.
  useEffect(refresh, []);
  const select = (id: string | null) => {
    const request = ++requests.current.detail;
    setSelectedId(id);
    setSelected(null);
    setError(null);
    if (id === null) return;
    const latest = () => requests.current.open && requests.current.detail === request;
    call<Delivery>(connection, "scheduler.deliveries.get", { id: task.id, deliveryId: id })
      .then((delivery) => latest() && setSelected(delivery))
      .catch((cause: unknown) => latest() && setError(messageOf(cause)));
  };
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Deliveries · {task.title}</DialogTitle>
          <DialogDescription>Recent requests to this task's webhook URL.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {selectedId !== null && selected === null && error === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              Loading delivery…
            </p>
          ) : selected ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant={deliveryOutcomeVariant(selected.outcome)}>
                  {DELIVERY_OUTCOME_LABELS[selected.outcome]}
                </Badge>
                <span>
                  {selected.method} · <RelativeLabel value={selected.receivedAt} />
                </span>
                {selected.signatureVerified ? (
                  <span className="text-muted-foreground">Signature verified</span>
                ) : null}
              </div>
              {selected.error ? <p className="text-sm text-destructive">{selected.error}</p> : null}
              <DeliveryBlock title="Prompt sent to the agent">
                {selected.renderedPrompt ?? "No run was started for this request."}
              </DeliveryBlock>
              {selected.missingFields.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  Empty placeholders: {selected.missingFields.join(", ")}
                </p>
              ) : null}
              <DeliveryBlock title="Headers">
                {Object.entries(selected.headers)
                  .map(([name, value]) => `${name}: ${value}`)
                  .join("\n")}
              </DeliveryBlock>
              {selected.query ? (
                <DeliveryBlock title="Query">{selected.query}</DeliveryBlock>
              ) : null}
              <DeliveryBlock title={selected.bodyTruncated ? "Body (truncated)" : "Body"}>
                {selected.body || "(empty)"}
              </DeliveryBlock>
            </div>
          ) : selectedId !== null ? null : deliveries === null ? (
            // A failed read shows its error above, not a load that never ends.
            error === null ? (
              <p className="text-sm text-muted-foreground" role="status">
                Loading deliveries…
              </p>
            ) : null
          ) : deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">No requests yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {deliveries.map((delivery) => (
                <li key={delivery.id}>
                  <button
                    className="flex w-full flex-wrap items-center gap-2 py-2 text-left text-sm hover:bg-accent/40"
                    onClick={() => select(delivery.id)}
                    type="button"
                  >
                    <Badge variant={deliveryOutcomeVariant(delivery.outcome)}>
                      {DELIVERY_OUTCOME_LABELS[delivery.outcome]}
                    </Badge>
                    <span>{delivery.method}</span>
                    <span className="text-muted-foreground">
                      <RelativeLabel value={delivery.receivedAt} />
                    </span>
                    {delivery.missingFields.length > 0 ? (
                      <span className="text-muted-foreground">
                        {delivery.missingFields.length} empty placeholder
                        {delivery.missingFields.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
        <DialogFooter>
          {selectedId !== null ? (
            <Button onClick={() => select(null)} size="sm" variant="outline">
              Back
            </Button>
          ) : (
            <Button disabled={loading} onClick={refresh} size="sm" variant="outline">
              Refresh
            </Button>
          )}
          <DialogClose render={<Button size="sm" />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Field(props: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={props.htmlFor}>
        <span>{props.label}</span>
        {props.hint ? (
          <span className="text-2xs font-normal text-muted-foreground/80">{props.hint}</span>
        ) : null}
      </Label>
      {props.children}
    </div>
  );
}

function WebhookEndpointField(props: {
  connection: string;
  task: ScheduledTask | null;
  /** The URL is being read again, or could not be: shown as such, not as a lack of rights. */
  urlState: "loading" | "failed" | undefined;
}) {
  const { connection, task, urlState } = props;
  const { dialogs } = useServices();
  const call = useCall();
  const report = useReportFailure();
  const { copied, copy } = useCopy();
  const [rotating, setRotating] = useState(false);
  const endpoint = task?.webhook;
  if (!task || !endpoint) {
    return <p className="text-sm text-muted-foreground">The URL appears after you save.</p>;
  }
  const url = endpoint.url ?? endpoint.path ?? "";
  const rotate = async () => {
    // Without the dialogs service there is nothing to ask with: the button is disabled.
    if (dialogs === undefined) return;
    const confirmed = await dialogs.confirm({
      title: "Rotate this webhook URL?",
      description: "The current URL stops working.",
      confirmLabel: "Rotate",
      variant: "destructive",
    });
    if (!confirmed) return;
    setRotating(true);
    try {
      await call(connection, "scheduler.webhooks.rotate", { id: task.id });
    } catch (error) {
      report("Could not rotate webhook URL", error);
    } finally {
      setRotating(false);
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Webhook URL"
          onFocus={(event) => event.currentTarget.select()}
          readOnly
          value={url}
        />
        <Button
          disabled={url === ""}
          onClick={() => copy(url)}
          size="sm"
          type="button"
          variant="outline"
        >
          <CopyIcon />
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          disabled={rotating || dialogs === undefined}
          onClick={() => void rotate()}
          title={
            dialogs === undefined ? "Rotating asks first; no dialogs plugin is loaded." : undefined
          }
          size="sm"
          type="button"
          variant="outline"
        >
          Rotate
        </Button>
      </div>
      {endpoint.path === null && urlState === "loading" ? (
        <p className="text-xs text-muted-foreground">Loading this task's URL…</p>
      ) : endpoint.path === null && urlState === "failed" ? (
        <p className="text-xs text-destructive">
          Could not load this task's URL. It shows again once the task is read.
        </p>
      ) : endpoint.path === null ? (
        <p className="text-xs text-muted-foreground">
          Only a token that may change scheduled tasks sees this task's URL.
        </p>
      ) : endpoint.url === null ? (
        <p className="text-xs text-muted-foreground">
          This node serves no HTTP URL; requests go to this path on it.
        </p>
      ) : null}
    </div>
  );
}

const NEW_THREAD = "__new__";

function EditorDialog(props: {
  initialConnection: string;
  task: ScheduledTask | null;
  onClose(): void;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
      open
    >
      {/* The form owns the draft so a keystroke re-renders it, not the dialog chrome. */}
      <DialogPopup className="max-w-xl">
        <EditorForm {...props} onSavingChange={setSaving} saving={saving} />
      </DialogPopup>
    </Dialog>
  );
}

function EditorForm(props: {
  initialConnection: string;
  task: ScheduledTask | null;
  saving: boolean;
  onSavingChange(saving: boolean): void;
  onClose(): void;
}) {
  const { task, saving, onSavingChange: setSaving, onClose } = props;
  const { connections, threads, store } = useServices();
  const call = useCall();
  const report = useReportFailure();
  const nodes = useExternal(connections, connections.list);
  // Only nodes that have a scheduler can take a task.
  const withScheduler = useNodesWithScheduler(
    store,
    nodes.filter((node) => node.state === "open").map((node) => node.id),
  );
  const openNodes = nodes.filter((node) => withScheduler.includes(node.id));
  const [connection, setConnection] = useState(props.initialConnection);
  const node = nodes.find((entry) => entry.id === connection);
  const connected = node?.state === "open";
  const view = useSchedulerView(store, connection);
  const catalog = useCatalog(threads, { node: connection });
  const projects = catalog?.projects ?? [];
  const [draft, setDraft] = useState<DraftState>(() =>
    task ? taskToDraft(task) : { ...EMPTY_DRAFT, projectId: projects[0]?.id ?? "" },
  );
  const liveTask =
    draft.editingId === null
      ? null
      : (view.tasks.find((entry) => entry.id === draft.editingId) ?? task);
  const editingTaskMissing =
    draft.editingId !== null &&
    view.status === "ready" &&
    !view.tasks.some((entry) => entry.id === draft.editingId);
  const selectedProjectId = draft.projectId || projects[0]?.id || "";
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const projectThreads = (catalog?.threads ?? []).filter(
    (thread) => thread.projectId === selectedProjectId && thread.archivedAt === undefined,
  );
  const selectedThread = projectThreads.find((thread) => thread.id === draft.threadId);
  const hasSecret = liveTask?.schedule.type === "webhook" && liveTask.webhook?.hasSecret === true;

  const submit = async () => {
    if (saving || editingTaskMissing || !connected) return;
    const problem = draftProblem(draft, {
      hasProject: selectedProject !== undefined,
      hasSecret,
    });
    if (problem !== null) {
      report(problem.title, problem.description);
      return;
    }
    const schedule = scheduleFromDraft(draft);
    const common = {
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      enabled: draft.enabled,
      schedule,
      threadId: draft.threadId || null,
    };
    setSaving(true);
    try {
      if (draft.editingId === null) {
        await call(connection, "scheduler.tasks.create", {
          ...common,
          projectId: selectedProjectId,
        });
      } else {
        await call(connection, "scheduler.tasks.update", { id: draft.editingId, ...common });
      }
    } catch (error) {
      setSaving(false);
      report("Could not save scheduled task", error);
      return;
    }
    setSaving(false);
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{draft.editingId ? "Edit task" : "New task"}</DialogTitle>
        <DialogDescription>
          Run a prompt automatically — on an interval, at a fixed time, or when a webhook is called.
        </DialogDescription>
      </DialogHeader>

      <DialogPanel>
        <fieldset className="space-y-5" disabled={saving}>
          {!connected ? (
            <p className="text-sm text-destructive">Reconnect this node before saving.</p>
          ) : null}
          {openNodes.length > 1 ? (
            <Field htmlFor="scheduled-task-node" label="Runs on">
              <Select
                disabled={task !== null || saving}
                onValueChange={(id) => {
                  if (typeof id !== "string") return;
                  setConnection(id);
                  setDraft((current) => ({ ...current, projectId: "", threadId: "" }));
                }}
                value={connection}
              >
                <SelectTrigger id="scheduled-task-node" size="sm">
                  <SelectValue>{node?.label ?? "Unavailable node"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {openNodes.map((entry) => (
                    <SelectItem key={entry.id} label={entry.label} value={entry.id}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          ) : null}
          {editingTaskMissing ? (
            <p className="text-xs text-destructive" role="status">
              This scheduled task no longer exists.
            </p>
          ) : null}
          <Field htmlFor="scheduled-task-title" label="Name">
            <Input
              id="scheduled-task-title"
              onChange={(event) =>
                setDraft((current) => ({ ...current, title: event.target.value }))
              }
              placeholder="e.g. Check for Sentry issues"
              value={draft.title}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field htmlFor="scheduled-task-project" label="Project">
              <Select
                disabled={draft.editingId !== null}
                onValueChange={(projectId) =>
                  setDraft((current) => ({
                    ...current,
                    projectId: typeof projectId === "string" ? projectId : "",
                    threadId: "",
                  }))
                }
                value={selectedProjectId}
              >
                <SelectTrigger id="scheduled-task-project" size="sm">
                  <SelectValue placeholder="Select a project">{selectedProject?.name}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => (
                    <SelectItem key={project.id} label={project.name} value={project.id}>
                      <span className="block truncate">{project.name}</span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field htmlFor="scheduled-task-thread" label="Runs in">
              <Select
                onValueChange={(threadId) =>
                  setDraft((current) => ({
                    ...current,
                    threadId:
                      typeof threadId === "string" && threadId !== NEW_THREAD ? threadId : "",
                  }))
                }
                value={draft.threadId || NEW_THREAD}
              >
                <SelectTrigger id="scheduled-task-thread" size="sm">
                  <SelectValue>
                    {draft.threadId === ""
                      ? "A new thread each run"
                      : (selectedThread?.title ?? "Unavailable thread")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem label="A new thread each run" value={NEW_THREAD}>
                    A new thread each run
                  </SelectItem>
                  {/* A bound thread not listed (loading, archived) stays a choice, so the value matches. */}
                  {draft.threadId !== "" && selectedThread === undefined ? (
                    <SelectItem label="Unavailable thread" value={draft.threadId}>
                      Unavailable thread
                    </SelectItem>
                  ) : null}
                  {projectThreads.map((thread) => (
                    <SelectItem key={thread.id} label={thread.title} value={thread.id}>
                      <span className="block truncate">{thread.title}</span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          </div>

          <Field htmlFor="scheduled-task-prompt" label="Prompt">
            <Textarea
              className="max-h-64 overflow-y-auto"
              id="scheduled-task-prompt"
              onChange={(event) =>
                setDraft((current) => ({ ...current, prompt: event.target.value }))
              }
              placeholder="What should the agent do each time this runs?"
              value={draft.prompt}
            />
          </Field>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <Label>Schedule</Label>
              <ToggleGroup
                aria-label="Schedule type"
                onValueChange={(values) => {
                  const mode = values[0] as ScheduleMode | undefined;
                  if (mode === "fixed" || mode === "interval" || mode === "webhook")
                    setDraft((current) => ({
                      ...current,
                      scheduleMode: mode,
                      prompt:
                        mode === "webhook" && !current.prompt.trim()
                          ? DEFAULT_WEBHOOK_PROMPT
                          : current.prompt,
                    }));
                }}
                value={[draft.scheduleMode]}
              >
                <ToggleGroupItem value="fixed">At a time</ToggleGroupItem>
                <ToggleGroupItem value="interval">Every interval</ToggleGroupItem>
                <ToggleGroupItem value="webhook">On webhook</ToggleGroupItem>
              </ToggleGroup>
            </div>

            {draft.scheduleMode === "webhook" ? (
              <div className="space-y-4">
                <WebhookEndpointField
                  connection={connection}
                  task={liveTask}
                  urlState={liveTask === null ? undefined : view.urls?.get(liveTask.id)}
                />
                <p className="text-xs text-muted-foreground">
                  {
                    "Each request runs the prompt. Use {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} or {{request}} in the prompt; only what it names reaches the agent."
                  }
                </p>
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor="scheduled-task-signature">Require signature</Label>
                    <p className="text-sm text-muted-foreground">
                      Reject requests without a valid HMAC-SHA256 signature of the body.
                    </p>
                  </div>
                  <Switch
                    checked={draft.signatureEnabled}
                    id="scheduled-task-signature"
                    onCheckedChange={(signatureEnabled) =>
                      setDraft((current) => ({ ...current, signatureEnabled }))
                    }
                  />
                </div>
                {draft.signatureEnabled ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field htmlFor="scheduled-task-signature-header" label="Header">
                      <Input
                        id="scheduled-task-signature-header"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            signatureHeader: event.target.value,
                          }))
                        }
                        value={draft.signatureHeader}
                      />
                    </Field>
                    <Field htmlFor="scheduled-task-signature-prefix" label="Prefix">
                      <Input
                        id="scheduled-task-signature-prefix"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            signaturePrefix: event.target.value,
                          }))
                        }
                        placeholder="None"
                        value={draft.signaturePrefix}
                      />
                    </Field>
                    <Field htmlFor="scheduled-task-signature-encoding" label="Encoding">
                      <Select
                        onValueChange={(value) =>
                          setDraft((current) => ({
                            ...current,
                            signatureEncoding: value === "base64" ? "base64" : "hex",
                          }))
                        }
                        value={draft.signatureEncoding}
                      >
                        <SelectTrigger id="scheduled-task-signature-encoding" size="sm">
                          <SelectValue>{draft.signatureEncoding}</SelectValue>
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value="hex">hex</SelectItem>
                          <SelectItem value="base64">base64</SelectItem>
                        </SelectPopup>
                      </Select>
                    </Field>
                    <Field htmlFor="scheduled-task-signature-secret" label="Secret">
                      <Input
                        autoComplete="off"
                        id="scheduled-task-signature-secret"
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            signatureSecret: event.target.value,
                          }))
                        }
                        placeholder={hasSecret ? "Unchanged" : "Shared secret"}
                        type="password"
                        value={draft.signatureSecret}
                      />
                    </Field>
                  </div>
                ) : null}
              </div>
            ) : draft.scheduleMode === "fixed" ? (
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor="scheduled-task-time">Run at</Label>
                  <Input
                    className="w-32"
                    id="scheduled-task-time"
                    nativeInput
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, timeOfDay: event.target.value }))
                    }
                    type="time"
                    value={draft.timeOfDay}
                  />
                  <span className="text-xs text-muted-foreground">on</span>
                </div>
                <ToggleGroup
                  aria-label="Days to run"
                  multiple
                  onValueChange={(values) => {
                    if (values.length === 0) return;
                    setDraft((current) => ({
                      ...current,
                      weekdays: new Set(values.map(Number)),
                    }));
                  }}
                  size="sm"
                  value={[...draft.weekdays].map(String)}
                  variant="outline"
                >
                  {WEEKDAY_ORDER.map((day) => (
                    <ToggleGroupItem aria-label={WEEKDAY_LABELS[day]} key={day} value={String(day)}>
                      {WEEKDAY_SHORT[day]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Label htmlFor="scheduled-task-interval">Run every</Label>
                <Input
                  className="w-24"
                  id="scheduled-task-interval"
                  min={1}
                  nativeInput
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, intervalMinutes: event.target.value }))
                  }
                  step="any"
                  type="number"
                  value={draft.intervalMinutes}
                />
                <span className="text-xs text-muted-foreground">minutes</span>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="scheduled-task-enabled">Enabled</Label>
              <p className="text-sm text-muted-foreground" id="scheduled-task-enabled-description">
                Disabled tasks stay saved but do not run.
              </p>
            </div>
            <Switch
              aria-describedby="scheduled-task-enabled-description"
              checked={draft.enabled}
              id="scheduled-task-enabled"
              onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
            />
          </div>
        </fieldset>
      </DialogPanel>

      <DialogFooter>
        <DialogClose render={<Button disabled={saving} size="sm" variant="outline" />}>
          Cancel
        </DialogClose>
        <Button
          disabled={saving || editingTaskMissing || !connected}
          onClick={() => void submit()}
          size="sm"
        >
          {draft.editingId ? "Save task" : "Create task"}
        </Button>
      </DialogFooter>
    </>
  );
}
