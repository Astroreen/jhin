// The "N subagents" row in a turn (docs/plans/orchestration.md, D1161): the group shows at
// its first mark, the other marks show nothing.
import { OrchestrationThreadEvents, ThreadEvents } from "@jhin/agent-api";
import type {
  ChatTurnItemProps,
  NodeCatalog,
  NodeTarget,
  ThreadRecord,
  ThreadsCatalog,
} from "@jhin/client-api";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { DelegationStore, DelegationView } from "../src/plugins/orchestration/store.ts";
import { DelegatedWork, type DelegatedWorkServices } from "../src/plugins/orchestration/view.tsx";

const target: NodeTarget = { node: "n" };
const parent = { id: "p", projectId: "x", title: "parent", createdAt: "x" } as ThreadRecord;
const settled = (id: string, title: string): ThreadRecord => ({
  id,
  projectId: "x",
  title,
  createdAt: "2026-10-22T10:00:00.000Z",
  parentThreadId: "p",
  relationshipToParent: "subagent",
  subagentOrigin: "provider",
  lastTurn: { turnId: "u", status: "completed", at: "2026-10-22T10:00:04.000Z", agentId: "a" },
});
const catalog: NodeCatalog = {
  status: "ready",
  projects: [],
  threads: [parent, settled("c1", "north"), settled("c2", "south"), settled("c3", "east")],
} as unknown as NodeCatalog;
const view: DelegationView = {
  status: "ready",
  workflows: new Map(),
  tasks: new Map([
    [
      "t1",
      {
        taskId: "t1",
        parentThreadId: "p",
        childThreadId: "c4",
        title: "dig",
        agentId: "jhin.agent-fake",
        status: "running",
        createdAt: "2026-10-22T10:00:00.000Z",
        updatedAt: "2026-10-22T10:00:00.000Z",
      },
    ],
  ]),
};
const services: DelegatedWorkServices = {
  store: { view: () => view, watch: () => () => () => undefined } as unknown as DelegationStore,
  threads: {
    catalog: () => catalog,
    subscribe: () => ({ dispose: () => undefined }),
  } as unknown as ThreadsCatalog,
  open: () => undefined,
  toasts: undefined,
};

const mark = (sequence: number, childThreadId: string, title: string) => ({
  type: ThreadEvents.subagentStarted,
  payload: { turnId: "u", subagentId: `s${sequence}`, childThreadId, title },
  sequence,
  at: "2026-10-22T10:00:00.000Z",
});

describe("the N subagents row (D1161)", () => {
  it("folds a delegated task that runs with a runtime's subagent", async () => {
    const delegated = {
      type: OrchestrationThreadEvents.taskDelegated,
      payload: { taskId: "t1", childThreadId: "c4", title: "dig", agentId: "jhin.agent-fake" },
      sequence: 5,
      at: "2026-10-22T10:00:00.000Z",
    };
    const adjacent = [mark(4, "c1", "north"), delegated];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <>
          {adjacent.map((event) => (
            <DelegatedWork
              adjacent={adjacent}
              event={event}
              key={event.sequence}
              services={services}
              target={target}
              thread={parent}
              turnId="u"
            />
          ))}
        </>,
      ),
    );
    const group = page.getByRole("button", { name: "2 subagents" });
    await expect.element(group).toBeVisible();
    expect(group.element().textContent).toContain("1 working · 1 done");
    await userEvent.click(group);
    const dig = page.getByRole("button", { name: "Open dig", exact: true });
    await expect.element(dig).toBeVisible();
    expect(dig.element().textContent).toContain("Running");
    await act(async () => root.unmount());
    host.remove();
  });

  it("shows the group once, at its first mark, and unfolds into the members", async () => {
    const launched = {
      type: OrchestrationThreadEvents.threadLaunched,
      payload: { threadId: "side", title: "Side quest" },
      sequence: 9,
      at: "2026-10-22T10:00:00.000Z",
    };
    const adjacent = [mark(1, "c1", "north"), mark(2, "c2", "south"), mark(3, "c3", "east")];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const props = (event: ChatTurnItemProps["event"]) => ({
      target,
      thread: parent,
      turnId: "u",
      event,
      adjacent: [...adjacent, launched],
      services,
    });
    await act(async () =>
      root.render(
        <>
          {[...adjacent, launched].map((event) => (
            <div data-mark={event.sequence} key={event.sequence}>
              <DelegatedWork {...props(event)} />
            </div>
          ))}
        </>,
      ),
    );
    const group = page.getByRole("button", { name: "3 subagents" });
    await expect.element(group).toBeVisible();
    expect(group.element().textContent).toContain("3 done");
    expect(page.getByRole("button", { name: "3 subagents" }).elements()).toHaveLength(1);
    // The other marks of the group render nothing; the launch after it stands alone.
    expect(host.querySelector('[data-mark="2"]')?.childElementCount).toBe(0);
    expect(host.querySelector('[data-mark="3"]')?.childElementCount).toBe(0);
    await expect.element(page.getByText("Created thread · Side quest")).toBeVisible();

    await userEvent.click(group);
    for (const title of ["north", "south", "east"]) {
      const row = page.getByRole("button", { name: `Open ${title}`, exact: true });
      await expect.element(row).toBeVisible();
      expect(row.element().textContent).toContain("Completed");
    }
    await act(async () => root.unmount());
    host.remove();
  });
});
