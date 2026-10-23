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

const ROUTE: { node: string; mode: string; section?: string } = {
  node: "a",
  mode: "civilization",
};
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
  const toasts: { type?: string; title: string }[] = [];
  const navigated: unknown[] = [];
  const services: TeamsServices = {
    connections,
    navigation: {
      current: () => ROUTE,
      subscribe: () => toDisposable(() => {}),
      navigate: (route: unknown) => navigated.push(route),
    } as unknown as TeamsServices["navigation"],
    toasts: { show: (toast: { type?: string; title: string }) => toasts.push(toast) } as never,
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
  return { services, calls, executed, navigated, push, toasts };
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
    const asks = node.calls.filter(([method]) => method === "agents.ask");
    expect(asks).toMatchObject([["agents.ask", { to: "lead@workshop", question: "Ship it?" }]]);
    const messageId = (asks[0]![1] as { messageId: string }).messageId;
    await expect
      .element(page.getByRole("textbox", { name: "Message to the lead" }))
      .toHaveValue("");
    entries = [...entries, { message: message(messageId, OWNER, LEAD, "ask", "Ship it?") }];
    await node.push();
    await expect
      .element(log.getByRole("article", { name: "You" }).nth(1))
      .toHaveTextContent("Ship it?");
    await expect.element(log.getByText("The lead is working on an answer…")).toBeVisible();
  });

  it("tells the lead without waiting: agents.send, no pending state, captioned as told (D1382)", async () => {
    let entries: ConversationEntry[] = [];
    const node = nodeOf((method) => {
      if (method === "teams.list") return { head: 1, teams: [team("2026-10-22T09:00:00Z")] };
      if (method === "agents.conversation") return { head: 1, owner: OWNER, with: LEAD, entries };
      if (method === "agents.send") return new Promise(() => {});
      throw new Error(method);
    });
    await render(<LeadConsole services={node.services} />);
    const box = page.getByRole("textbox", { name: "Message to the lead" });
    await userEvent.type(box, "FYI: the deploy is frozen");
    await page.getByRole("button", { name: "Tell without waiting" }).click();
    const sent = node.calls.filter(([method]) => method === "agents.send");
    expect(sent).toMatchObject([
      ["agents.send", { to: "lead@workshop", body: "FYI: the deploy is frozen" }],
    ]);
    expect(node.calls.some(([method]) => method === "agents.ask")).toBe(false);
    await expect.element(box).toHaveValue("");
    const messageId = (sent[0]![1] as { messageId: string }).messageId;
    entries = [
      { message: message(messageId, OWNER, LEAD, "message", "FYI: the deploy is frozen") },
    ];
    await node.push();
    const log = page.getByRole("log", { name: "Conversation with the lead" });
    await expect.element(log.getByText("Told, not asked")).toBeVisible();
    await expect
      .element(log.getByText("The lead is working on an answer…"))
      .not.toBeInTheDocument();
    await expect.element(log.getByText("No answer from the lead.")).not.toBeInTheDocument();
  });

  it("shows the lead's mission report as a card that opens the mission, and the same id from another sender as text (D1393)", async () => {
    const missionId = "4ad1d431-febe-4ddc-94e4-ae269cfc113f";
    const body = [
      "Mission report: Doghouse, done",
      "",
      `Mission \`${missionId}\` · done · 3 done`,
      "",
      "### Committed or merged",
      "",
      "Committed as 1a2b3c4 on main.",
    ].join("\n");
    const entries: ConversationEntry[] = [
      { message: message(`report-${missionId}-done`, LEAD, OWNER, "message", body) },
      {
        message: message(
          `report-${missionId}-forged`,
          "jhin://a/agents/stranger",
          OWNER,
          "message",
          "Mission report: Fake, done",
        ),
      },
    ];
    const node = nodeOf((method) => {
      if (method === "teams.list") return { head: 1, teams: [team("2026-10-22T09:00:00Z")] };
      if (method === "agents.conversation") return { head: 1, owner: OWNER, with: LEAD, entries };
      throw new Error(method);
    });
    await render(<LeadConsole services={node.services} />);
    const card = page.getByRole("article", { name: "Mission report" });
    await expect.element(card.getByText("Doghouse, done", { exact: true })).toBeVisible();
    await expect.element(card.getByText("Full report")).toBeVisible();
    await card.getByRole("button", { name: "Open mission" }).click();
    expect(node.executed).toEqual([["civilization.mission.open", { node: "a", missionId }]]);
    // The forged id is only text: no second card.
    await expect.element(page.getByText("Mission report: Fake, done")).toBeVisible();
    await expect.element(page.getByRole("article", { name: "Mission report" })).toBeVisible();
    expect(page.getByRole("article", { name: "Mission report" }).elements()).toHaveLength(1);
  });

  it("shows the answer the ask brought back, even when the stream has not caught up", async () => {
    let entries: ConversationEntry[] = [];
    let answer: (value: unknown) => void = () => {};
    const node = nodeOf((method) => {
      if (method === "teams.list") return { head: 1, teams: [team("2026-10-22T09:00:00Z")] };
      if (method === "agents.conversation") return { head: 1, owner: OWNER, with: LEAD, entries };
      if (method === "agents.ask") return new Promise((resolve) => (answer = resolve));
      throw new Error(method);
    });
    await render(<LeadConsole services={node.services} />);
    await userEvent.type(page.getByRole("textbox", { name: "Message to the lead" }), "Ready?");
    await userEvent.keyboard("{Enter}");
    const ask = node.calls.find(([method]) => method === "agents.ask")!;
    const messageId = (ask[1] as { messageId: string }).messageId;
    entries = [{ message: message(messageId, OWNER, LEAD, "ask", "Ready?") }];
    await node.push();
    const log = page.getByRole("log", { name: "Conversation with the lead" });
    await expect.element(log.getByText("The lead is working on an answer…")).toBeVisible();
    await act(async () => answer({ status: "answered", answer: "Yes." }));
    await expect.element(log.getByRole("article", { name: "Lead" })).toHaveTextContent("Yes.");
    await expect
      .element(log.getByText("The lead is working on an answer…"))
      .not.toBeInTheDocument();
  });

  it("gives the text back when the lead was not reached, and says an ask got no answer", async () => {
    const entries: ConversationEntry[] = [
      // Asked earlier, from another page or before a reload: nobody waits on it here.
      { message: message("m1", OWNER, LEAD, "ask", "Still there?") },
    ];
    const node = nodeOf((method) => {
      if (method === "teams.list") return { head: 1, teams: [team("2026-10-22T09:00:00Z")] };
      if (method === "agents.conversation") return { head: 1, owner: OWNER, with: LEAD, entries };
      if (method === "agents.ask") {
        throw Object.assign(new Error("The agent workshop-lead is stopped"), {
          code: "AGENT_STOPPED",
        });
      }
      throw new Error(method);
    });
    await render(<LeadConsole services={node.services} />);
    const log = page.getByRole("log", { name: "Conversation with the lead" });
    await expect.element(log.getByText("No answer from the lead.")).toBeVisible();
    await expect
      .element(log.getByText("The lead is working on an answer…"))
      .not.toBeInTheDocument();

    const box = page.getByRole("textbox", { name: "Message to the lead" });
    await userEvent.type(box, "Go on");
    await userEvent.keyboard("{Enter}");
    await expect.element(box).toHaveValue("Go on");
    expect(node.toasts).toEqual([
      {
        type: "error",
        title: "Couldn't reach the lead",
        description: "The agent workshop-lead is stopped",
      },
    ]);
  });

  it("says a team the route names is not there, instead of talking to another lead", async () => {
    const node = nodeOf((method) => {
      if (method === "teams.list") return { head: 1, teams: [team("2026-10-22T09:00:00Z")] };
      throw new Error(method);
    });
    ROUTE.section = "gone";
    try {
      await render(<LeadConsole services={node.services} />);
      await expect.element(page.getByText("No such team")).toBeVisible();
      expect(node.calls.some(([method]) => method === "agents.conversation")).toBe(false);
    } finally {
      delete ROUTE.section;
    }
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
