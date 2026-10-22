import { MESSAGES_STREAM, TEAMS_STREAM, TeamEvents, type TeamRecord } from "@jhin/agent-api";
import type { Connections, NodeConnection } from "@jhin/client-api";
import type { RpcClient } from "@jhin/rpc";
import { toDisposable } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  followConversation,
  unanswered,
  type ConversationView,
} from "../src/plugins/teams/conversation.ts";
import { chosenTeam, isUp, leadRoute, nodeLabel, teamRoute } from "../src/plugins/teams/route.ts";
import { createTeamsStore } from "../src/plugins/teams/store.ts";

const team = (teamId: string, upAt?: string, downAt?: string): TeamRecord => ({
  teamId,
  title: teamId,
  lead: "lead",
  source: "config",
  members: [],
  ...(upAt === undefined ? {} : { upAt }),
  ...(downAt === undefined ? {} : { downAt }),
});

type Listener = (event: { type: string; payload: unknown }) => void;

/** One open node: its `teams.list` answers in turn, and its streams to push events into. */
function fakeNode(answers: (() => Promise<unknown>)[]) {
  const streams = new Map<string, { after: number; listener: Listener }>();
  const listeners = new Set<() => void>();
  let calls = 0;
  let state: NodeConnection["state"] = "open";
  const connection = {
    id: "a",
    get state() {
      return state;
    },
    client: {
      call: (method: string) =>
        method === "teams.list"
          ? answers[Math.min(calls++, answers.length - 1)]!()
          : Promise.reject(new Error(method)),
      subscribe: (stream: string, options: { after: number }, listener: Listener) => {
        streams.set(stream, { after: options.after, listener });
        return toDisposable(() => streams.delete(stream));
      },
    },
  } as unknown as NodeConnection;
  const connections = {
    list: () => [connection],
    get: () => connection,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return toDisposable(() => listeners.delete(listener));
    },
  } as unknown as Connections;
  return {
    connections,
    streams,
    calls: () => calls,
    close() {
      state = "closed" as NodeConnection["state"];
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
const quiet = { warn() {} };

describe("teams in Civilization mode (D691)", () => {
  it("lists a node's teams, and lists them again on each event of its stream", async () => {
    const node = fakeNode([
      () => Promise.resolve({ head: 3, teams: [team("workshop")] }),
      () => Promise.resolve({ head: 4, teams: [team("workshop", "2026-10-22T01:00:00Z")] }),
    ]);
    const store = createTeamsStore(node.connections, quiet);
    const seen: string[] = [];
    const subscription = store.subscribe("a", () => seen.push(store.view("a").status));
    await drain();
    expect(store.view("a")).toMatchObject({ status: "ready", teams: [{ teamId: "workshop" }] });
    expect(node.streams.get(TEAMS_STREAM)?.after).toBe(3);

    node.streams.get(TEAMS_STREAM)!.listener({ type: TeamEvents.up, payload: {} });
    await drain();
    expect(node.calls()).toBe(2);
    expect(isUp(store.view("a").teams[0]!)).toBe(true);

    // A closed connection's teams are not live any more.
    node.close();
    expect(store.view("a").status).toBe("loading");
    expect(node.streams.size).toBe(0);
    subscription.dispose();
    store.dispose();
    expect(seen).toContain("ready");
  });

  it("takes a node without teams.list as one without teams", async () => {
    const node = fakeNode([
      () => Promise.reject(Object.assign(new Error("no"), { code: "COMMAND_NOT_FOUND" })),
    ]);
    const store = createTeamsStore(node.connections, quiet);
    const subscription = store.subscribe("a", () => {});
    await drain();
    expect(store.view("a")).toEqual({ status: "unavailable", teams: [] });
    subscription.dispose();
    store.dispose();
  });

  it("tells a team that is up from one stopped since", () => {
    expect(isUp(team("t"))).toBe(false);
    expect(isUp(team("t", "2026-10-22T01:00:00Z"))).toBe(true);
    expect(isUp(team("t", "2026-10-22T01:00:00Z", "2026-10-22T02:00:00Z"))).toBe(false);
    expect(isUp(team("t", "2026-10-22T03:00:00Z", "2026-10-22T02:00:00Z"))).toBe(true);
    expect(teamRoute({ node: "a", mode: "civilization" }, "workshop")).toEqual({
      node: "a",
      mode: "civilization",
      panel: "team",
      section: "workshop",
    });
    expect(nodeLabel("453867af-e9fe-4274-84eb-f9898a8ece99")).toBe("453867af");
  });
});

describe("the conversation with the lead (C1, D1061–D1063)", () => {
  const entry = (messageId: string, from: string, kind: "ask" | "message", answer?: string) => ({
    message: {
      messageId,
      kind,
      from,
      to: from === "o" ? "l" : "o",
      body: messageId,
      traceId: "t",
      sentAt: "2026-10-22T10:00:00Z",
    },
    ...(answer === undefined ? {} : { answer }),
  });

  /** A node whose `agents.conversation` answers as `answers` say, in turn. */
  function conversationNode(answers: (() => Promise<unknown>)[]) {
    const calls: unknown[] = [];
    const state: {
      listener?: (() => void) | undefined;
      onError?: (error: unknown) => void;
      after?: number;
    } = {};
    const client = {
      call: (method: string, input: unknown) => {
        calls.push([method, input]);
        return answers[Math.min(calls.length - 1, answers.length - 1)]!();
      },
      subscribe: (
        stream: string,
        options: { after: number; onError: (error: unknown) => void },
        onEvent: () => void,
      ) => {
        expect(stream).toBe(MESSAGES_STREAM);
        state.after = options.after;
        state.onError = options.onError;
        state.listener = onEvent;
        return toDisposable(() => (state.listener = undefined));
      },
    } as unknown as RpcClient;
    return { client, calls, state };
  }

  it("reads the conversation, and reads it again on each event of agents/messages", async () => {
    const node = conversationNode([
      () => Promise.resolve({ head: 2, owner: "o", entries: [entry("m1", "o", "ask")] }),
      () => Promise.resolve({ head: 3, owner: "o", entries: [entry("m1", "o", "ask", "done")] }),
    ]);
    const views: ConversationView[] = [];
    const following = followConversation(node.client, "lead@workshop", (view) => views.push(view));
    await drain();
    expect(node.calls[0]).toEqual(["agents.conversation", { with: "lead@workshop" }]);
    expect(node.state.after).toBe(2);
    expect(unanswered(views.at(-1)!.entries[0]!, "o")).toBe(true);
    node.state.listener!();
    await drain();
    expect(views.at(-1)?.entries[0]?.answer).toBe("done");
    expect(unanswered(views.at(-1)!.entries[0]!, "o")).toBe(false);
    following.dispose();
    expect(node.state.listener).toBeUndefined();
  });

  it("lets no overtaken read speak, and says when the node has no conversation", async () => {
    let fail: (error: unknown) => void = () => {};
    const node = conversationNode([
      () => Promise.resolve({ head: 1, owner: "o", entries: [] }),
      () => new Promise((_resolve, reject) => (fail = reject)),
      () => Promise.resolve({ head: 3, owner: "o", entries: [entry("m1", "o", "message")] }),
    ]);
    const views: ConversationView[] = [];
    followConversation(node.client, "lead@workshop", (view) => views.push(view));
    await drain();
    node.state.listener!();
    node.state.listener!();
    await drain();
    // The second read fails after the third answered: the view stays ready.
    fail(new Error("late"));
    await drain();
    expect(views.at(-1)).toMatchObject({
      status: "ready",
      entries: [{ message: { messageId: "m1" } }],
    });
    node.state.onError!(new Error("stream gone"));
    expect(views.at(-1)).toMatchObject({ status: "error", error: "stream gone" });

    const missing = conversationNode([
      () => Promise.reject(Object.assign(new Error("no"), { code: "PERMISSION_DENIED" })),
    ]);
    const seen: ConversationView[] = [];
    followConversation(missing.client, "lead@workshop", (view) => seen.push(view));
    await drain();
    expect(seen.at(-1)?.status).toBe("unavailable");
  });

  it("knows an ask answered before D1061 as answered", () => {
    expect(unanswered({ ...entry("m1", "o", "ask"), answeredBy: "l" }, "o")).toBe(false);
    expect(unanswered(entry("m2", "l", "ask"), "o")).toBe(false);
  });

  it("talks to the route's team, else the first that is up, else the first", () => {
    const teams = [team("a"), team("b", "2026-10-22T01:00:00Z"), { ...team("c"), error: "bad" }];
    expect(chosenTeam(teams, {})?.teamId).toBe("b");
    expect(chosenTeam(teams, { section: "a" })?.teamId).toBe("a");
    // A team the route names that is invalid or gone is none, never another one.
    expect(chosenTeam(teams, { section: "c" })).toBeUndefined();
    expect(chosenTeam(teams, { section: "gone" })).toBeUndefined();
    // A section of a panel names something else.
    expect(chosenTeam(teams, { panel: "team", section: "a" })?.teamId).toBe("b");
    expect(chosenTeam([team("a")], {})?.teamId).toBe("a");
    expect(
      leadRoute({ node: "a", mode: "civilization", panel: "team", section: "x" }, "b"),
    ).toEqual({ node: "a", mode: "civilization", section: "b" });
  });
});
