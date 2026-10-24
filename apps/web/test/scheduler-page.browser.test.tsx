// Settings → Scheduled tasks over fake node connections (docs/plans/orchestration.md, D1514):
// the webhook's signature and write-only secret, Rotate, the Deliveries dialog, the tasks of
// several nodes, a node without the scheduler, and an edit that keeps the model options (D1178).
import type {
  AgentInfo,
  Connections,
  NodeCatalog,
  NodeConnection,
  ThreadsCatalog,
} from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import {
  SCHEDULER_STREAM,
  SchedulerEvents,
  type Delivery,
  type ScheduledTask,
  type UpdateTaskInput,
} from "@jhin/scheduler-api";
import { toDisposable } from "@jhin/sdk";
import {
  SlotsProvider,
  createSlotRegistry,
  type ConfirmOptions,
  type Dialogs,
  type ToastOptions,
  type Toasts,
} from "@jhin/ui";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

import { TASK_ACTIONS_SLOT, taskActions } from "../src/plugins/scheduler/actions.tsx";
import {
  ScheduledTasksSection,
  SchedulerProvider,
  createSchedulerStore,
} from "../src/plugins/scheduler/page.tsx";

const NOW = new Date().toISOString();

function task(id: string, fields: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    title: id,
    prompt: `Prompt of ${id}`,
    enabled: true,
    schedule: { type: "interval", everyMs: 15 * 60_000 },
    projectId: "p1",
    threadId: null,
    createdAt: NOW,
    updatedAt: NOW,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    lastRunThreadId: null,
    runCount: 0,
    ...fields,
  };
}

