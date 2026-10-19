import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import type { AgentRegistry, AgentRuntime, TurnRequest } from "@jhin/agent-api";
import { definePlugin } from "@jhin/sdk";
import { testManifest } from "@jhin/testing";
import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTurn } from "../../agent-fake/src/index.ts";
import { titleFromText } from "../src/index.ts";
import { node, watch } from "./support.ts";

interface Thread {
  id: string;
  projectId: string;
  title: string;
  archivedAt?: string;
  agentId?: string;
  model?: string;
  runtimeMode?: string;
  lastTurn?: { turnId: string; status: string };
}

/** A plugin that registers `runtime` through agent.registry@1. */
function registering(runtime: AgentRuntime) {
  return {
    manifest: testManifest(`acme.${runtime.agentId}`, {
      side: "server",
      requires: { "agent.registry": "^1" },
    }),
    definition: definePlugin({
      activate(context) {
        context.subscriptions.add(
          context.services.get<AgentRegistry>("agent.registry").register(runtime),
        );
      },
    }),
  };
}

describe("jhin.threads: thread management", () => {
  it("renames, archives, unarchives and deletes threads, recording each in the threads index", async () => {
    const { client } = await node();
    const index = watch(client, "stream:threads");
    const thread = await client.call<Thread>("threads.create", {});

    const renamed = await client.call<Thread>("threads.update", {
      threadId: thread.id,
      title: "  Better name ",
    });
    expect(renamed.title).toBe("Better name");
    const archived = await client.call<Thread>("threads.archive", { threadId: thread.id });
    expect(archived.archivedAt).toEqual(expect.any(String));
    const back = await client.call<Thread>("threads.unarchive", { threadId: thread.id });
    expect(back.archivedAt).toBeUndefined();
    expect(await client.call("threads.delete", { threadId: thread.id })).toEqual({ deleted: true });

    await index.until("threads.thread.deleted");
    expect(index.events.map((event) => event.type)).toEqual([
      "threads.thread.created",
      "threads.thread.updated",
      "threads.thread.updated",
      "threads.thread.updated",
      "threads.thread.deleted",
    ]);
    expect(await client.call("threads.list", {})).toEqual([]);
    await expect(client.call("threads.get", { threadId: thread.id })).rejects.toMatchObject({
      code: "THREAD_NOT_FOUND",
    });
    // The stream itself stays, with a final deleted event.
    const stream = watch(client, thread.id);
    await stream.until("threads.thread.deleted");
  });

  it("names a new thread after its first message, and only the first", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const { until } = watch(client, thread.id);
    const index = watch(client, "stream:threads");

    await client.call("threads.send", { threadId: thread.id, text: "Fix the login form\nplease" });
    await until("agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "And the signup form" });
    await until("agent.turn.completed", 1);
    // The thread's record follows its turns in the index.
    const second = (await until("agent.turn.started", 1)).payload as { turnId: string };
    await index.untilMatch(
      (event) =>
        (event.payload as unknown as Thread).lastTurn?.turnId === second.turnId &&
        (event.payload as unknown as Thread).lastTurn?.status === "completed",
    );

    const { thread: named } = await client.call<{ thread: Thread }>("threads.get", {
      threadId: thread.id,
    });
    expect(named.title).toBe("Fix the login form");
    expect(named.lastTurn).toMatchObject({ status: "completed" });
  });

  it("shortens long titles at a word", () => {
    expect(titleFromText("   \n  short ")).toBe("short");
    expect(titleFromText("")).toBe("New thread");
    const title = titleFromText(
      "Please refactor the authentication middleware so that it validates tokens before routing",
    );
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toContain("  ");
  });

  it("keeps a title that was already chosen", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", { title: "Mine" });
    const { until } = watch(client, thread.id);
    await client.call("threads.send", { threadId: thread.id, text: "hello" });
    await until("agent.turn.completed");
    const { thread: after } = await client.call<{ thread: Thread }>("threads.get", {
      threadId: thread.id,
    });
    expect(after.title).toBe("Mine");
  });

  it("creates, renames and removes projects; the scratch project stays", async () => {
    const { client, data } = await node();
    const dir = Path.join(data, "my-app");
    Fs.mkdirSync(dir);
    const project = await client.call<{ id: string; name: string }>("projects.create", {
      path: dir,
    });
    expect(project.name).toBe("my-app");
    const thread = await client.call<Thread>("threads.create", { projectId: project.id });

    expect(
      await client.call("projects.update", { projectId: project.id, name: "App" }),
    ).toMatchObject({ name: "App" });
    await expect(
      client.call("projects.update", { projectId: "scratch", name: "x" }),
    ).rejects.toMatchObject({ code: "PROJECT_IS_SCRATCH" });

    expect(await client.call("projects.delete", { projectId: project.id })).toEqual({
      deletedThreads: 1,
    });
    expect(await client.call("threads.list", {})).toEqual([]);
    expect((await client.call<{ id: string }[]>("projects.list")).map((item) => item.id)).toEqual([
      "scratch",
    ]);
    await expect(client.call("threads.get", { threadId: thread.id })).rejects.toMatchObject({
      code: "THREAD_NOT_FOUND",
    });
    // The directory itself is left alone.
    expect(Fs.existsSync(dir)).toBe(true);
  });

  it("browses folders for a project picker", async () => {
    const { client, data } = await node();
    Fs.mkdirSync(Path.join(data, "repo", ".git"), { recursive: true });
    Fs.mkdirSync(Path.join(data, "plain"));
    Fs.mkdirSync(Path.join(data, ".hidden"));
    Fs.writeFileSync(Path.join(data, "file.txt"), "x");
    // A link to a folder is one; links to a file or to nothing are not.
    Fs.symlinkSync(Path.join(data, "plain"), Path.join(data, "linked"));
    Fs.symlinkSync(Path.join(data, "file.txt"), Path.join(data, "file-link"));
    Fs.symlinkSync(Path.join(data, "missing"), Path.join(data, "dangling"));

    const listing = await client.call<{
      path: string;
      parent?: string;
      entries: { name: string; git: boolean }[];
    }>("projects.browse", { path: data });

    expect(listing.path).toBe(Path.resolve(data));
    expect(listing.parent).toBe(Path.dirname(Path.resolve(data)));
    expect(listing.entries.filter((entry) => entry.name !== "jhin.threads")).toEqual([
      { name: "linked", path: Path.join(data, "linked"), git: false },
      { name: "plain", path: Path.join(data, "plain"), git: false },
      { name: "repo", path: Path.join(data, "repo"), git: true },
    ]);
    await expect(client.call("projects.browse", { path: "relative" })).rejects.toMatchObject({
      code: "PATH_INVALID",
    });
    // `~` is the home directory; `~user` is no path of this node's, even when
    // the home directory has a folder of that name.
    const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-home-"));
    Fs.mkdirSync(Path.join(home, "nobody", "app"), { recursive: true });
    vi.stubEnv("HOME", home);
    try {
      expect(await client.call("projects.browse", { path: "~" })).toMatchObject({ path: home });
      await expect(client.call("projects.browse", { path: "~nobody" })).rejects.toMatchObject({
        code: "PATH_INVALID",
      });
      await expect(client.call("projects.create", { path: "~nobody/app" })).rejects.toMatchObject({
        code: "PROJECT_PATH_INVALID",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("browses folders only with a permission of its own", async () => {
    const { kernel, data } = await node();
    const as = (permissions: string[]) => ({ caller: { id: "someone", permissions } });

    await expect(
      kernel.commands.execute("projects.browse", { path: data }, as(["projects.write"])),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(
      await kernel.commands.execute("projects.browse", { path: data }, as(["projects.browse"])),
    ).toMatchObject({ path: Path.resolve(data) });
  });
});

describe("jhin.threads: agents", () => {
  const seen: TurnRequest[] = [];
  const claude: AgentRuntime = {
    agentId: "acme.claude",
    name: "Claude",
    models: [
      { id: "opus", name: "Opus" },
      { id: "sonnet", name: "Sonnet" },
    ],
    defaultModel: "opus",
    runtimeModes: ["approval-required", "full-access"],
    startTurn(request) {
      seen.push(request);
      return fakeTurn(request);
    },
  };

  it("lists runtimes with their models and picks the first available one by default", async () => {
    const offline: AgentRuntime = {
      agentId: "acme.offline",
      status: async () => ({ available: false, message: "not installed" }),
      startTurn: fakeTurn,
    };
    const { client } = await node({ plugins: [registering(offline), registering(claude)] });

    const agents =
      await client.call<
        { agentId: string; available: boolean; default: boolean; models: unknown[] }[]
      >("agents.list");
    // Registered runtimes come before the node's single agent.runtime.
    expect(agents.at(-1)?.agentId).toBe("jhin.agent-fake");
    expect(
      agents
        .map(({ agentId, available, default: isDefault }) => [agentId, available, isDefault])
        .toSorted(),
    ).toEqual([
      ["acme.claude", true, true],
      ["acme.offline", false, false],
      ["jhin.agent-fake", true, false],
    ]);
    expect(agents.find((agent) => agent.agentId === "acme.claude")?.models).toHaveLength(2);
  });

  it("runs a turn with the chosen agent, model and mode, and keeps them for the thread", async () => {
    seen.length = 0;
    const { client } = await node({ plugins: [registering(claude)] });
    const thread = await client.call<Thread>("threads.create", {});
    const { events, until } = watch(client, thread.id);

    await client.call("threads.send", {
      threadId: thread.id,
      text: "hi",
      agentId: "acme.claude",
      model: "sonnet",
      runtimeMode: "approval-required",
    });
    await until("agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "again" });
    await until("agent.turn.completed", 1);

    expect(seen.map((request) => [request.model, request.runtimeMode])).toEqual([
      ["sonnet", "approval-required"],
      ["sonnet", "approval-required"],
    ]);
    expect(events.find((event) => event.type === "agent.turn.started")?.payload).toMatchObject({
      agentId: "acme.claude",
      model: "sonnet",
      runtimeMode: "approval-required",
    });
    const { thread: after } = await client.call<{ thread: Thread }>("threads.get", {
      threadId: thread.id,
    });
    expect(after).toMatchObject({
      agentId: "acme.claude",
      model: "sonnet",
      runtimeMode: "approval-required",
    });
    await expect(
      client.call("threads.send", { threadId: thread.id, text: "x", agentId: "acme.none" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("keeps a thread's settings consistent when they change", async () => {
    const { client } = await node({ plugins: [registering(claude)] });
    const thread = await client.call<Thread & { updatedAt: string }>("threads.create", {
      agentId: "acme.claude",
      model: "opus",
    });
    const index = watch(client, "stream:threads");

    const moded = await client.call<Thread & { updatedAt?: string }>("threads.update", {
      threadId: thread.id,
      runtimeMode: "approval-required",
    });
    expect(moded).toMatchObject({ model: "opus", runtimeMode: "approval-required" });
    expect(moded.updatedAt).toEqual(expect.any(String));
    // Another agent: the model it does not know is dropped, unless one is named.
    const switched = await client.call<Thread>("threads.update", {
      threadId: thread.id,
      agentId: "jhin.agent-fake",
    });
    expect(switched.agentId).toBe("jhin.agent-fake");
    expect(switched).not.toHaveProperty("model");
    // Nothing new: no change recorded.
    await client.call("threads.update", { threadId: thread.id, agentId: "jhin.agent-fake" });
    await expect(
      client.call("threads.update", { threadId: thread.id, agentId: "acme.none" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });

    // A rename marks the end: every change before it is in the index by then.
    await client.call("threads.update", { threadId: thread.id, title: "Done" });
    await index.untilMatch((event) => (event.payload as unknown as Thread).title === "Done");
    expect(index.events.map((event) => event.type)).toEqual([
      "threads.thread.created",
      "threads.thread.updated",
      "threads.thread.updated",
      "threads.thread.updated",
    ]);
  });

  it("uses the configured default agent", async () => {
    const { client } = await node({
      plugins: [registering(claude)],
      config: { "jhin.threads": { defaultAgent: "jhin.agent-fake" } },
    });
    const thread = await client.call<Thread>("threads.create", {});
    const { until } = watch(client, thread.id);
    await client.call("threads.send", { threadId: thread.id, text: "hi" });
    expect((await until("agent.turn.started")).payload).toMatchObject({
      agentId: "jhin.agent-fake",
    });
  });
});

describe("jhin.threads: turn items and requests", () => {
  it("records tool calls, reasoning and plans as events of the turn", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const { events, until } = watch(client, thread.id);

    await client.call("threads.send", { threadId: thread.id, text: "/tool npm test" });
    await until("agent.turn.completed");
    await client.call("threads.send", { threadId: thread.id, text: "/think about it" });
    await until("agent.turn.completed", 1);
    await client.call("threads.send", { threadId: thread.id, text: "/plan" });
    await until("agent.turn.completed", 2);

    const kinds = events.map((event) => {
      const payload = event.payload as { kind?: string };
      return payload.kind === undefined ? event.type : `${event.type}:${payload.kind}`;
    });
    expect(kinds).toContain("agent.item.started:tool");
    expect(kinds).toContain("agent.item.delta:tool");
    expect(kinds).toContain("agent.item.completed:tool");
    expect(kinds).toContain("agent.item.delta:reasoning");
    expect(kinds).toContain("agent.item.completed:reasoning");
    expect(events.filter((event) => event.type === "agent.plan.updated")).toHaveLength(2);
    expect(events.find((event) => event.type === "agent.item.started")?.payload).toMatchObject({
      tool: { kind: "command", detail: "npm test" },
    });
  });

  it("waits for an approval, then runs what was approved", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const { events, until } = watch(client, thread.id);
    const index = watch(client, "stream:threads");

    await client.call("threads.send", { threadId: thread.id, text: "/approve rm -rf build" });
    const opened = await until("agent.request.opened");
    const { requestId, request } = opened.payload as {
      requestId: string;
      request: { kind: string; tool: { detail: string } };
    };
    expect(request).toMatchObject({ kind: "approval", tool: { detail: "rm -rf build" } });
    // The thread shows that it waits for the user.
    await index.untilMatch(
      (event) => (event.payload as unknown as Thread).lastTurn?.status === "waiting",
    );

    await expect(
      client.call("threads.respond", {
        threadId: thread.id,
        requestId: "nope",
        response: { kind: "approval", decision: "accept" },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_NOT_FOUND" });
    expect(
      await client.call("threads.respond", {
        threadId: thread.id,
        requestId,
        response: { kind: "approval", decision: "accept" },
      }),
    ).toEqual({ resolved: true });
    await until("agent.turn.completed");

    const types = events.map((event) => event.type);
    expect(types.indexOf("agent.request.resolved")).toBeGreaterThan(
      types.indexOf("agent.request.opened"),
    );
    expect(types).toContain("agent.item.started");
    expect(
      events
        .filter((event) => event.type === "agent.item.completed")
        .map((event) => (event.payload as { text?: string }).text)
        .at(-1),
    ).toBe("Approved and ran rm -rf build");
  });

  it("passes answers to the agent's questions", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const { events, until } = watch(client, thread.id);

    await client.call("threads.send", { threadId: thread.id, text: "/ask" });
    const opened = await until("agent.request.opened");
    await client.call("threads.respond", {
      threadId: thread.id,
      requestId: (opened.payload as { requestId: string }).requestId,
      response: { kind: "user-input", answers: { color: "Blue" } },
    });
    await until("agent.turn.completed");
    expect(
      events
        .filter((event) => event.type === "agent.item.completed")
        .map((event) => (event.payload as { text?: string }).text),
    ).toEqual(["You chose Blue"]);
  });

  it("closes an unanswered request when its turn is interrupted", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const { until } = watch(client, thread.id);

    await client.call("threads.send", { threadId: thread.id, text: "/approve ls" });
    await until("agent.request.opened");
    await client.call("threads.interrupt", { threadId: thread.id });

    expect((await until("agent.request.resolved")).payload).not.toHaveProperty("response");
    await until("agent.turn.interrupted");
  });

  it("closes a turn the node stopped in the middle of, on the next start", async () => {
    const first = await node();
    const thread = await first.client.call<Thread>("threads.create", {});
    // A crash: the record says running, but no end was ever written.
    await first.storage.storage.kv.set("jhin.threads", `thread/${thread.id}`, {
      ...thread,
      lastTurn: { turnId: "t-1", status: "running", at: thread.id, agentId: "jhin.agent-fake" },
    });
    await first.storage.storage.log.append(`thread/${thread.id}`, [
      { type: "agent.turn.started", payload: { turnId: "t-1", agentId: "jhin.agent-fake" } },
    ]);
    await first.stop();

    const second = await node({ storage: first.storage, data: first.data });
    const { until } = watch(second.client, thread.id);
    expect((await until("agent.turn.interrupted")).payload).toMatchObject({ turnId: "t-1" });
    const { thread: after } = await second.client.call<{ thread: Thread }>("threads.get", {
      threadId: thread.id,
    });
    expect(after.lastTurn).toMatchObject({ turnId: "t-1", status: "interrupted" });
  });

  it("closes the requests left open by a turn the node stopped in the middle of", async () => {
    const first = await node();
    const thread = await first.client.call<Thread>("threads.create", {});
    const tool = { name: "Bash", kind: "command", title: "Run command", detail: "make" };
    // A crash while the turn waited: one request answered, one still open.
    await first.storage.storage.kv.set("jhin.threads", `thread/${thread.id}`, {
      ...thread,
      lastTurn: {
        turnId: "t-1",
        status: "waiting",
        at: thread.id,
        agentId: "jhin.agent-fake",
        waitingFor: "approval",
      },
    });
    await first.storage.storage.log.append(`thread/${thread.id}`, [
      { type: "agent.turn.started", payload: { turnId: "t-1", agentId: "jhin.agent-fake" } },
      {
        type: "agent.request.opened",
        payload: { turnId: "t-1", requestId: "r-1", request: { kind: "approval", tool } },
      },
      {
        type: "agent.request.opened",
        payload: { turnId: "t-1", requestId: "r-2", request: { kind: "approval", tool } },
      },
      {
        type: "agent.request.resolved",
        payload: {
          turnId: "t-1",
          requestId: "r-2",
          response: { kind: "approval", decision: "accept" },
        },
      },
    ]);
    await first.stop();

    const second = await node({ storage: first.storage, data: first.data });
    const { events, until } = watch(second.client, thread.id);
    await until("agent.turn.interrupted");
    expect(events.slice(-2).map((event) => [event.type, event.payload])).toEqual([
      ["agent.request.resolved", { turnId: "t-1", requestId: "r-1" }],
      ["agent.turn.interrupted", { turnId: "t-1", reason: "The node stopped while the turn ran" }],
    ]);
  });

  it("accepts image attachments and refuses empty messages", async () => {
    const { client } = await node();
    const thread = await client.call<Thread>("threads.create", {});
    const { until } = watch(client, thread.id);
    const image = {
      kind: "image",
      name: "dot.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    };

    await client.call("threads.send", { threadId: thread.id, text: "", attachments: [image] });
    expect((await until("agent.turn.started")).payload).toMatchObject({
      input: { text: "", attachments: [image] },
    });
    await until("agent.turn.completed");
    await expect(
      client.call("threads.send", { threadId: thread.id, text: "  " }),
    ).rejects.toMatchObject({ code: "MESSAGE_EMPTY" });
    await expect(
      client.call("threads.send", {
        threadId: thread.id,
        text: "x",
        attachments: [{ ...image, dataUrl: "javascript:alert(1)" }],
      }),
    ).rejects.toThrow();
    // Each image fits, but not all of them together.
    const large = { ...image, dataUrl: `data:image/png;base64,${"A".repeat(7 * 1024 * 1024)}` };
    await expect(
      client.call("threads.send", {
        threadId: thread.id,
        text: "x",
        attachments: [large, large, large],
      }),
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  });
});
