import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  ThreadHooks,
  type AgentRegistry,
  type AgentRuntime,
  type TurnEndHookInput,
  type TurnHookInput,
  type TurnRequest,
} from "@jhin/agent-api";
import { definePlugin, type PluginContext } from "@jhin/sdk";
import { testManifest } from "@jhin/testing";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fakeTurn } from "../../agent-fake/src/index.ts";
import { TURN_HOOK_TIMEOUT_MS } from "../src/index.ts";
import { node, watch } from "./support.ts";

interface Thread {
  id: string;
  projectId: string;
  worktreePath?: string;
}

/** A plugin that registers `runtime` and lets `setup` hook into the node. */
function plugin(id: string, setup: (context: PluginContext) => void, runtime?: AgentRuntime) {
  return {
    manifest: testManifest(id, {
      side: "server",
      ...(runtime === undefined ? {} : { requires: { "agent.registry": "^1" } }),
    }),
    definition: definePlugin({
      activate(context) {
        if (runtime !== undefined) {
          context.subscriptions.add(
            context.services.get<AgentRegistry>("agent.registry").register(runtime),
          );
        }
        setup(context);
      },
    }),
  };
}

const directory = () => Fs.realpathSync(Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-worktree-")));

describe("jhin.threads: turn hooks", () => {
  it("runs the start hook before the agent and the end hook before the turn's end is recorded", async () => {
    const order: string[] = [];
    const starts: TurnHookInput[] = [];
    const ends: TurnEndHookInput[] = [];
    /** The thread's event types when the end hook ran. */
    const recordedAtEnd: string[] = [];
    const agent: AgentRuntime = {
      agentId: "acme.agent",
      startTurn(request) {
        order.push("agent");
        return fakeTurn(request);
      },
    };
    const hooks = plugin(
      "acme.hooks",
      (context) => {
        context.hooks.before<TurnHookInput>(ThreadHooks.turnStart, (input) => {
          order.push("start");
          starts.push(input);
          return input;
        });
        context.hooks.before<TurnEndHookInput>(ThreadHooks.turnEnd, async (input) => {
          order.push("end");
          ends.push(input);
          const events = (await context.commands.execute("threads.events", {
            threadId: input.threadId,
          })) as { type: string }[];
          recordedAtEnd.push(...events.map((event) => event.type));
          return input;
        });
      },
      agent,
    );
    const { client } = await node({ agent: false, plugins: [hooks] });
    const project = directory();
    const { id: projectId } = await client.call<{ id: string }>("projects.create", {
      path: project,
    });
    const thread = await client.call<Thread>("threads.create", { projectId });
    const { until } = watch(client, thread.id);

    const { turnId } = await client.call<{ turnId: string }>("threads.send", {
      threadId: thread.id,
      text: "hi",
    });
    await until("agent.turn.completed");

    expect(order).toEqual(["start", "agent", "end"]);
    // The end hook ran after the agent's answer and before the turn's end was recorded.
    expect(recordedAtEnd).toContain("agent.item.completed");
    expect(recordedAtEnd).not.toContain("agent.turn.completed");
    const expected = {
      threadId: thread.id,
      projectId,
      turnId,
      agentId: "acme.agent",
      cwd: project,
    };
    expect(starts).toEqual([expected]);
    expect(ends).toEqual([{ ...expected, status: "completed" }]);
  });

  it("fails the turn without starting the agent when a start hook throws", async () => {
    let started = false;
    const agent: AgentRuntime = {
      agentId: "acme.agent",
      startTurn(request) {
        started = true;
        return fakeTurn(request);
      },
    };
    const hooks = plugin(
      "acme.veto",
      (context) => {
        context.hooks.before(ThreadHooks.turnStart, () => {
          throw new Error("not now");
        });
      },
      agent,
    );
    const { client } = await node({ agent: false, plugins: [hooks] });
    const thread = await client.call<Thread>("threads.create", {});
    const { until } = watch(client, thread.id);

    await expect(client.call("threads.send", { threadId: thread.id, text: "hi" })).rejects.toThrow(
      "not now",
    );
    expect((await until("agent.turn.failed")).payload).toMatchObject({
      error: expect.stringContaining("not now"),
    });
    expect(started).toBe(false);
    // The thread is free again.
    const { running } = await client.call<{ running?: string }>("threads.get", {
      threadId: thread.id,
    });
    expect(running).toBeUndefined();
  });

  it("still ends the turn when an end hook throws, and tells the hook how it ended", async () => {
    const statuses: string[] = [];
    const hooks = plugin("acme.broken-end", (context) => {
      context.hooks.before<TurnEndHookInput>(ThreadHooks.turnEnd, (input) => {
        statuses.push(input.status);
        throw new Error("broken");
      });
    });
    const { client } = await node({ plugins: [hooks] });
    const thread = await client.call<Thread>("threads.create", {});
    const { until } = watch(client, thread.id);

    await client.call("threads.send", { threadId: thread.id, text: "/fail now" });
    await until("agent.turn.failed");
    await client.call("threads.send", { threadId: thread.id, text: "/hold on" });
    await until("agent.item.delta");
    await client.call("threads.interrupt", { threadId: thread.id });
    await until("agent.turn.interrupted");

    expect(statuses).toEqual(["failed", "interrupted"]);
  });
});

describe("jhin.threads: turn hooks that never answer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A promise with its resolver. */
  const latch = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  };

  it("starts the agent once a start hook has not answered in time", async () => {
    const called = latch();
    const hooks = plugin("acme.stuck-start", (context) => {
      context.hooks.around(ThreadHooks.turnStart, () => {
        called.resolve();
        return new Promise(() => undefined);
      });
    });
    const { client } = await node({ plugins: [hooks] });
    const thread = await client.call<Thread>("threads.create", {});
    const { until } = watch(client, thread.id);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sent = client.call("threads.send", { threadId: thread.id, text: "hi" });
    await called.promise;
    vi.advanceTimersByTime(TURN_HOOK_TIMEOUT_MS);
    await sent;
    await until("agent.turn.completed");
  });

  it("ends the turn once an end hook has not answered in time", async () => {
    const called = latch();
    const hooks = plugin("acme.stuck-end", (context) => {
      context.hooks.around(ThreadHooks.turnEnd, () => {
        called.resolve();
        return new Promise(() => undefined);
      });
    });
    const { client } = await node({ plugins: [hooks] });
    const thread = await client.call<Thread>("threads.create", {});
    const { until } = watch(client, thread.id);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await client.call("threads.send", { threadId: thread.id, text: "hi" });
    await called.promise;
    vi.advanceTimersByTime(TURN_HOOK_TIMEOUT_MS);
    await until("agent.turn.completed");
  });
});

