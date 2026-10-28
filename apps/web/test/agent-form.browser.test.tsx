// An agent's definition form in Civilization mode (docs/plans/agents.md, D1065 and
// D1561): the `userSettings` switch defines and edits an agent through
// `agents.define` and `agents.update`.
import type { AgentRecord } from "@jhin/agent-api";
import { targetKey } from "@jhin/client-api";
import { toDisposable } from "@jhin/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent, type Locator } from "vite-plus/test/browser";

import "../src/index.css";
import { AgentForm } from "../src/plugins/agents/form.tsx";
import type { AgentsView } from "../src/plugins/agents/views.tsx";

const target = { node: "a" };
const RUNTIME = {
  agentId: "fake",
  name: "Fake",
  kind: "runtime",
  default: true,
  available: true,
  models: [],
};

/** A node that keeps definitions: `agents.define`, `agents.update` and the store that reads them back. */
function nodeOf() {
  const calls: { method: string; input: Record<string, any> }[] = [];
  // One promise per command, resolved once the node has handled it.
  const waiting = new Map<
    string,
    { promise: Promise<Record<string, any>>; resolve: (input: Record<string, any>) => void }
  >();
  const slot = (method: string) => {
    let entry = waiting.get(method);
    if (entry === undefined) {
      let resolve!: (input: Record<string, any>) => void;
      const promise = new Promise<Record<string, any>>((done) => (resolve = done));
      entry = { promise, resolve };
      waiting.set(method, entry);
    }
    return entry;
  };
  const called = (method: string) => slot(method).promise;
  const definitions = new Map<string, AgentRecord>();
  const listeners = new Set<() => void>();
  let snapshot = new Map<string, unknown>([
    [targetKey(target), { status: "ready", agents: [] as AgentRecord[] }],
  ]);
  const publish = () => {
    snapshot = new Map([
      [targetKey(target), { status: "ready", agents: [...definitions.values()] }],
    ]);
    for (const listener of listeners) listener();
  };
  const call = async (_target: unknown, method: string, input: Record<string, any>) => {
    calls.push({ method, input });
    if (method === "agents.list") return [RUNTIME];
    if (method === "agents.define") {
      const { agentId, role, runtime, userSettings } = input;
      definitions.set(agentId, {
        agentId,
        address: `jhin://a/agents/${agentId}`,
        kind: "defined",
        title: agentId,
        role,
        runtimeId: runtime,
        skills: [],
        generations: [],
        ...(userSettings === undefined ? {} : { userSettings }),
      } as AgentRecord);
      publish();
      slot(method).resolve(input);
    }
    if (method === "agents.update") {
      const { agentId, unset = [], ...set } = input;
      const { userSettings: _, ...rest } = definitions.get(agentId)!;
      definitions.set(agentId, {
        ...rest,
        ...(unset.includes("userSettings") ? {} : { userSettings: set.userSettings }),
      } as AgentRecord);
      publish();
      slot(method).resolve(input);
    }
    return {};
  };
  const view = {
    held: {
      store: {
        snapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return toDisposable(() => listeners.delete(listener));
        },
      },
    },
    threads: {
      call,
      catalog: () => undefined,
      subscribe: () => toDisposable(() => {}),
    },
    navigation: {
      subscribe: () => toDisposable(() => {}),
      current: () => ({}),
      navigate: () => {},
    },
  } as unknown as AgentsView;
  return { view, called, definitions };
}

/** A switch is clicked on its element, as the other browser tests do. */
const toggleOf = (locator: Locator) => act(async () => (locator.element() as HTMLElement).click());

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
});
async function render(element: React.ReactNode) {
  await unmount?.();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
}

describe("an agent's form holds userSettings (D1561, D1065)", () => {
  it("defines an agent with it on, edits it off, and reads the definition back", async () => {
    const { view, called, definitions } = nodeOf();
    await render(<AgentForm target={target} view={view} />);
    const toggle = page.getByRole("switch", { name: "Load the node user's own settings" });
    // Off when unset.
    await expect.element(toggle).not.toBeChecked();
    await userEvent.fill(page.getByRole("textbox", { name: "Id" }), "reviewer");
    await userEvent.fill(page.getByRole("textbox", { name: "Role" }), "Reviews slices");
    await toggleOf(toggle);
    await expect.element(toggle).toBeChecked();
    await userEvent.click(page.getByRole("button", { name: "Define agent" }));
    expect(await called("agents.define")).toMatchObject({
      agentId: "reviewer",
      userSettings: true,
    });
    expect(definitions.get("reviewer")?.userSettings).toBe(true);

    // Edit it: the form reads the definition back as on, and off is `unset`.
    await render(<AgentForm agentId="reviewer" target={target} view={view} />);
    const edit = page.getByRole("switch", { name: "Load the node user's own settings" });
    await expect.element(edit).toBeChecked();
    await toggleOf(edit);
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    expect(await called("agents.update")).toEqual({
      agentId: "reviewer",
      unset: ["userSettings"],
    });
    expect(definitions.get("reviewer")).not.toHaveProperty("userSettings", true);

    await render(<AgentForm agentId="reviewer" target={target} view={view} />);
    await expect
      .element(page.getByRole("switch", { name: "Load the node user's own settings" }))
      .not.toBeChecked();
  });
});
