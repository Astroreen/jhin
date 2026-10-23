import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  INBOX_STREAM,
  MESSAGES_STREAM,
  MessageEvents,
  ThreadEvents,
  threadStream,
  type AgentMessage,
  type InboxItem,
  type MessageDelivery,
  type TurnRequest,
} from "@jhin/agent-api";
import { createMemoryNetwork, mockCapability, startMeshNode } from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import threads from "@jhin/plugin-threads";
import agents from "../src/index.ts";
import { CAPTURE, NODE_ID, captureRuntime, manifest, node, watch } from "./support.ts";

const builder = { role: "Builds slices", runtime: CAPTURE };
const lead = { role: "Leads the team", runtime: CAPTURE };
const owner = `jhin://${NODE_ID}/owner`;
const address = (agentId: string, nodeId = NODE_ID) => `jhin://${nodeId}/agents/${agentId}`;

interface Sent {
  message: AgentMessage;
  delivery?: MessageDelivery;
}
interface Asked extends Sent {
  status: "answered" | "pending";
  answer?: string;
  answeredBy?: string;
}

/** The turn request a message started, found by the header naming its id. */
const requestOf = (requests: readonly TurnRequest[], messageId: string) =>
  requests.find((request) => request.input.text.includes(`id ${messageId}`));

