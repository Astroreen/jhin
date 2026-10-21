import * as Fs from "node:fs";
import * as Path from "node:path";

import { AGENTS_STREAM, AgentEvents, ThreadEvents, threadStream } from "@jhin/agent-api";
import { describe, expect, it } from "vite-plus/test";

import { CAPTURE, NODE_ID, node, watch } from "./support.ts";

const builder = { role: "Builds slices and proves them", runtime: CAPTURE, model: "m1" };

describe("defined agents", () => {
  it("defines an agent in the node file and reports it everywhere", async () => {
    const { client, layers } = await node();
    const stream = watch(client, AGENTS_STREAM);

    const record = await client.call<{ agentId: string; address: string; layer?: string }>(
      "agents.define",
      { agentId: "builder", title: "Builder", ...builder },
    );
    expect(record).toMatchObject({
      agentId: "builder",
      address: `jhin://${NODE_ID}/agents/builder`,
      kind: "defined",
      title: "Builder",
      runtimeId: CAPTURE,
      projectId: "scratch",
      generations: [],
      layer: "node",
    });
    expect(layers["node"]?.["jhin.agents"]).toEqual({
      agents: { builder: { title: "Builder", ...builder } },
    });
    expect((await stream.until(AgentEvents.defined)).payload).toMatchObject({ agentId: "builder" });

    // agents.list stays compatible and grows (D610).
    const list =
      await client.call<{ agentId: string; kind: string; runtimeId: string }[]>("agents.list");
    expect(list.find((agent) => agent.agentId === "builder")).toMatchObject({
      kind: "defined",
      runtimeId: CAPTURE,
      role: builder.role,
      name: "Builder",
      default: false,
    });
    expect(list.find((agent) => agent.agentId === "jhin.agent-fake")).toMatchObject({
      kind: "runtime",
      runtimeId: "jhin.agent-fake",
      default: true,
    });

    // By its address too; another node's address is that node's business (D603).
    expect(
      await client.call("agents.get", { agentId: `jhin://${NODE_ID}/agents/builder` }),
    ).toMatchObject({ agentId: "builder", status: "idle" });
    await expect(
      client.call("agents.get", { agentId: "jhin://node-b/agents/builder" }),
    ).rejects.toMatchObject({ code: "AGENT_ELSEWHERE" });
    // A runtime is the implicit agent of its id (D601).
    expect(await client.call("agents.get", { agentId: "jhin.agent-fake" })).toMatchObject({
      kind: "runtime",
      runtimeId: "jhin.agent-fake",
      generations: [],
    });
  });

  it("refuses ids that are taken", async () => {
    const { client } = await node({ agents: { builder } });
    await expect(
      client.call("agents.define", { agentId: "builder", ...builder }),
    ).rejects.toMatchObject({ code: "AGENT_EXISTS" });
    await expect(
      client.call("agents.update", { agentId: "jhin.agent-fake", role: "x" }),
    ).rejects.toMatchObject({ code: "AGENT_IS_RUNTIME" });
    await expect(
      client.call("agents.rotate", { agentId: "jhin.agent-fake" }),
    ).rejects.toMatchObject({ code: "AGENT_IS_RUNTIME" });
  });

  it("runs a generation's turns on its runtime with its role and knowledge", async () => {
    const { client, requests } = await node({ agents: { builder } });
    const rotated = await client.call<{ generation: { number: number; threadId: string } }>(
      "agents.rotate",
      { agentId: "builder", reason: "first" },
    );
    expect(rotated.generation).toMatchObject({ number: 1, reason: "first" });
    const { thread } = await client.call<{
      thread: { title: string; agentId: string; projectId: string; generationOf?: string };
    }>("threads.get", { threadId: rotated.generation.threadId });
    expect(thread).toMatchObject({
      title: "builder #1",
      agentId: "builder",
      projectId: "scratch",
      // The D741 mark: Threads mode leaves the thread out of its lists.
      generationOf: "builder",
    });

    // A rename leaves the mark as it is: it is set once.
    const renamed = await client.call<{ generationOf?: string }>("threads.update", {
      threadId: rotated.generation.threadId,
      title: "Renamed",
    });
    expect(renamed.generationOf).toBe("builder");

    const record = await client.call<{ knowledgeDir: string }>("agents.get", {
      agentId: "builder",
    });
    expect(Fs.statSync(record.knowledgeDir).isDirectory()).toBe(true);
    Fs.writeFileSync(Path.join(record.knowledgeDir, "b.md"), "Run the smallest proof.\n");
    Fs.writeFileSync(Path.join(record.knowledgeDir, "a.md"), "The map comes first.\n");
    Fs.writeFileSync(Path.join(record.knowledgeDir, "notes.txt"), "not knowledge");

    const threadEvents = watch(client, threadStream(rotated.generation.threadId));
    await client.call("threads.send", { threadId: rotated.generation.threadId, text: "Go" });
    const started = await threadEvents.until(ThreadEvents.turnStarted);
    // The turn names the agent and the runtime it ran on (D601); the input stays the owner's.
    expect(started.payload).toMatchObject({
      agentId: "builder",
      runtimeId: CAPTURE,
      input: { text: "Go" },
    });
    await threadEvents.until(ThreadEvents.turnCompleted);

    const [first] = requests;
    expect(first?.model).toBe("m1");
    expect(first?.instructions).toContain(`jhin://${NODE_ID}/agents/builder`);
    expect(first?.instructions).toContain("generation 1");
    expect(first?.instructions).toContain(builder.role);
    // Knowledge first, by file name; only Markdown (D607).
    const text = first?.input.text ?? "";
    expect(text.indexOf("The map comes first.")).toBeLessThan(text.indexOf("smallest proof"));
    expect(text).not.toContain("not knowledge");
    expect(text.endsWith("Go")).toBe(true);

    // Later turns of the generation get no second copy.
    await client.call("threads.send", { threadId: rotated.generation.threadId, text: "Again" });
    await threadEvents.until(ThreadEvents.turnCompleted, 1);
    expect(requests[1]?.input.text).toBe("Again");
  });

  it("rotates to a new generation and keeps the earlier ones readable", async () => {
    const { client } = await node({ agents: { builder } });
    const stream = watch(client, AGENTS_STREAM);
    const one = await client.call<{ generation: { threadId: string } }>("agents.rotate", {
      agentId: "builder",
    });
    const two = await client.call<{
      generation: { number: number; threadId: string };
      previous: { number: number };
    }>("agents.rotate", { agentId: "builder", reason: "context spent" });
    expect(two.generation.number).toBe(2);
    expect(two.previous.number).toBe(1);
    expect(
      (
        await stream.untilMatch(
          (event) =>
            event.type === AgentEvents.generationStarted &&
            (event.payload as { generation: { number: number } }).generation.number === 2,
        )
      ).payload,
    ).toMatchObject({ agentId: "builder", previous: { number: 1 } });

    const generations = await client.call<{ number: number; current: boolean; status: string }[]>(
      "agents.generations",
      { agentId: "builder" },
    );
    expect(generations.map(({ number, current, status }) => ({ number, current, status }))).toEqual(
      [
        { number: 1, current: false, status: "idle" },
        { number: 2, current: true, status: "idle" },
      ],
    );
    // The previous generation is untouched: not archived.
    const { thread } = await client.call<{ thread: { archivedAt?: string } }>("threads.get", {
      threadId: one.generation.threadId,
    });
    expect(thread.archivedAt).toBeUndefined();
  });

  it("stops and resumes an agent", async () => {
    const { client } = await node({ agents: { builder } });
    const { generation } = await client.call<{ generation: { threadId: string } }>(
      "agents.rotate",
      { agentId: "builder" },
    );
    const stopped = await client.call<{ stoppedAt: string; interrupted: boolean }>("agents.stop", {
      agentId: "builder",
    });
    expect(stopped.interrupted).toBe(false);
    expect(await client.call("agents.get", { agentId: "builder" })).toMatchObject({
      status: "stopped",
      stoppedAt: stopped.stoppedAt,
    });
    await expect(client.call("agents.rotate", { agentId: "builder" })).rejects.toMatchObject({
      code: "AGENT_STOPPED",
    });
    // A turn on the stopped agent's generation fails instead of running (D612).
    const events = watch(client, threadStream(generation.threadId));
    await expect(
      client.call("threads.send", { threadId: generation.threadId, text: "Go" }),
    ).rejects.toMatchObject({ code: "AGENT_STOPPED" });
    expect((await events.until(ThreadEvents.turnFailed)).payload).toMatchObject({
      error: expect.stringContaining("stopped"),
    });

    expect(await client.call("agents.resume", { agentId: "builder" })).toEqual({ resumed: true });
    expect(await client.call("agents.resume", { agentId: "builder" })).toEqual({ resumed: false });
    expect(await client.call("agents.get", { agentId: "builder" })).toMatchObject({
      status: "idle",
    });
  });

  it("follows the config: updates, clears fields and removes, keeping generations", async () => {
    const { client, layers } = await node({ agents: { builder } });
    const stream = watch(client, AGENTS_STREAM);
    await client.call("agents.rotate", { agentId: "builder" });

    const updated = await client.call<{ role: string; model?: string }>("agents.update", {
      agentId: "builder",
      role: "Reviews",
      unset: ["model"],
    });
    expect(updated.role).toBe("Reviews");
    expect(updated.model).toBeUndefined();
    expect(
      (
        await stream.untilMatch(
          (event) =>
            event.type === AgentEvents.updated &&
            (event.payload as { role?: string }).role === "Reviews",
        )
      ).payload,
    ).toMatchObject({ agentId: "builder" });

    expect(await client.call("agents.remove", { agentId: "builder" })).toEqual({ removed: true });
    expect(layers["node"]?.["jhin.agents"]).toEqual({ agents: {} });
    await stream.until(AgentEvents.removed);
    expect((await client.call<{ agents: unknown[] }>("agents.catalog")).agents).toEqual([]);
    expect(
      (await client.call<{ agentId: string }[]>("agents.list")).some(
        (agent) => agent.agentId === "builder",
      ),
    ).toBe(false);
    // Its generations stay readable, and defining it again continues them (D611).
    expect(await client.call<unknown[]>("agents.generations", { agentId: "builder" })).toHaveLength(
      1,
    );
    await client.call("agents.define", { agentId: "builder", ...builder });
    const next = await client.call<{ generation: { number: number } }>("agents.rotate", {
      agentId: "builder",
    });
    expect(next.generation.number).toBe(2);
  });

  it("refuses a generation whose home project is not on the node", async () => {
    const { client } = await node({ agents: { builder: { ...builder, project: "/nowhere" } } });
    expect(await client.call("agents.get", { agentId: "builder" })).toMatchObject({
      status: "unavailable",
    });
    await expect(client.call("agents.rotate", { agentId: "builder" })).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
  });

  it("keeps a node's default agent a runtime", async () => {
    const { client } = await node({ agents: { builder }, defaultAgent: null });
    const list = await client.call<{ agentId: string; default: boolean }[]>("agents.list");
    expect(list.find((agent) => agent.default)?.agentId).not.toBe("builder");
    const { id } = await client.call<{ id: string }>("threads.create", {});
    const events = watch(client, threadStream(id));
    await client.call("threads.send", { threadId: id, text: "hi" });
    const started = await events.until(ThreadEvents.turnStarted);
    expect((started.payload as { agentId: string }).agentId).not.toBe("builder");
    expect(started.payload).not.toHaveProperty("runtimeId");
  });
});
