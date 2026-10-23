import type { DeviceState } from "@jhin/preview-api";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

import { DevicePanel } from "../src/plugins/devices/panel.tsx";
import { DeviceSetupDialog } from "../src/plugins/devices/setup.tsx";

// Clicked in the DOM: without the app's styles the dialog's backdrop is not stacked under it.
const click = (locator: Locator) => act(async () => (locator.element() as HTMLElement).click());

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

type Setup = NonNullable<DeviceState["setup"]>;
const state = (patch: Omit<Partial<DeviceState>, "setup"> & { setup?: Partial<Setup> }) =>
  ({
    hosts: [
      {
        id: "local",
        kind: "local",
        label: "This node",
        platforms: [
          { platform: "ios", available: true },
          { platform: "android", available: false, reason: "Android SDK was not found." },
        ],
      },
    ],
    devices: [
      {
        hostId: "local",
        id: "SIM-1",
        platform: "ios",
        name: "iPhone 15",
        version: "17.2",
        booted: true,
        physical: false,
      },
    ],
    sessions: [],
    booting: [],
    ...patch,
    setup: {
      hubEnabled: false,
      agentAccessEnabled: false,
      onboardingCompleted: false,
      agentToolsReady: false,
      ...patch.setup,
    },
  }) as DeviceState;