/** A webhook task as `scheduler.tasks.list` gives it to a caller that may change tasks. */
function webhookTask(id: string, hasSecret: boolean): ScheduledTask {
  return task(id, {
    prompt: "Handle this webhook:\n{{body}}",
    schedule: {
      type: "webhook",
      signature: hasSecret
        ? { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" }
        : null,
    },
    webhook: { path: `/api/hooks/${id}/t1`, url: `http://node/api/hooks/${id}/t1`, hasSecret },
  });
}

interface Call {
  readonly method: string;
  readonly params: unknown;
}

/**
 * One node's scheduler as its commands and stream show it: an update or a
 * rotation is told on the stream without the URL, as the node does, so the
 * page reads the task again for it.
 */
function fakeNode(
  id: string,
  label: string,
  options: {
    tasks?: ScheduledTask[];
    scheduler?: boolean;
    agents?: AgentInfo[];
    deliveries?: Delivery[];
  } = {},
) {
  const tasks = new Map((options.tasks ?? []).map((item) => [item.id, item]));
  const tokens = new Map<string, number>();
  const calls: Call[] = [];
  const waiters: { method: string; resolve(params: unknown): void }[] = [];
  const streams = new Set<(event: { type: string; payload: unknown }) => void>();
  const withUrl = (item: ScheduledTask): ScheduledTask => {
    if (item.webhook === undefined) return item;
    const path = `/api/hooks/${item.id}/t${tokens.get(item.id) ?? 1}`;
    return { ...item, webhook: { ...item.webhook, path, url: `http://${label}${path}` } };
  };
  const changed = (item: ScheduledTask) => {
    tasks.set(item.id, item);
    const told =
      item.webhook === undefined
        ? item
        : { ...item, webhook: { ...item.webhook, path: null, url: null } };
    for (const listener of Array.from(streams)) {
      listener({ type: SchedulerEvents.taskUpdated, payload: told });
    }
    return withUrl(item);
  };
  const answer = async (method: string, params: unknown): Promise<unknown> => {
    if (method === "scheduler.tasks.list") {
      if (options.scheduler === false) {
        throw Object.assign(new Error("Unknown command scheduler.tasks.list"), {
          code: "COMMAND_NOT_FOUND",
        });
      }
      return { tasks: [...tasks.values()].map(withUrl), head: 0 };
    }
    if (method === "scheduler.tasks.get") {
      return withUrl(tasks.get((params as { id: string }).id)!);
    }
    if (method === "scheduler.tasks.update") {
      const input = params as UpdateTaskInput;
      const known = tasks.get(input.id)!;
      const { id: _id, schedule, agentId, model, modelOptions, ...rest } = input;
      let next: ScheduledTask = { ...known, ...(rest as Partial<ScheduledTask>) };
      if (schedule !== undefined) {
        if (schedule.type === "webhook") {
          const signature = schedule.signature ?? null;
          next = {
            ...next,
            schedule: {
              type: "webhook",
              signature:
                signature === null
                  ? null
                  : {
                      header: signature.header,
                      encoding: signature.encoding,
                      prefix: signature.prefix,
                    },
            },
            webhook: {
              path: null,
              url: null,
              // An empty secret keeps the one stored; no signature drops it.
              hasSecret:
                signature === null
                  ? false
                  : signature.secret !== undefined || known.webhook?.hasSecret === true,
            },
          };
        } else {
          next = { ...next, schedule };
        }
      }
      // The node's rule (D1178): another model drops the options, the same keeps them.
      const otherModel =
        (agentId !== undefined && agentId !== known.agentId) ||
        (model !== undefined && model !== known.model);
      if (agentId === null) delete next.agentId;
      else if (agentId !== undefined) next.agentId = agentId;
      if (model === null) delete next.model;
      else if (model !== undefined) next.model = model;
      if (modelOptions === null || (otherModel && modelOptions === undefined)) {
        delete next.modelOptions;
      } else if (modelOptions !== undefined) next.modelOptions = modelOptions;
      return changed(next);
    }
    if (method === "scheduler.webhooks.rotate") {
      const taskId = (params as { id: string }).id;
      tokens.set(taskId, (tokens.get(taskId) ?? 1) + 1);
      return changed({ ...tasks.get(taskId)! });
    }
    if (method === "scheduler.deliveries.list") {
      return {
        deliveries: (options.deliveries ?? []).map(
          ({
            query: _q,
            headers: _h,
            body: _b,
            bodyTruncated: _t,
            renderedPrompt: _p,
            ...summary
          }) => summary,
        ),
      };
    }
    if (method === "scheduler.deliveries.get") {
      const { deliveryId } = params as { deliveryId: string };
      return options.deliveries?.find((delivery) => delivery.id === deliveryId);
    }
    if (method === "agents.list") return options.agents ?? [];
    throw new Error(`unexpected ${method}`);
  };
  const client = {
    state: "open",
    call(method: string, params: unknown) {
      calls.push({ method, params });
      for (const waiter of waiters.filter((entry) => entry.method === method)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(params);
      }
      return answer(method, params);
    },
    subscribe(
      stream: string,
      _options: unknown,
      onEvent: (event: { type: string; payload: unknown }) => void,
    ) {
      if (stream !== SCHEDULER_STREAM) throw new Error(`unexpected stream ${stream}`);
      streams.add(onEvent);
      return toDisposable(() => streams.delete(onEvent));
    },
  } as unknown as RpcClient;
  return {
    connection: { id, url: id, label, state: "open", client } as NodeConnection,
    calls,
    tasks,
    /** The params of the next call of `method`. */
    next: (method: string) => new Promise<unknown>((resolve) => waiters.push({ method, resolve })),
  };
}

type FakeNode = ReturnType<typeof fakeNode>;

const CATALOG: NodeCatalog = {
  status: "ready",
  projects: [{ id: "p1", name: "Jhin" } as NodeCatalog["projects"][number]],
  threads: [],
};

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
});

