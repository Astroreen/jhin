// The conversation with the lead in Civilization mode (docs/plans/agents.md,
// C1: D1062–D1064): what the owner sees and what the composer calls.
import {
  MESSAGES_STREAM,
  type AgentMessage,
  type ConversationEntry,
  type TeamRecord,
} from "@jhin/agent-api";
import type { Connections, NodeConnection } from "@jhin/client-api";
import { toDisposable } from "@jhin/sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { LeadConsole } from "../src/plugins/teams/lead.tsx";
import { createTeamsStore } from "../src/plugins/teams/store.ts";
import type { TeamsServices } from "../src/plugins/teams/view.tsx";

const ROUTE = { node: "a", mode: "civilization" };
const OWNER = "jhin://a/owner";
const LEAD = "jhin://a/agents/workshop-lead";
const team = (upAt?: string): TeamRecord => ({
  teamId: "workshop",
  title: "Workshop",
  lead: "lead",
  source: "config",
  members: [],
  ...(upAt === undefined ? {} : { upAt }),
});
const message = (
  messageId: string,
  from: string,
  to: string,
  kind: AgentMessage["kind"],
  body: string,
): AgentMessage => ({
  messageId,
  kind,
  from,
  to,
  body,
  traceId: `t-${messageId}`,
  sentAt: "2026-10-22T10:00:00Z",
});

type Listener = () => void;

/** One open node `a`: `answer` answers its commands; `push` is an event of `agents/messages`. */
function nodeOf(answer: (method: string, input: unknown) => unknown) {
  const calls: [string, unknown][] = [];
  const streams = new Map<string, Listener>();
  const client = {
    call: async (method: string, input: unknown) => {
      calls.push([method, input]);
      return answer(method, input);
    },
    subscribe: (stream: string, _options: unknown, listener: Listener) => {
      streams.set(stream, listener);
      return toDisposable(() => streams.delete(stream));
    },
  };
  const connection = {
    id: "a",
    state: "open",
    label: "node a",
    client,
  } as unknown as NodeConnection;
  const list = [connection];
  const connections = {
    list: () => list,
    get: () => connection,
    subscribe: () => toDisposable(() => {}),
  } as unknown as Connections;
  const executed: [string, unknown][] = [];
  const navigated: unknown[] = [];
  const services: TeamsServices = {
    connections,
    navigation: {
      current: () => ROUTE,
      subscribe: () => toDisposable(() => {}),
      navigate: (route: unknown) => navigated.push(route),
    } as unknown as TeamsServices["navigation"],
    toasts: undefined,
    store: createTeamsStore(connections, { warn() {} }),
    commands: {
      execute: async (name: string, input: unknown) => {
        executed.push([name, input]);
        return {};
      },
    } as unknown as TeamsServices["commands"],
  };
  const push = async () => {
    await act(async () => streams.get(MESSAGES_STREAM)?.());
  };
  return { services, calls, executed, navigated, push };
}

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
});
async function render(element: React.ReactNode) {
  const host = document.createElement("div");
  host.style.height = "600px";
  host.style.display = "flex";
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
}

describe("the conversation with the lead (C1)", () => {
  it("shows the lead's answers and escalations, and asks the lead from the composer", async () => {
    let entries: ConversationEntry[] = [
      {
        message: message("m1", OWNER, LEAD, "ask", "Where are we?"),
        answer: "Slice 2 of 5.",
        answeredBy: LEAD,
      },
      { message: message("m2", LEAD, OWNER, "ask", "May I drop slice 4?"), inbox: "open" },
    ];
    const node = nodeOf((method) => {
      if (method === "teams.list") return { head: 1, teams: [team("2026-10-22T09:00:00Z")] };
      if (method === "agents.conversation") return { head: 2, owner: OWNER, with: LEAD, entries };
      if (method === "agents.ask") return new Promise(() => {});
      throw new Error(method);
    });
    await render(<LeadConsole services={node.services} />);

    const log = page.getByRole("log", { name: "Conversation with the lead" });
    await expect
      .element(log.getByRole("article", { name: "You" }))
      .toHaveTextContent("Where are we?");
    await expect
      .element(log.getByRole("article", { name: "Lead" }))
      .toHaveTextContent("Slice 2 of 5.");
    const escalation = log.getByRole("article", { name: "The lead asks you" });
    await expect.element(escalation.getByText("May I drop slice 4?")).toBeVisible();
    await escalation.getByRole("button", { name: "Answer" }).click();
    expect(node.executed).toEqual([["civilization.inbox.open", { node: "a", messageId: "m2" }]]);

    // The composer asks the lead by its alias (D1063); the ask shows once recorded.
    await userEvent.type(page.getByRole("textbox", { name: "Message to the lead" }), "Ship it?");
    await userEvent.keyboard("{Enter}");
    expect(node.calls.filter(([method]) => method === "agents.ask")).toEqual([
      ["agents.ask", { to: "lead@workshop", question: "Ship it?" }],
    ]);
    await expect
      .element(page.getByRole("textbox", { name: "Message to the lead" }))
      .toHaveValue("");
    entries = [...entries, { message: message("m3", OWNER, LEAD, "ask", "Ship it?") }];
    await node.push();
    await expect
      .element(log.getByRole("article", { name: "You" }).nth(1))
      .toHaveTextContent("Ship it?");
    await expect.element(log.getByText("The lead is working on an answer…")).toBeVisible();
  });

  it("offers to start a team that is not up, and keeps the composer closed until then", async () => {
    const node = nodeOf((method) => {
      if (method === "teams.list") return { head: 1, teams: [team()] };
      if (method === "agents.conversation") {
        return { head: 0, owner: OWNER, with: LEAD, entries: [] };
      }
      if (method === "teams.up") return { members: [] };
      throw new Error(method);
    });
    await render(<LeadConsole services={node.services} />);
    await expect.element(page.getByRole("textbox", { name: "Message to the lead" })).toBeDisabled();
    await page.getByRole("button", { name: "Start team" }).click();
    expect(node.calls.some(([method]) => method === "teams.up")).toBe(true);
  });

  it("says there is no team to talk to", async () => {
    const node = nodeOf((method) => {
      if (method === "teams.list") return { head: 0, teams: [] };
      throw new Error(method);
    });
    await render(<LeadConsole services={node.services} />);
    await expect.element(page.getByText("No team yet")).toBeVisible();
  });
});