/** The wizard over `initial`, recording the node calls it makes; `rerender` gives it a new state. */
async function mount(
  initial: DeviceState,
  answer: (method: string) => Promise<unknown> = async () => ({}),
) {
  const calls: { method: string; params: unknown }[] = [];
  const closed: string[] = [];
  const errors: { title: string; error: unknown }[] = [];
  const answers: Promise<unknown>[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (next: DeviceState) =>
    act(async () =>
      root.render(
        <DeviceSetupDialog
          call={(method, params) => {
            calls.push({ method, params });
            // The very promise the wizard handles, so a test can wait for its handler to run.
            const result = answer(method);
            answers.push(result);
            return result;
          }}
          onClose={(reason) => {
            closed.push(reason);
          }}
          onError={(title, error) => {
            errors.push({ title, error });
          }}
          state={next}
        />,
      ),
    );
  await render(initial);
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  /** Resolves once the wizard has handled every answer so far, its state updates applied. */
  const handled = async () => {
    // The wizard's own handlers were attached first, so they have run once these settle.
    await Promise.allSettled(answers);
    await act(async () => undefined);
  };
  return { calls, closed: () => closed, errors, handled, rerender: render };
}

describe("T3's Set up devices wizard (D1328)", () => {
  it("says why the hub did not start when the node refuses, not when it is still installing", async () => {
    // The node refuses the call itself: the user is told.
    const refused = Object.assign(new Error("Not allowed"), { code: "PERMISSION_DENIED" });
    const first = await mount(state({ setup: { hubEnabled: true } }), () =>
      Promise.reject(refused),
    );
    await first.handled();
    expect(first.calls.map((call) => call.method)).toEqual(["device.hub.access"]);
    expect(first.errors).toEqual([{ title: "Couldn't start the device hub", error: refused }]);
    cleanup?.();
    cleanup = undefined;

    // Still installing: its status row says so, and no error is added.
    const late = Object.assign(new Error("Installing…"), { code: "DEVICE_UNAVAILABLE" });
    const second = await mount(state({ setup: { hubEnabled: true } }), () => Promise.reject(late));
    await second.handled();
    expect(second.calls.map((call) => call.method)).toEqual(["device.hub.access"]);
    expect(second.errors).toEqual([]);
  });

  it("turns the hub on without granting agents, and Cancel closes it", async () => {
    const wizard = await mount(state({}));
    await click(page.getByRole("switch", { name: "Enable device hub" }));
    expect(wizard.calls.slice(0, 2)).toEqual([
      {
        method: "host.config.patch",
        params: {
          layer: "node",
          section: "jhin.devices",
          values: { hub: true, agentAccess: false },
        },
      },
      { method: "device.hub.access", params: {} },
    ]);
    await expect.element(page.getByRole("button", { name: "Continue" })).toBeDisabled();
    await click(page.getByRole("button", { name: "Cancel" }));
    expect(wizard.closed()).toEqual(["cancel"]);
  });

  it("walks the steps once the hub is ready, back and forth, and turning the hub off takes agents' access", async () => {
    const ready = state({
      hostStatuses: { local: { status: "ready" } },
      setup: { hubEnabled: true, agentAccessEnabled: true },
    });
    const wizard = await mount(ready);
    await expect.element(page.getByText("Device hub is ready.")).toBeInTheDocument();
    await click(page.getByRole("button", { name: "Continue" }));
    await expect
      .element(page.getByText("Xcode and iOS Simulator are available."))
      .toBeInTheDocument();
    await expect.element(page.getByText("Android SDK was not found.")).toBeInTheDocument();
    await click(page.getByRole("button", { name: "Back" }));
    await click(page.getByRole("switch", { name: "Enable device hub" }));
    expect(wizard.calls.at(-1)).toEqual({
      method: "host.config.patch",
      params: {
        layer: "node",
        section: "jhin.devices",
        values: { hub: false, agentAccess: false },
      },
    });
  });

  it("offers Retry for a hub that failed to start", async () => {
    const wizard = await mount(
      state({
        hostStatuses: {
          local: {
            status: "failed",
            detail: "Device support failed during installing device hub.",
          },
        },
        setup: { hubEnabled: true },
      }),
    );
    await expect
      .element(page.getByText("Device support failed during installing device hub."))
      .toBeInTheDocument();
    const before = wizard.calls.length;
    await click(page.getByRole("button", { name: "Retry" }));
    expect(wizard.calls.slice(before)).toEqual([{ method: "device.hub.access", params: {} }]);
  });

  it("finishes with Done, which records the setup", async () => {
    const wizard = await mount(
      state({ hostStatuses: { local: { status: "ready" } }, setup: { hubEnabled: true } }),
    );
    await click(page.getByRole("button", { name: "Continue" }));
    await click(page.getByRole("button", { name: "Continue" }));
    await expect
      .element(page.getByRole("switch", { name: "Allow agents to control devices" }))
      .not.toBeChecked();
    await click(page.getByRole("button", { name: "Done" }));
    expect(wizard.calls.at(-1)).toEqual({
      method: "host.config.patch",
      params: {
        layer: "node",
        section: "jhin.devices",
        values: { onboardingCompleted: true, agentAccess: false },
      },
    });
    expect(wizard.closed()).toEqual(["done"]);
  });

  it("records agent access on Done for a node whose access only followed its hub (D1328)", async () => {
    // A node that turned the hub on before agent access existed: access follows the hub.
    const wizard = await mount(
      state({
        hostStatuses: { local: { status: "ready" } },
        setup: { hubEnabled: true, agentAccessEnabled: true, agentToolsReady: true },
      }),
    );
    await click(page.getByRole("button", { name: "Continue" }));
    await click(page.getByRole("button", { name: "Continue" }));
    await expect
      .element(page.getByRole("switch", { name: "Allow agents to control devices" }))
      .toBeChecked();
    await click(page.getByRole("button", { name: "Done" }));
    expect(wizard.calls.at(-1)).toEqual({
      method: "host.config.patch",
      params: {
        layer: "node",
        section: "jhin.devices",
        values: { onboardingCompleted: true, agentAccess: true },
      },
    });
  });
});

describe("the devices panel's setup (D1328)", () => {
  /** The panel of a node at `nodeUrl` showing `shown`; unmount and mount again to revisit. */
  async function panel(nodeUrl: string, shown: DeviceState) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = { subscribe: () => ({ dispose() {} }) } as never;
    const render = (url: string) =>
      act(async () =>
        root.render(
          <DevicePanel
            call={async () => ({})}
            client={client}
            nodeUrl={url}
            onClose={() => undefined}
            onError={() => undefined}
            state={shown}
            threadId="t1"
          />,
        ),
      );
    await render(nodeUrl);
    const unmount = () => {
      act(() => root.unmount());
      container.remove();
    };
    cleanup = unmount;
    return Object.assign(unmount, { showNode: render });
  }

  it("keeps a Cancel for the node on a later visit, and its notice asks again", async () => {
    const nodeUrl = `ws://cancel-${crypto.randomUUID()}.test/rpc`;
    const wizard = page.getByRole("dialog", { name: "Set up devices" });
    const first = await panel(nodeUrl, state({}));
    await expect.element(wizard).toBeInTheDocument();
    await click(page.getByRole("button", { name: "Cancel" }));
    await expect.element(wizard).not.toBeInTheDocument();
    first();

    // The next visit to the same node: no wizard, the notice offers it.
    await panel(nodeUrl, state({}));
    await expect
      .element(page.getByText("Video and input need the device hub."))
      .toBeInTheDocument();
    expect(wizard.query()).toBeNull();
    await click(page.getByRole("button", { name: "Set up devices" }));
    await expect.element(wizard).toBeInTheDocument();
  });

  it("asks again on a later visit after Escape, which only Cancel does not", async () => {
    const nodeUrl = `ws://escape-${crypto.randomUUID()}.test/rpc`;
    const wizard = page.getByRole("dialog", { name: "Set up devices" });
    const first = await panel(nodeUrl, state({}));
    await expect.element(wizard).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await expect.element(wizard).not.toBeInTheDocument();
    first();

    await panel(nodeUrl, state({}));
    await expect.element(wizard).toBeInTheDocument();
  });

  it("keeps each node's Cancel to that node when the same panel shows another", async () => {
    const declined = `ws://declined-${crypto.randomUUID()}.test/rpc`;
    const other = `ws://other-${crypto.randomUUID()}.test/rpc`;
    const wizard = page.getByRole("dialog", { name: "Set up devices" });
    const shown = await panel(declined, state({}));
    await click(page.getByRole("button", { name: "Cancel" }));
    await expect.element(wizard).not.toBeInTheDocument();
    // The same panel, another node: that node was never declined.
    await shown.showNode(other);
    await expect.element(wizard).toBeInTheDocument();
    // Back to the first: its Cancel holds.
    await shown.showNode(declined);
    await expect.element(wizard).not.toBeInTheDocument();
  });
});