describe("jhin.threads: a thread's own working directory", () => {
  it("runs the thread's turns in its worktree, and in the project's directory again once cleared", async () => {
    const seen: TurnRequest[] = [];
    const agent: AgentRuntime = {
      agentId: "acme.agent",
      startTurn(request) {
        seen.push(request);
        return fakeTurn(request);
      },
    };
    const { client } = await node({ agent: false, plugins: [plugin("acme.p", () => {}, agent)] });
    const project = directory();
    const worktree = directory();
    const { id: projectId } = await client.call<{ id: string }>("projects.create", {
      path: project,
    });
    const thread = await client.call<Thread>("threads.create", {
      projectId,
      worktreePath: worktree,
    });
    expect(thread.worktreePath).toBe(worktree);
    const { until } = watch(client, thread.id);

    await client.call("threads.send", { threadId: thread.id, text: "one" });
    await until("agent.turn.completed");
    const cleared = await client.call<Thread>("threads.update", {
      threadId: thread.id,
      worktreePath: null,
    });
    expect(cleared.worktreePath).toBeUndefined();
    await client.call("threads.send", { threadId: thread.id, text: "two" });
    await until("agent.turn.completed", 1);
    const moved = await client.call<Thread>("threads.update", {
      threadId: thread.id,
      worktreePath: worktree,
    });
    expect(moved.worktreePath).toBe(worktree);

    expect(seen.map((request) => request.cwd)).toEqual([worktree, project]);
  });

  it("refuses a directory that does not exist, and fails a turn whose worktree is gone", async () => {
    const { client } = await node();
    const worktree = directory();
    await expect(
      client.call("threads.create", { worktreePath: Path.join(worktree, "missing") }),
    ).rejects.toMatchObject({ code: "WORKTREE_PATH_INVALID" });
    await expect(
      client.call("threads.create", { worktreePath: "relative/path" }),
    ).rejects.toMatchObject({ code: "WORKTREE_PATH_INVALID" });

    const thread = await client.call<Thread>("threads.create", { worktreePath: worktree });
    const { until } = watch(client, thread.id);
    Fs.rmSync(worktree, { recursive: true });
    await expect(
      client.call("threads.send", { threadId: thread.id, text: "hi" }),
    ).rejects.toMatchObject({ code: "WORKTREE_NOT_FOUND" });
    expect((await until("agent.turn.failed")).payload).toMatchObject({
      error: expect.stringContaining("no longer exists"),
    });
  });

  it("stores a worktree by its real path, and leaves a missing project directory to the agent", async () => {
    const seen: string[] = [];
    const agent: AgentRuntime = {
      agentId: "acme.agent",
      startTurn(request) {
        seen.push(request.cwd);
        return fakeTurn(request);
      },
    };
    const { client } = await node({ agent: false, plugins: [plugin("acme.p", () => {}, agent)] });
    const worktree = directory();
    const link = Path.join(directory(), "link");
    Fs.symlinkSync(worktree, link);
    const linked = await client.call<Thread>("threads.create", { worktreePath: link });
    expect(linked.worktreePath).toBe(worktree);

    const project = directory();
    const { id: projectId } = await client.call<{ id: string }>("projects.create", {
      path: project,
    });
    const thread = await client.call<Thread>("threads.create", { projectId });
    const { until } = watch(client, thread.id);
    Fs.rmSync(project, { recursive: true });
    // Not a worktree the thread lost: the agent is asked, as before (D242).
    await client.call("threads.send", { threadId: thread.id, text: "hi" });
    await until("agent.turn.completed");
    expect(seen).toEqual([project]);
  });

  it("moves a running thread's next turn, not the one running", async () => {
    const seen: string[] = [];
    const agent: AgentRuntime = {
      agentId: "acme.agent",
      startTurn(request) {
        seen.push(request.cwd);
        return fakeTurn(request);
      },
    };
    const { client } = await node({ agent: false, plugins: [plugin("acme.p", () => {}, agent)] });
    const worktree = directory();
    const thread = await client.call<Thread>("threads.create", {});
    const { until } = watch(client, thread.id);
    await client.call("threads.send", { threadId: thread.id, text: "/hold on" });
    await until("agent.item.delta");
    await client.call("threads.update", { threadId: thread.id, worktreePath: worktree });
    await client.call("threads.interrupt", { threadId: thread.id });
    await until("agent.turn.interrupted");
    await client.call("threads.send", { threadId: thread.id, text: "next" });
    await until("agent.turn.completed");

    expect(seen[1]).toBe(worktree);
    expect(seen[0]).not.toBe(worktree);
  });
});
