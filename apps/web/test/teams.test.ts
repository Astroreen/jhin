import { TEAMS_STREAM, TeamEvents, type TeamRecord } from "@jhin/agent-api";
import type { Connections, NodeConnection } from "@jhin/client-api";
import { toDisposable } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

import { isUp, nodeLabel, teamRoute } from "../src/plugins/teams/route.ts";
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