describe("messages between agents (A2)", () => {
  it("delivers to an agent's first generation, with the sender and trace on the turn", async () => {
    const { client, requests } = await node({ agents: { builder, lead } });
    const log = watch(client, MESSAGES_STREAM);

    const sent = await client.call<Sent>("agents.send", {
      to: address("builder"),
      from: address("lead"),
      body: "Slice 3 is yours.",
    });
    // No generation yet: the message starts the first (D606, D623).
    expect(sent.delivery).toMatchObject({ nodeId: NODE_ID, agentId: "builder", generation: 1 });
    expect(sent.message).toMatchObject({ kind: "message", from: address("lead") });
    expect(sent.message.traceId).not.toBe("");

    const thread = watch(client, threadStream(sent.delivery!.threadId));
    const started = await thread.until(ThreadEvents.turnStarted);
    expect(started.payload).toMatchObject({
      messageId: sent.message.messageId,
      origin: {
        messageId: sent.message.messageId,
        kind: "message",
        from: address("lead"),
        traceId: sent.message.traceId,
      },
    });
    await thread.until(ThreadEvents.turnCompleted);
    const text = requestOf(requests, sent.message.messageId)!.input.text;
    expect(text).toContain(`[Message from ${address("lead")}`);
    expect(text).toContain(`trace ${sent.message.traceId}`);
    expect(text).toContain("Slice 3 is yours.");

    // Recorded where it was delivered, for A7 (D627).
    expect((await log.until(MessageEvents.delivered)).payload).toMatchObject({
      message: { messageId: sent.message.messageId, traceId: sent.message.traceId },
      delivery: { threadId: sent.delivery!.threadId },
    });

    // A retry with the same id delivers nothing again.
    const again = await client.call<Sent>("agents.send", {
      to: address("builder"),
      from: address("lead"),
      body: "Slice 3 is yours.",
      messageId: sent.message.messageId,
    });
    expect(again.message).toEqual(sent.message);
    await expect(
      client.call("agents.send", {
        to: address("builder"),
        from: address("builder"),
        body: "hi",
        messageId: sent.message.messageId,
      }),
    ).rejects.toMatchObject({ code: "MESSAGE_EXISTS" });
  });

  it("queues a message for a busy agent (W1)", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let first = true;
    const { client } = await node({
      agents: { builder },
      capture: {
        gate: () => {
          if (!first) return Promise.resolve();
          first = false;
          return gate;
        },
      },
    });
    const one = await client.call<Sent>("agents.send", { to: address("builder"), body: "one" });
    expect(one.delivery).toMatchObject({ queued: false });
    const thread = watch(client, threadStream(one.delivery!.threadId));
    await thread.until(ThreadEvents.turnStarted);

    const two = await client.call<Sent>("agents.send", { to: address("builder"), body: "two" });
    expect(two.delivery).toMatchObject({ threadId: one.delivery!.threadId, queued: true });
    expect(two.delivery?.turnId).toBeUndefined();
    open();
    const next = await thread.untilMatch(
      (event) =>
        event.type === ThreadEvents.turnStarted &&
        (event.payload as { messageId?: string }).messageId === two.message.messageId,
    );
    // The owner sent it: a caller holding `*` with no thread is the owner (D622).
    expect(next.payload).toMatchObject({ origin: { from: owner } });
  });

  it("answers an ask in a turn of the current generation", async () => {
    const { client } = await node({
      agents: { builder },
      capture: { answer: (request) => `answer to: ${request.input.text.split("\n\n")[1]}` },
    });
    const log = watch(client, MESSAGES_STREAM);
    const asked = await client.call<Asked>("agents.ask", {
      to: address("builder"),
      question: "Is slice 3 done?",
    });
    expect(asked).toMatchObject({
      status: "answered",
      answer: "answer to: Is slice 3 done?",
      answeredBy: address("builder"),
      message: { kind: "ask", from: owner },
      delivery: { agentId: "builder", generation: 1 },
    });
    expect((await log.until(MessageEvents.answered)).payload).toMatchObject({
      messageId: asked.message.messageId,
      traceId: asked.message.traceId,
      answeredBy: address("builder"),
    });
  });

  it("asks an earlier generation in a side turn: the library of minds (D625)", async () => {
    const { client, requests } = await node({ agents: { builder } });
    const first = await client.call<Asked>("agents.ask", { to: address("builder"), question: "a" });
    expect(first.delivery?.generation).toBe(1);
    await client.call("agents.rotate", { agentId: "builder" });

    const asked = await client.call<Asked>("agents.ask", {
      to: address("builder"),
      question: "What did you learn?",
      generation: 1,
    });
    expect(asked).toMatchObject({ status: "answered", answer: "ok", delivery: { generation: 1 } });
    const side = asked.delivery!.threadId;
    expect(side).not.toBe(first.delivery!.threadId);
    // The side turn resumed from generation 1's turns (D102's handover).
    expect(requestOf(requests, asked.message.messageId)?.threadId).toBe(side);

    // Neither generation changed, and the fork stays out of Threads mode (D745).
    const generations = await client.call<{ number: number; threadId: string; current: boolean }[]>(
      "agents.generations",
      { agentId: "builder" },
    );
    expect(generations.map((item) => [item.number, item.current])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(generations.some((item) => item.threadId === side)).toBe(false);
    const { thread } = await client.call<{ thread: { generationOf?: string } }>("threads.get", {
      threadId: side,
    });
    expect(thread.generationOf).toBe("builder");
    const listed = await client.call<{ id: string }[]>("threads.list", {});
    expect(listed.some((item) => item.id === side)).toBe(false);

    await expect(
      client.call("agents.ask", { to: address("builder"), question: "?", generation: 7 }),
    ).rejects.toMatchObject({ code: "GENERATION_NOT_FOUND" });
  });

  it("puts what agents ask the owner in the inbox, and answers wake the asker (D626)", async () => {
    const { client, kernel, requests } = await node({ agents: { builder } });
    const inbox = watch(client, INBOX_STREAM);
    const { generation } = await client.call<{ generation: { threadId: string } }>(
      "agents.rotate",
      { agentId: "builder" },
    );
    // The agent asks through its MCP credential: bound to its generation's thread.
    const asked = (await kernel.commands.execute(
      "agents.ask",
      { to: owner, question: "May I delete the old API?" },
      {
        traceId: "trace-1",
        caller: { id: "jhin.agent-claude:x", permissions: ["agents.message", "agents.read"] },
        threadId: generation.threadId,
      },
    )) as Asked;
    expect(asked).toMatchObject({
      status: "pending",
      message: { kind: "ask", from: address("builder"), to: owner, traceId: "trace-1" },
    });
    expect(asked.delivery).toBeUndefined();
    expect((await inbox.until(MessageEvents.received)).payload).toMatchObject({ status: "open" });

    const open = await client.call<{ head: number; items: InboxItem[] }>("agents.inbox.list", {});
    expect(open.items.map((item) => item.message.messageId)).toEqual([asked.message.messageId]);
    expect(open.head).toBe(1);

    const thread = watch(client, threadStream(generation.threadId));
    const answered = await client.call<{ item: InboxItem; message: AgentMessage }>(
      "agents.inbox.answer",
      { messageId: asked.message.messageId, answer: "Yes, after the release." },
    );
    expect(answered.item).toMatchObject({ status: "answered", answer: "Yes, after the release." });
    expect(answered.message).toMatchObject({
      kind: "answer",
      from: owner,
      to: address("builder"),
      inReplyTo: asked.message.messageId,
    });
    await thread.untilMatch(
      (event) =>
        event.type === ThreadEvents.turnStarted &&
        (event.payload as { messageId?: string }).messageId === answered.message.messageId,
    );
    expect(requestOf(requests, answered.message.messageId)?.input.text).toContain(
      "Yes, after the release.",
    );

    expect((await client.call<{ items: InboxItem[] }>("agents.inbox.list", {})).items).toHaveLength(
      0,
    );
    await expect(
      client.call("agents.inbox.answer", { messageId: asked.message.messageId, answer: "again" }),
    ).rejects.toMatchObject({ code: "ASK_ANSWERED" });
    await expect(
      client.call("agents.inbox.answer", { messageId: "nope", answer: "x" }),
    ).rejects.toMatchObject({ code: "ASK_NOT_FOUND" });
  });

  it("dismisses an inbox item: an ask's sender is told, a message's is not (D1274)", async () => {
    const { client, kernel, requests } = await node({ agents: { builder } });
    const { generation } = await client.call<{ generation: { threadId: string } }>(
      "agents.rotate",
      { agentId: "builder" },
    );
    const caller = { id: "jhin.agent-claude:x", permissions: ["agents.message", "agents.read"] };
    const asked = (await kernel.commands.execute(
      "agents.ask",
      { to: owner, question: "May I delete the old API?" },
      { traceId: "trace-1", caller, threadId: generation.threadId },
    )) as Asked;
    const told = (await kernel.commands.execute(
      "agents.send",
      { to: owner, body: "Mission report." },
      { traceId: "trace-2", caller, threadId: generation.threadId },
    )) as Sent;

    const thread = watch(client, threadStream(generation.threadId));
    const dismissed = await client.call<{ item: InboxItem; message?: AgentMessage }>(
      "agents.inbox.dismiss",
      { messageId: asked.message.messageId },
    );
    expect(dismissed.item).toMatchObject({ status: "dismissed" });
    expect(dismissed.message).toMatchObject({
      kind: "answer",
      from: owner,
      to: address("builder"),
      inReplyTo: asked.message.messageId,
    });
    await thread.untilMatch(
      (event) =>
        event.type === ThreadEvents.turnStarted &&
        (event.payload as { messageId?: string }).messageId === dismissed.message!.messageId,
    );
    expect(requestOf(requests, dismissed.message!.messageId)?.input.text).toContain("dismissed");

    const plain = await client.call<{ item: InboxItem; message?: AgentMessage }>(
      "agents.inbox.dismiss",
      { messageId: told.message.messageId },
    );
    expect(plain.item.status).toBe("dismissed");
    expect(plain.message).toBeUndefined();

    expect((await client.call<{ items: InboxItem[] }>("agents.inbox.list", {})).items).toHaveLength(
      0,
    );
    const all = await client.call<{ items: InboxItem[] }>("agents.inbox.list", {
      status: "dismissed",
    });
    expect(all.items).toHaveLength(2);
    await expect(
      client.call("agents.inbox.dismiss", { messageId: asked.message.messageId }),
    ).rejects.toMatchObject({ code: "ITEM_CLOSED" });
    await expect(
      client.call("agents.inbox.answer", { messageId: asked.message.messageId, answer: "x" }),
    ).rejects.toMatchObject({ code: "ITEM_CLOSED" });
  });

  it("keeps the owner's conversation with an agent, answers included (C1, D1061, D1221)", async () => {
    const { client, kernel } = await node({
      agents: { builder, lead },
      capture: { answer: (request) => `answer to: ${request.input.text.split("\n\n")[1]}` },
    });
    const asked = await client.call<Asked>("agents.ask", {
      to: address("lead"),
      question: "Where are we?",
    });
    const messages = watch(client, MESSAGES_STREAM);
    const sent = await client.call<Sent>("agents.send", { to: address("lead"), body: "Go on." });
    // The turn the owner's message started answers the owner (D1221).
    await messages.untilMatch(
      (event) =>
        event.type === MessageEvents.answered &&
        (event.payload as { messageId?: string }).messageId === sent.message.messageId,
    );
    const { generation } = await client.call<{ generation: { threadId: string } }>(
      "agents.rotate",
      { agentId: "lead" },
    );
    const asAgent = (agentThread: string) => ({
      caller: { id: "jhin.agent-claude:x", permissions: ["agents.message", "agents.read"] },
      threadId: agentThread,
    });
    const escalated = (await kernel.commands.execute(
      "agents.ask",
      { to: owner, question: "May I drop slice 4?" },
      asAgent(generation.threadId),
    )) as Asked;
    // Someone else's message to the owner is not part of it.
    await client.call("agents.send", { to: owner, from: address("builder"), body: "Hi." });

    interface Conversation {
      head: number;
      owner: string;
      with: string;
      entries: { message: AgentMessage; answer?: string; answeredBy?: string; inbox?: string }[];
    }
    const read = () => client.call<Conversation>("agents.conversation", { with: address("lead") });
    const before = await read();
    expect(before).toMatchObject({ owner, with: address("lead") });
    expect(before.entries.map((entry) => entry.message.messageId)).toEqual([
      asked.message.messageId,
      sent.message.messageId,
      escalated.message.messageId,
    ]);
    expect(before.entries[0]).toMatchObject({
      answer: "answer to: Where are we?",
      answeredBy: address("lead"),
    });
    expect(before.entries[1]).toMatchObject({
      answer: "answer to: Go on.",
      answeredBy: address("lead"),
    });
    expect(before.entries[2]).toMatchObject({ inbox: "open" });
    expect(before.entries[2]!.answer).toBeUndefined();

    const reply = await client.call<{ message: AgentMessage }>("agents.inbox.answer", {
      messageId: escalated.message.messageId,
      answer: "Yes.",
    });
    const after = await read();
    expect(after.head).toBeGreaterThan(before.head);
    expect(after.entries[2]).toMatchObject({
      inbox: "answered",
      answer: "Yes.",
      answeredBy: owner,
    });
    expect(after.entries.at(-1)?.message).toMatchObject({
      messageId: reply.message.messageId,
      kind: "answer",
      inReplyTo: escalated.message.messageId,
    });
    // It shows the owner's inbox: a caller without agents.inbox, as an agent is, may not read it.
    await expect(
      kernel.commands.execute(
        "agents.conversation",
        { with: address("lead") },
        { caller: { id: "jhin.agent-claude:x", permissions: ["agents.message", "agents.read"] } },
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    const last = await client.call<Conversation>("agents.conversation", {
      with: address("lead"),
      limit: 1,
    });
    expect(last.entries.map((entry) => entry.message.messageId)).toEqual([reply.message.messageId]);
  });

  it("records an answer to the owner's message once, and none for a silent turn (D1221)", async () => {
    const { client } = await node({
      agents: { lead },
      capture: {
        answer: (request) => {
          const text = request.input.text.split("\n\n")[1] ?? "";
          return text === "Quiet." ? "" : `answer to: ${text}`;
        },
      },
    });
    const messages = watch(client, MESSAGES_STREAM);
    const answeredFor = (messageId: string) =>
      messages.untilMatch(
        (event) =>
          event.type === MessageEvents.answered &&
          (event.payload as { messageId?: string }).messageId === messageId,
      );
    const send = (body: string, messageId?: string) =>
      client.call<Sent>("agents.send", {
        to: address("lead"),
        body,
        ...(messageId === undefined ? {} : { messageId }),
      });
    const first = await send("Go on.");
    expect((await answeredFor(first.message.messageId)).payload).toMatchObject({
      answer: "answer to: Go on.",
      answeredBy: address("lead"),
    });
    // A retry of the same message is delivered once and followed once.
    await send("Go on.", first.message.messageId);
    const quiet = await send("Quiet.");
    // Turns run one after another: once the last one's answer is recorded, the
    // silent turn before it has ended, and so has anything the retry followed.
    const last = await send("Last.");
    await answeredFor(last.message.messageId);
    const answered = messages.events
      .filter((event) => event.type === MessageEvents.answered)
      .map((event) => (event.payload as { messageId: string }).messageId);
    expect(answered).toEqual([first.message.messageId, last.message.messageId]);
    expect(answered).not.toContain(quiet.message.messageId);
  });

  it("lets a caller send only as who it is (D622) and refuses what cannot take messages", async () => {
    const { client, kernel } = await node({ agents: { builder, lead } });
    const { generation } = await client.call<{ generation: { threadId: string } }>(
      "agents.rotate",
      { agentId: "builder" },
    );
    const asAgent = {
      caller: { id: "jhin.agent-claude:x", permissions: ["agents.message"] },
      threadId: generation.threadId,
    };
    await expect(
      kernel.commands.execute(
        "agents.send",
        { to: address("lead"), from: address("lead"), body: "hi" },
        asAgent,
      ),
    ).rejects.toMatchObject({ code: "SENDER_MISMATCH", details: { expected: address("builder") } });
    const device = { caller: { id: "device-1", permissions: ["agents.message"] } };
    await expect(
      kernel.commands.execute(
        "agents.send",
        { to: address("lead"), from: address("builder"), body: "hi" },
        device,
      ),
    ).rejects.toMatchObject({ code: "SENDER_MISMATCH", details: { expected: owner } });
    // An agent never holds the owner's inbox (D628).
    await expect(kernel.commands.execute("agents.inbox.list", {}, asAgent)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });

    await expect(
      client.call("agents.send", { to: "jhin://node-a/projects/p", body: "hi" }),
    ).rejects.toMatchObject({ code: "ADDRESS_INVALID" });
    await expect(
      client.call("agents.send", { to: address("jhin.agent-fake"), body: "hi" }),
    ).rejects.toMatchObject({ code: "AGENT_IS_RUNTIME" });
    await expect(
      client.call("agents.send", { to: address("ghost"), body: "hi" }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    await client.call("agents.stop", { agentId: "lead" });
    await expect(
      client.call("agents.send", { to: address("lead"), body: "hi" }),
    ).rejects.toMatchObject({ code: "AGENT_STOPPED" });
  });
});

describe("messages across the mesh (D623)", () => {
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop();
  });

  const meshNode = async (network: ReturnType<typeof createMemoryNetwork>, id: string) => {
    const data = Fs.mkdtempSync(Path.join(Os.tmpdir(), `jhin-messages-${id}-`));
    const requests: TurnRequest[] = [];
    const started = await startMeshNode(network, id, {
      config: {
        node: {
          "jhin.threads": { defaultAgent: CAPTURE },
          "jhin.agents": { agents: { builder, lead } },
        },
      },
      plugins: [
        mockCapability("host.paths", {
          home: data,
          dataDir: (plugin: string) => {
            Fs.mkdirSync(Path.join(data, plugin), { recursive: true });
            return Path.join(data, plugin);
          },
        }),
        mockCapability("host.identity", { nodeId: id }),
        { manifest: manifest("threads"), definition: threads },
        captureRuntime(requests, { answer: (request) => `${id} says ok to ${request.threadId}` }),
        { manifest: manifest("agents"), definition: agents },
      ],
    });
    stops.push(() => started.stop());
    return { node: started, requests };
  };

  it("sends and asks an agent of another node, which sees who sent it and the trace", async () => {
    const network = createMemoryNetwork();
    const a = await meshNode(network, "a");
    const b = await meshNode(network, "b");
    await b.node.join(a.node);

    // The lead on node a asks the builder on node b.
    const { generation } = (await a.node.kernel.commands.execute("agents.rotate", {
      agentId: "lead",
    })) as { generation: { threadId: string } };
    const asLead = {
      traceId: "trace-mesh",
      caller: { id: "jhin.agent-claude:lead", permissions: ["agents.message"] },
      threadId: generation.threadId,
    };
    const asked = (await a.node.kernel.commands.execute(
      "agents.ask",
      { to: address("builder", "b"), question: "Ready?" },
      asLead,
    )) as Asked;
    expect(asked).toMatchObject({
      status: "answered",
      answeredBy: address("builder", "b"),
      message: { from: address("lead", "a"), traceId: "trace-mesh" },
      delivery: { nodeId: "b", agentId: "builder", generation: 1 },
    });
    expect(asked.answer).toBe(`b says ok to ${asked.delivery!.threadId}`);
    const delivered = await b.node.log.read(MESSAGES_STREAM);
    expect(delivered[0]?.payload).toMatchObject({
      message: { messageId: asked.message.messageId, from: address("lead", "a") },
    });

    // A member speaks only for its own parties.
    await expect(
      b.node.kernel.commands.execute(
        "agents.send",
        { to: address("builder", "b"), from: address("lead", "c"), body: "hi" },
        { caller: { id: "node:a", permissions: ["agents.message"] } },
      ),
    ).rejects.toMatchObject({ code: "SENDER_MISMATCH" });

    // The owner of node a sends to the builder on b: the answer from b's inbox goes back.
    const toOwner = (await b.node.kernel.commands.execute(
      "agents.ask",
      { to: "jhin://a/owner", question: "Merge?" },
      {
        caller: { id: "jhin.agent-claude:b", permissions: ["agents.message"] },
        threadId: asked.delivery!.threadId,
      },
    )) as Asked;
    expect(toOwner).toMatchObject({
      status: "pending",
      message: { from: address("builder", "b") },
    });
    const inbox = (await a.node.kernel.commands.execute("agents.inbox.list", {})) as {
      items: InboxItem[];
    };
    expect(inbox.items.map((item) => item.message.messageId)).toEqual([toOwner.message.messageId]);
    const reply = (await a.node.kernel.commands.execute("agents.inbox.answer", {
      messageId: toOwner.message.messageId,
      answer: "Merge.",
    })) as { message: AgentMessage; delivery?: MessageDelivery };
    expect(reply.delivery).toMatchObject({ nodeId: "b", threadId: asked.delivery!.threadId });
    expect(reply.message).toMatchObject({ from: "jhin://a/owner", kind: "answer" });
  });
});