/** Renders the page over `nodes`, with the dialogs answering `confirm`. */
async function render(nodes: readonly FakeNode[], confirm = true) {
  // The same list every time, as a snapshot of the connections.
  const list = nodes.map((node) => node.connection);
  const connections: Connections = {
    list: () => list,
    get: (id) => nodes.find((node) => node.connection.id === id)?.connection,
    add: () => {
      throw new Error("not used");
    },
    remove: () => undefined,
    subscribe: () => toDisposable(() => undefined),
  };
  const threads = {
    catalog: () => CATALOG,
    subscribe: () => toDisposable(() => undefined),
  } as unknown as ThreadsCatalog;
  const toasts: ToastOptions[] = [];
  const toastService: Toasts = {
    show: (toast) => {
      toasts.push(toast);
      return String(toasts.length);
    },
    update: () => undefined,
    close: () => undefined,
  };
  const asked: ConfirmOptions[] = [];
  let answered = Promise.withResolvers<void>();
  const dialogs = {
    confirm: async (options: ConfirmOptions) => {
      asked.push(options);
      answered.resolve();
      answered = Promise.withResolvers<void>();
      return confirm;
    },
  } as unknown as Dialogs;
  const slots = createSlotRegistry();
  for (const [id, order, component] of taskActions) {
    slots.contribute(TASK_ACTIONS_SLOT, { id: `jhin.scheduler.${id}`, order, component });
  }
  const store = createSchedulerStore(connections, { warn: () => undefined });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <SlotsProvider registry={slots}>
        <SchedulerProvider
          services={{ store, connections, threads, toasts: toastService, dialogs }}
        >
          <ScheduledTasksSection />
        </SchedulerProvider>
      </SlotsProvider>,
    ),
  );
  unmount = async () => {
    await act(async () => root.unmount());
    store.dispose();
    host.remove();
  };
  /** Resolves once the next confirmation was asked. */
  const nextConfirm = () => answered.promise;
  return { toasts, asked, nextConfirm };
}

// Clicked in the DOM inside a dialog: without the app's styles its backdrop is not stacked under it.
const click = (locator: Locator) => act(async () => (locator.element() as HTMLElement).click());

/** Opens a task's actions menu and chooses `action`. */
async function choose(title: string, action: string) {
  await userEvent.click(page.getByRole("button", { name: `Actions for ${title}` }));
  await userEvent.click(page.getByRole("menuitem", { name: action }));
}

