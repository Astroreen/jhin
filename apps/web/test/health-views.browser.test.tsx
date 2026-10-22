// Health's views in Civilization mode (docs/plans/agents.md, D731): the states
// that the E2E does not reach.
import type { HealthState, Warning } from "@jhin/health-api";
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
  const snapshot = new Map(Object.entries(feeds));
  const view = {
    store: { ...quiet, snapshot: () => snapshot },
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
});
