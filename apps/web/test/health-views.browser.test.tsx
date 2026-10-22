// Health's views in Civilization mode (docs/plans/agents.md, D731): the states
// that the E2E does not reach.
import { applyHealthEvent, type HealthState, type Warning } from "@jhin/health-api";
import { toDisposable } from "@jhin/sdk";
import { SidebarProvider } from "@jhin/ui";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { NodeHealth } from "../src/plugins/health/store.ts";
import { HealthList, HealthPage, type HealthView } from "../src/plugins/health/views.tsx";

const warning: Warning = {
  warningId: "w1",
  detector: "proof-loop",
  subject: "slice:s1",
  group: { kind: "mission", projectId: "p1", missionId: "m1", title: "Doghouse" },
  summary: 'The proof of done slice "Floor" was recorded again 2 times',
  measures: { edits: 2, threshold: 2 },
  evidence: [
    {
      stream: "missions",
      sequence: 4,
      type: "missions.slice.proved",
      at: "2026-10-22T10:00:00Z",
      kind: "proof-edit",
    },
    {
      stream: "missions",
      sequence: 5,
      type: "missions.slice.proved",
      at: "2026-10-22T10:01:00Z",
      kind: "proof-edit",
    },
  ],
  raisedAt: "2026-10-22T10:01:01Z",
  status: "open",
  analysis: { status: "none", at: "2026-10-22T10:01:02Z" },
};
const healthOf = (...warnings: Warning[]): HealthState => ({
  warnings: Object.fromEntries(warnings.map((item) => [item.warningId, item])),
  ideas: {},
  progress: [],
});

const ROUTE = {};

/** A view over fixed feeds; `call` answers the node's commands. */
function viewOf(
  feeds: Record<string, NodeHealth>,
  call: (method: string, input: unknown) => Promise<unknown>,
) {
  const toasts: { type?: string; title: string }[] = [];
  const quiet = { subscribe: () => toDisposable(() => {}) };
  let snapshot = new Map(Object.entries(feeds));
  const listeners = new Set<() => void>();
  const view = {
    store: {
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return toDisposable(() => listeners.delete(listener));
      },
      // As `createNodeFeeds` does for a feed that is not live.
      apply: (id: string, event: { type: string; payload: unknown }) => {
        const feed = snapshot.get(id);
        if (feed?.status !== "error") return;
        snapshot = new Map(snapshot).set(id, {
          ...feed,
          value: applyHealthEvent(feed.value, event),
        });
        for (const listener of listeners) listener();
      },
    },
    connections: {
      get: (id: string) =>
        feeds[id] === undefined ? undefined : { label: `node ${id}`, client: { call } },
    },
    navigation: { ...quiet, current: () => ROUTE, navigate: () => {} },
    toasts: { show: (toast: { type?: string; title: string }) => toasts.push(toast) },
  } as unknown as HealthView;
  return { view, toasts };
}

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
});
async function render(element: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
}