describe("Settings → Scheduled tasks (D1514)", () => {
  it("shows a webhook's signature, and a save that leaves the secret empty keeps it", async () => {
    const node = fakeNode("ws://a/rpc", "a", { tasks: [webhookTask("Hook", true)] });
    await render([node]);
    await choose("Hook", "Edit");
    const dialog = page.getByRole("dialog", { name: "Edit task" });
    await expect.element(dialog.getByRole("switch", { name: "Require signature" })).toBeChecked();
    await expect
      .element(dialog.getByRole("textbox", { name: "Header" }))
      .toHaveValue("x-hub-signature-256");
    await expect.element(dialog.getByRole("textbox", { name: "Prefix" })).toHaveValue("sha256=");
    // Write-only: the node never gives the secret back, the field says it stays.
    const secret = dialog.getByLabelText("Secret");
    await expect.element(secret).toHaveValue("");
    await expect.element(secret).toHaveAttribute("placeholder", "Unchanged");
    await expect
      .element(dialog.getByRole("textbox", { name: "Webhook URL" }))
      .toHaveValue("http://a/api/hooks/Hook/t1");

    const saved = node.next("scheduler.tasks.update");
    await click(dialog.getByRole("button", { name: "Save task" }));
    const update = (await saved) as UpdateTaskInput;
    expect(update.schedule).toEqual({
      type: "webhook",
      signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
    });
    await expect.element(dialog).not.toBeInTheDocument();
    expect(node.tasks.get("Hook")?.webhook?.hasSecret).toBe(true);

    // Opened again, the secret is still kept on the node; one typed in is sent.
    await choose("Hook", "Edit");
    await expect
      .element(page.getByRole("dialog", { name: "Edit task" }).getByLabelText("Secret"))
      .toHaveAttribute("placeholder", "Unchanged");
    await userEvent.fill(
      page.getByRole("dialog", { name: "Edit task" }).getByLabelText("Secret"),
      "s3cret",
    );
    const resaved = node.next("scheduler.tasks.update");
    await click(page.getByRole("button", { name: "Save task" }));
    expect(((await resaved) as UpdateTaskInput).schedule).toMatchObject({
      signature: { secret: "s3cret" },
    });
  });

  it("refuses a signature without a secret on a task that has none", async () => {
    const node = fakeNode("ws://a/rpc", "a", { tasks: [webhookTask("Hook", false)] });
    const { toasts } = await render([node]);
    await choose("Hook", "Edit");
    const dialog = page.getByRole("dialog", { name: "Edit task" });
    await click(dialog.getByRole("switch", { name: "Require signature" }));
    await expect
      .element(dialog.getByLabelText("Secret"))
      .toHaveAttribute("placeholder", "Shared secret");
    await click(dialog.getByRole("button", { name: "Save task" }));
    expect(toasts).toEqual([
      {
        type: "error",
        title: "Signing secret is required",
        description: "Enter the signature header and secret.",
      },
    ]);
    expect(node.calls.some((call) => call.method === "scheduler.tasks.update")).toBe(false);
  });

  it("rotates the URL only once confirmed, and shows the new one", async () => {
    const declined = fakeNode("ws://a/rpc", "a", { tasks: [webhookTask("Hook", false)] });
    const no = await render([declined], false);
    await choose("Hook", "Edit");
    const confirmed = no.nextConfirm();
    await click(page.getByRole("button", { name: "Rotate" }));
    await confirmed;
    expect(no.asked).toHaveLength(1);
    expect(no.asked[0]).toMatchObject({
      title: "Rotate this webhook URL?",
      description: "The current URL stops working.",
      confirmLabel: "Rotate",
      variant: "destructive",
    });
    await expect.element(page.getByRole("button", { name: "Rotate" })).toBeEnabled();
    expect(declined.calls.some((call) => call.method === "scheduler.webhooks.rotate")).toBe(false);
    await unmount?.();
    unmount = undefined;

    const node = fakeNode("ws://a/rpc", "a", { tasks: [webhookTask("Hook", false)] });
    const yes = await render([node], true);
    await choose("Hook", "Edit");
    const url = page.getByRole("textbox", { name: "Webhook URL" });
    await expect.element(url).toHaveValue("http://a/api/hooks/Hook/t1");
    const rotated = node.next("scheduler.webhooks.rotate");
    await click(page.getByRole("button", { name: "Rotate" }));
    expect(await rotated).toEqual({ id: "Hook" });
    expect(yes.asked.map((options) => options.title)).toEqual(["Rotate this webhook URL?"]);
    // The stream tells the task without its URL; it is read again for the new one.
    await expect.element(url).toHaveValue("http://a/api/hooks/Hook/t2");
  });

  it("lists a webhook's deliveries and opens one with its prompt, headers and body", async () => {
    const delivery: Delivery = {
      id: "d1",
      taskId: "Hook",
      receivedAt: NOW,
      method: "POST",
      contentType: "application/json",
      bodyBytes: 17,
      outcome: "accepted",
      signatureVerified: true,
      missingFields: ["body.ref"],
      error: null,
      query: "",
      headers: { "content-type": "application/json", "x-github-event": "push" },
      body: '{"action":"push"}',
      bodyTruncated: false,
      renderedPrompt: 'Handle this webhook:\n{"action":"push"}',
    };
    const node = fakeNode("ws://a/rpc", "a", {
      tasks: [webhookTask("Hook", true)],
      deliveries: [delivery],
    });
    await render([node]);
    // A webhook task has Deliveries where a timed one has Run now.
    await userEvent.click(page.getByRole("button", { name: "Actions for Hook" }));
    await expect.element(page.getByRole("menuitem", { name: "Run now" })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("menuitem", { name: "Deliveries" }));
    const dialog = page.getByRole("dialog", { name: "Deliveries · Hook" });
    const row = dialog.getByRole("button", { name: /Ran\s*POST/ });
    await expect.element(row.getByText("1 empty placeholder")).toBeVisible();
    expect(node.calls.find((call) => call.method === "scheduler.deliveries.list")?.params).toEqual({
      id: "Hook",
    });

    await click(row);
    await expect.element(dialog.getByText("Signature verified")).toBeVisible();
    expect(node.calls.find((call) => call.method === "scheduler.deliveries.get")?.params).toEqual({
      id: "Hook",
      deliveryId: "d1",
    });
    const block = (title: string) =>
      dialog.getByText(title, { exact: true }).element().nextElementSibling?.textContent;
    expect(block("Prompt sent to the agent")).toBe('Handle this webhook:\n{"action":"push"}');
    expect(block("Headers")).toBe("content-type: application/json\nx-github-event: push");
    expect(block("Body")).toBe('{"action":"push"}');
    await expect.element(dialog.getByText("Empty placeholders: body.ref")).toBeVisible();

    await click(dialog.getByRole("button", { name: "Back" }));
    await expect.element(dialog.getByRole("button", { name: /Ran\s*POST/ })).toBeVisible();
  });

  it("puts each node's tasks in its own section, and tells a node without the scheduler", async () => {
    const laptop = fakeNode("ws://laptop/rpc", "laptop", { tasks: [task("Nightly build")] });
    const server = fakeNode("ws://server/rpc", "server", { tasks: [task("Triage issues")] });
    const bare = fakeNode("ws://bare/rpc", "bare", { scheduler: false });
    await render([laptop, server, bare]);

    const first = page.getByRole("region", { name: "laptop" });
    const second = page.getByRole("region", { name: "server" });
    await expect.element(first.getByRole("heading", { name: "Nightly build" })).toBeVisible();
    await expect.element(second.getByRole("heading", { name: "Triage issues" })).toBeVisible();
    await expect
      .element(first.getByRole("heading", { name: "Triage issues" }))
      .not.toBeInTheDocument();
    await expect
      .element(second.getByRole("heading", { name: "Nightly build" }))
      .not.toBeInTheDocument();

    const none = page.getByRole("region", { name: "bare" });
    await expect
      .element(none.getByRole("heading", { name: "Scheduled tasks unavailable" }))
      .toBeVisible();
    await expect.element(none.getByText("bare has no scheduler plugin.")).toBeVisible();
    await expect.element(none.getByRole("button", { name: "New task" })).toBeDisabled();

    // A new task runs on a node with a scheduler only.
    await userEvent.click(second.getByRole("button", { name: "New task" }));
    const dialog = page.getByRole("dialog", { name: "New task" });
    const runsOn = dialog.getByRole("combobox", { name: "Runs on" });
    await expect.element(runsOn).toHaveTextContent("server");
    await click(runsOn);
    await expect.element(page.getByRole("option", { name: "laptop" })).toBeVisible();
    expect(
      page
        .getByRole("option")
        .elements()
        .map((option) => option.textContent),
    ).toEqual(["laptop", "server"]);
  });

  it("keeps the task's model options on a save that leaves its model (D1178)", async () => {
    const codex: AgentInfo = {
      agentId: "codex",
      name: "Codex",
      models: [
        { id: "gpt-5", name: "GPT-5" },
        { id: "gpt-5-mini", name: "GPT-5 mini" },
      ],
      runtimeModes: [],
      interactionModes: [],
      available: true,
      default: true,
    };
    const options = [{ id: "reasoningEffort", value: "high" }];
    const node = fakeNode("ws://a/rpc", "a", {
      agents: [codex],
      tasks: [task("Nightly", { agentId: "codex", model: "gpt-5", modelOptions: options })],
    });
    await render([node]);
    await choose("Nightly", "Edit");
    const dialog = page.getByRole("dialog", { name: "Edit task" });
    await expect
      .element(dialog.getByRole("combobox", { name: "Model" }))
      .toHaveTextContent("Codex · GPT-5");
    await userEvent.fill(dialog.getByRole("textbox", { name: "Name" }), "Nightly review");
    const saved = node.next("scheduler.tasks.update");
    await click(dialog.getByRole("button", { name: "Save task" }));
    const update = (await saved) as UpdateTaskInput;
    expect(update).toMatchObject({
      id: "Nightly",
      title: "Nightly review",
      agentId: "codex",
      model: "gpt-5",
    });
    // The editor has no picker for them: it never sends any, so the node keeps them.
    expect(update).not.toHaveProperty("modelOptions");
    await expect.element(dialog).not.toBeInTheDocument();
    expect(node.tasks.get("Nightly")?.modelOptions).toEqual(options);

    // Another model drops them (T3's baseModelSelection), on the node.
    await choose("Nightly review", "Edit");
    const again = page.getByRole("dialog", { name: "Edit task" });
    await click(again.getByRole("combobox", { name: "Model" }));
    const mini = page.getByRole("option", { name: "Codex · GPT-5 mini" });
    await expect.element(mini).toBeInTheDocument();
    await click(mini);
    const changed = node.next("scheduler.tasks.update");
    await click(again.getByRole("button", { name: "Save task" }));
    const second = (await changed) as UpdateTaskInput;
    expect(second).toMatchObject({ agentId: "codex", model: "gpt-5-mini" });
    expect(second).not.toHaveProperty("modelOptions");
    expect(node.tasks.get("Nightly")?.modelOptions).toBeUndefined();
  });
});