describe("health views (D731)", () => {
  it("says a node has no health instead of asking it for the overview", async () => {
    const asked: string[] = [];
    const { view } = viewOf({ a: { status: "unsupported", value: healthOf() } }, async (method) => {
      asked.push(method);
      return { windowHours: 24, groups: [] };
    });
    await render(<HealthPage node="a" view={view} />);
    await expect.element(page.getByText("No health here")).toBeVisible();
    // A command the node is known not to have is not called.
    expect(asked).toEqual([]);
    await expect
      .element(page.getByRole("region", { name: "Ceremony and progress" }))
      .not.toBeInTheDocument();
  });

  it("shows a warning with no analyst, a trimmed event, and a dismiss that failed", async () => {
    const { view, toasts } = viewOf(
      { a: { status: "ready", value: healthOf(warning) } },
      async (method) => {
        if (method === "health.warnings.dismiss") throw new Error("denied");
        return {
          warning,
          events: [
            { ...warning.evidence[0]!, payload: null, missing: true },
            { ...warning.evidence[1]!, payload: { slice: { title: "Floor" } } },
            { ...warning.evidence[1]!, sequence: 6, payload: null, withheld: "missions.read" },
          ],
        };
      },
    );
    await render(<HealthPage node="a" view={view} warningId="w1" />);
    const region = page.getByRole("region", { name: "Health warning" });
    await expect
      .element(region.getByRole("heading", { name: "Recursive proof loop" }))
      .toBeVisible();
    await expect.element(region.getByText(/under `analysts`/)).toBeVisible();
    await expect.element(region.getByText("Trimmed from the log")).toBeVisible();
    await expect.element(region.getByText('Slice "Floor"')).toBeVisible();
    await expect.element(region.getByText("Needs missions.read to read")).toBeVisible();
    await userEvent.click(region.getByRole("button", { name: "Dismiss" }));
    await expect.element(region.getByRole("button", { name: "Dismiss" })).toBeEnabled();
    expect(toasts).toEqual([
      expect.objectContaining({ type: "error", title: "Couldn't dismiss the warning" }),
    ]);
  });

  it("keeps a warning on screen, marked not live, when its node's stream failed", async () => {
    const { view } = viewOf(
      { a: { status: "error", value: healthOf(warning), error: "stream gone" } },
      async () => ({ warning, events: [] }),
    );
    await render(<HealthPage node="a" view={view} warningId="w1" />);
    await expect.element(page.getByText(/Not live: stream gone/)).toBeVisible();
    await expect.element(page.getByText(warning.summary)).toBeVisible();
  });

  it("offers each node's overview, named, once there are several", async () => {
    const { view } = viewOf(
      {
        a: { status: "ready", value: healthOf(warning) },
        b: { status: "ready", value: healthOf() },
      },
      async () => ({}),
    );
    await render(
      <SidebarProvider>
        <HealthList view={view} />
      </SidebarProvider>,
    );
    await expect
      .element(page.getByRole("button", { name: "Ceremony and progress · node a" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Ceremony and progress · node b" }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: /Recursive proof loop/ })).toBeVisible();
  });

  it("does not say all is well before a node has answered", async () => {
    const { view } = viewOf({ a: { status: "unsupported", value: healthOf() } }, async () => ({}));
    await render(
      <SidebarProvider>
        <HealthList view={view} />
      </SidebarProvider>,
    );
    await expect.element(page.getByText("No node here reports health.")).toBeVisible();
    await expect.element(page.getByText("No warnings.")).not.toBeInTheDocument();
  });

  it("reads the overview once when its node turns ready", async () => {
    const asked: string[] = [];
    let feed: NodeHealth = { status: "loading", value: healthOf() };
    const listeners = new Set<() => void>();
    const { view } = viewOf({ a: feed }, async (method) => {
      asked.push(method);
      return { windowHours: 24, groups: [] };
    });
    let snapshot = new Map([["a", feed]]);
    Object.assign(view.store, {
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return toDisposable(() => listeners.delete(listener));
      },
    });
    await render(<HealthPage node="a" view={view} />);
    expect(asked).toEqual([]);
    feed = { status: "ready", value: healthOf(warning) };
    snapshot = new Map([["a", feed]]);
    await act(async () => {
      for (const listener of listeners) listener();
    });
    await expect.element(page.getByRole("region", { name: "Ceremony and progress" })).toBeVisible();
    expect(asked).toEqual(["health.status"]);
  });

  it("confirms a dismiss itself while the node's stream is not live", async () => {
    const { view, toasts } = viewOf(
      { a: { status: "error", value: healthOf(warning), error: "stream gone" } },
      async (method) =>
        method === "health.warnings.dismiss"
          ? {
              ...warning,
              status: "dismissed",
              dismissedAt: "2026-10-22T11:00:00Z",
              dismissedAfter: { missions: 5 },
            }
          : { warning, events: [] },
    );
    await render(<HealthPage node="a" view={view} warningId="w1" />);
    await userEvent.click(page.getByRole("button", { name: "Dismiss" }));
    // No event will mark it: the feed learns it here, and no second Dismiss is offered.
    await expect.element(page.getByText("Dismissed")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    expect(toasts).toEqual([
      expect.objectContaining({ type: "success", title: "Warning dismissed" }),
    ]);
    // The feed holds the node's record of the dismissal, not one of this client's clock.
    expect(view.store.snapshot().get("a")?.value.warnings["w1"]).toMatchObject({
      status: "dismissed",
      dismissedAt: "2026-10-22T11:00:00Z",
      dismissedAfter: { missions: 5 },
    });
  });

  it("makes one more read for the changes that came while a read was under way", async () => {
    const answers: ((value: unknown) => void)[] = [];
    const listeners = new Set<() => void>();
    let snapshot = new Map([["a", { status: "ready", value: healthOf() } as NodeHealth]]);
    const { view } = viewOf({}, () => new Promise((resolve) => answers.push(resolve)));
    Object.assign(view.store, {
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return toDisposable(() => listeners.delete(listener));
      },
    });
    Object.assign(view.connections, {
      get: () => ({
        label: "a",
        client: { call: () => new Promise((resolve) => answers.push(resolve)) },
      }),
    });
    const change = async () => {
      snapshot = new Map([["a", { status: "ready", value: healthOf() } as NodeHealth]]);
      await act(async () => {
        for (const listener of listeners) listener();
      });
    };
    await render(<HealthPage node="a" view={view} />);
    expect(answers).toHaveLength(1);
    // Three changes while the first read is under way: no read yet.
    await change();
    await change();
    await change();
    expect(answers).toHaveLength(1);
    await act(async () => answers[0]!({ windowHours: 24, groups: [] }));
    await expect.element(page.getByRole("region", { name: "Ceremony and progress" })).toBeVisible();
    // One more read for all three.
    expect(answers).toHaveLength(2);
  });

  it("keeps the last counts, marked, when a refresh fails", async () => {
    let fail = false;
    const { view } = viewOf({ a: { status: "ready", value: healthOf() } }, async () => {
      if (fail) throw new Error("node busy");
      return {
        windowHours: 24,
        groups: [{ group: { kind: "node" }, ceremony: 3, progress: 1, byKind: { message: 3 } }],
      };
    });
    await render(<HealthPage node="a" view={view} />);
    const overview = page.getByRole("region", { name: "Ceremony and progress" });
    await expect.element(overview.getByRole("cell", { name: "The node" })).toBeVisible();
    fail = true;
    await userEvent.click(overview.getByRole("button", { name: "Refresh" }));
    await expect.element(overview.getByText(/The last refresh failed: node busy/)).toBeVisible();
    await expect.element(overview.getByRole("cell", { name: "The node" })).toBeVisible();
  });

  it("marks a node whose stream failed in the sidebar, and keeps its overview", async () => {
    const { view } = viewOf(
      { a: { status: "error", value: healthOf(warning), error: "stream gone" } },
      async () => ({}),
    );
    await render(
      <SidebarProvider>
        <HealthList view={view} />
      </SidebarProvider>,
    );
    await expect.element(page.getByText(/Not live: node a/)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Ceremony and progress" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: /Recursive proof loop/ })).toBeVisible();
  });
});
