// Messaging between agents, and the owner (docs/plans/agents.md, A2: D621–D629):
// `agents.send` and `agents.ask` deliver through W1's thread queue, on this
// node or another one (`mesh.call`); messages to the owner go to the inbox.
import * as Crypto from "node:crypto";

import {
  INBOX_PERMISSION,
  INBOX_STREAM,
  MESSAGE_PERMISSION,
  MESSAGES_STREAM,
  MessageCommands,
  MessageEvents,
  ThreadEvents,
  agentAddress,
  messageText,
  ownerAddress,
  parseMessageAddress,
  parseTeamAlias,
  threadAddress,
  threadStream,
  type AgentGeneration,
  type AgentMessage,
  type ConversationEntry,
  type InboxItem,
  type MessageDelivery,
  type MessageOrigin,
  type MessageParty,
} from "@jhin/agent-api";
import { LIVE_STREAMS_CAPABILITY, type LiveStreams } from "@jhin/rpc";
import { describePermissions, type Invocation, type PluginContext } from "@jhin/sdk";
import type { EventLog, Json, KeyValueStore, StoredEvent } from "@jhin/storage-api";

import { AgentsError } from "./errors.ts";

const NAMESPACE = "jhin.agents";

/** What the node keeps of a message it delivered, by id, so a retry delivers it once (D621). */
interface Delivered {
  readonly message: AgentMessage;
  readonly delivery?: MessageDelivery;
}

interface AgentView {
  readonly kind: "defined" | "runtime";
  readonly title: string;
  readonly generations: readonly AgentGeneration[];
  readonly stoppedAt?: string;
}

const originOf = ({ messageId, kind, from, traceId, inReplyTo }: AgentMessage): MessageOrigin => ({
  messageId,
  kind,
  from,
  traceId,
  ...(inReplyTo === undefined ? {} : { inReplyTo }),
});

/**
 * The answer a turn gave: its last assistant message once it completed;
 * `undefined` for a failed, interrupted or silent turn (D624).
 */
function answerOfTurn(events: readonly StoredEvent[], turnId: string): string | undefined {
  let last: string | undefined;
  for (const event of events) {
    const payload = event.payload as { turnId?: unknown; kind?: unknown; text?: unknown } | null;
    if (payload?.turnId !== turnId) continue;
    if (
      event.type === ThreadEvents.itemCompleted &&
      payload.kind === "message" &&
      typeof payload.text === "string" &&
      payload.text.trim() !== ""
    ) {
      last = payload.text;
    }
  }
  return last;
}

export function registerMessaging(
  context: PluginContext,
  { nodeId, kv, log }: { nodeId: string; kv: KeyValueStore; log: EventLog },
): void {
  const now = () => new Date().toISOString();
  const run = <T>(name: string, input: unknown) =>
    context.commands.execute(name, input) as Promise<T>;

  // Following the streams takes what reading through the commands takes (security.md D415).
  const live = context.services.tryGet<LiveStreams>(LIVE_STREAMS_CAPABILITY);
  if (live?.guard !== undefined) {
    context.subscriptions.add(live.guard(MESSAGES_STREAM, ["agents.read"]));
    context.subscriptions.add(live.guard(INBOX_STREAM, [INBOX_PERMISSION]));
  }
  describePermissions(context, {
    [MESSAGE_PERMISSION]: {
      title: "Message agents",
      description: "Send messages to agents and the owner, and ask them questions.",
    },
    [INBOX_PERMISSION]: {
      title: "Owner's inbox",
      description: "Read what agents ask the owner, and answer for the owner.",
    },
  });

  /** Turns followed for their answer (D624, D1221): they stop following with the plugin. */
  const following = new Set<() => void>();
  context.subscriptions.add({
    dispose: () => {
      for (const stop of following) stop();
    },
  });

  /** One delivery at a time: a first message rotates an agent once, a retry finds the record. */
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);
    return result;
  };

  const partyOf = (address: string, field: "to" | "from"): MessageParty => {
    const party = parseMessageAddress(address);
    if (party === undefined) {
      throw new AgentsError(
        "ADDRESS_INVALID",
        `${address} is not an agent's, an owner's or a thread's address`,
        { [field]: address },
      );
    }
    return party;
  };

  /**
   * An alias `<member>@<team>` stands for its member's full address (A5,
   * D687), resolved by `teams.resolve` on a node that has it.
   */
  const addressOf = async (to: string): Promise<string> => {
    if (parseTeamAlias(to) === undefined) return to;
    if (!context.commands.list().some((command) => command.name === "teams.resolve")) return to;
    return (await run<{ address: string }>("teams.resolve", { alias: to })).address;
  };

  /** The party a thread's agent is: its agent for a generation, else the thread (D622). */
  const threadSender = async (threadId: string): Promise<string> => {
    const { thread } = await run<{ thread: { generationOf?: string } }>("threads.get", {
      threadId,
    });
    return thread.generationOf === undefined
      ? threadAddress(nodeId, threadId)
      : agentAddress(nodeId, thread.generationOf);
  };

  /** Who the caller sends as (D622). */
  async function senderOf(given: string | undefined, invocation: Invocation): Promise<string> {
    if (given !== undefined) partyOf(given, "from");
    const refuse = (expected: string) =>
      new AgentsError("SENDER_MISMATCH", `This caller sends as ${expected}, not ${given}`, {
        expected,
        from: given,
      });
    const caller = invocation.caller;
    if (caller?.id.startsWith("node:") === true) {
      const origin = caller.id.slice("node:".length);
      if (given === undefined) return ownerAddress(origin);
      if (partyOf(given, "from").nodeId !== origin) throw refuse(`a party of node ${origin}`);
      return given;
    }
    if (invocation.threadId !== undefined) {
      const self = await threadSender(invocation.threadId);
      if (given !== undefined && given !== self) throw refuse(self);
      return self;
    }
    const owner = ownerAddress(nodeId);
    if (caller === undefined || caller.permissions.includes("*")) return given ?? owner;
    if (given !== undefined && given !== owner) throw refuse(owner);
    return owner;
  }

  /**
   * Runs the same command on the recipient's node (D623). It goes with no
   * more than messaging: the caller here already held it.
   */
  const forward = <T>(node: string, method: string, params: unknown, invocation: Invocation) =>
    context.commands.execute(
      "mesh.call",
      { node, method, params },
      {
        ...(invocation.traceId === undefined ? {} : { traceId: invocation.traceId }),
        caller: {
          id: invocation.caller?.id ?? context.plugin.id,
          permissions: ["mesh.call", MESSAGE_PERMISSION],
        },
      },
    ) as Promise<T>;

  /** The thread an agent of this node takes a message in (D623, D625). */
  async function agentThread(
    agentId: string,
    asked: number | undefined,
  ): Promise<{ threadId: string; generation: number }> {
    const agent = await run<AgentView>("agents.get", { agentId });
    if (agent.kind === "runtime") {
      throw new AgentsError(
        "AGENT_IS_RUNTIME",
        `${agentId} is a runtime: it has no generation to take messages`,
        { agentId },
      );
    }
    if (agent.stoppedAt !== undefined) {
      throw new AgentsError("AGENT_STOPPED", `The agent ${agentId} is stopped`, { agentId });
    }
    const current = agent.generations.at(-1);
    if (asked !== undefined && asked !== current?.number) {
      const generation = agent.generations.find((item) => item.number === asked);
      if (generation === undefined) {
        throw new AgentsError("GENERATION_NOT_FOUND", `${agentId} has no generation ${asked}`, {
          agentId,
          generation: asked,
        });
      }
      // A side turn: a fork of the dormant generation, which stays as it is (D625).
      const fork = await run<{ id: string }>("threads.fork", {
        threadId: generation.threadId,
        title: `${agent.title} #${asked}, asked`,
      }).catch((error: unknown) => {
        if ((error as { code?: unknown }).code !== "TURN_NOT_FOUND") throw error;
        throw new AgentsError(
          "NO_ANSWER",
          `Generation ${asked} of ${agentId} has no ended turn to answer from`,
          { agentId, generation: asked },
        );
      });
      return { threadId: fork.id, generation: asked };
    }
    if (current !== undefined) return { threadId: current.threadId, generation: current.number };
    // No generation yet: work arriving starts the first one (D606).
    const { generation } = await run<{ generation: AgentGeneration }>("agents.rotate", {
      agentId,
      reason: "message",
    });
    return { threadId: generation.threadId, generation: generation.number };
  }

  /**
   * Delivers a message to its recipient on this node, once per id (D623,
   * D626, D627); `fresh` when this call delivered it, not a retry.
   */
  const deliverHere = (message: AgentMessage): Promise<Delivered & { fresh?: boolean }> =>
    serial(async () => {
      const key = `message/${message.messageId}`;
      const seen = (await kv.get(NAMESPACE, key)) as Delivered | undefined;
      if (seen !== undefined) {
        if (seen.message.from !== message.from || seen.message.to !== message.to) {
          throw new AgentsError(
            "MESSAGE_EXISTS",
            `A message ${message.messageId} was sent already`,
            { messageId: message.messageId },
          );
        }
        return seen;
      }
      const to = partyOf(message.to, "to");
      let delivery: MessageDelivery | undefined;
      if (to.kind === "owner") {
        const item: InboxItem = { message, status: "open" };
        await log.append(INBOX_STREAM, [
          { type: MessageEvents.received, payload: item as unknown as Json },
        ]);
      } else {
        const target =
          to.kind === "agent"
            ? { agentId: to.agentId, ...(await agentThread(to.agentId, message.generation)) }
            : { threadId: to.threadId };
        const sent = await run<{ turnId?: string }>("threads.queue.add", {
          threadId: target.threadId,
          text: messageText(message),
          messageId: message.messageId,
          origin: originOf(message),
        });
        delivery = {
          nodeId,
          ...target,
          ...(sent.turnId === undefined ? {} : { turnId: sent.turnId }),
          queued: sent.turnId === undefined,
        };
      }
      const delivered: Delivered = { message, ...(delivery === undefined ? {} : { delivery }) };
      await kv.set(NAMESPACE, key, delivered as unknown as Json);
      await log.append(MESSAGES_STREAM, [
        { type: MessageEvents.delivered, payload: delivered as unknown as Json },
      ]);
      return { ...delivered, fresh: true };
    });

  /**
   * The answer of the turn a message started in a thread (D624): followed
   * from the thread's stream, read once as well for what came before.
   */
  const answerIn = (threadId: string, messageId: string): Promise<string | undefined> =>
    new Promise((resolve) => {
      const stream = threadStream(threadId);
      const events: StoredEvent[] = [];
      let last = 0;
      let turnId: string | undefined;
      let done = false;
      const consider = (event: StoredEvent) => {
        if (done || event.sequence <= last) return;
        last = event.sequence;
        events.push(event);
        const payload = event.payload as {
          turnId?: string;
          messageId?: string;
          inheritedAt?: string;
        } | null;
        // A fork's copies of its parent's turns are none of this message's.
        if (payload === null || payload.inheritedAt !== undefined) return;
        if (event.type === ThreadEvents.turnStarted && payload.messageId === messageId) {
          turnId = payload.turnId;
        }
        if (turnId === undefined || payload.turnId !== turnId) return;
        if (event.type === ThreadEvents.turnCompleted) finish(answerOfTurn(events, turnId));
        if (event.type === ThreadEvents.turnFailed || event.type === ThreadEvents.turnInterrupted) {
          finish(undefined);
        }
      };
      const pending: StoredEvent[] = [];
      let caughtUp = false;
      const subscription = log.subscribe(stream, (event) => {
        if (caughtUp) consider(event);
        else pending.push(event);
      });
      const finish = (answer: string | undefined) => {
        if (done) return;
        done = true;
        following.delete(stop);
        subscription.dispose();
        resolve(answer);
      };
      const stop = () => finish(undefined);
      following.add(stop);
      void log.read(stream).then(
        (read) => {
          for (const event of read) consider(event);
          for (const event of pending) consider(event);
          caughtUp = true;
        },
        () => finish(undefined),
      );
    });

  const answered = (message: AgentMessage, answeredBy: string, answer: string) =>
    log.append(MESSAGES_STREAM, [
      {
        type: MessageEvents.answered,
        payload: {
          messageId: message.messageId,
          traceId: message.traceId,
          answeredBy,
          answeredAt: now(),
          // The conversation shows the answer after a reload (C1, D1061).
          answer,
        },
      },
    ]);

  // --- Commands (D623–D626) ----------------------------------------------------
  context.commands.register({
    name: "agents.send",
    description:
      "Sends a message to an agent (its current generation; queued while it works), a thread or the owner's inbox, on any node of the mesh. It carries the sender's address and the trace",
    ...MessageCommands["agents.send"],
    permissions: [MESSAGE_PERMISSION],
    handler: async ({ to: given, body, from, inReplyTo, messageId }, invocation) => {
      const to = await addressOf(given);
      const sender = await senderOf(from, invocation);
      const target = partyOf(to, "to");
      const id = messageId ?? Crypto.randomUUID();
      if (target.nodeId !== nodeId) {
        return forward(
          target.nodeId,
          "agents.send",
          {
            to,
            body,
            from: sender,
            messageId: id,
            ...(inReplyTo === undefined ? {} : { inReplyTo }),
          },
          invocation,
        );
      }
      const { message, delivery, fresh } = await deliverHere({
        messageId: id,
        kind: inReplyTo === undefined ? "message" : "answer",
        from: sender,
        to,
        body,
        traceId: invocation.traceId ?? Crypto.randomUUID(),
        sentAt: now(),
        ...(inReplyTo === undefined ? {} : { inReplyTo }),
      });
      // What an agent answers the owner's message is meant for the owner: it is
      // recorded with the message, as an ask's answer is, so it never stays
      // only in the agent's thread (D1221). Nobody waits for it.
      if (
        fresh === true &&
        message.kind === "message" &&
        message.from === ownerAddress(nodeId) &&
        delivery?.agentId !== undefined
      ) {
        void answerIn(delivery.threadId, message.messageId)
          .then((answer) =>
            answer === undefined ? undefined : answered(message, message.to, answer),
          )
          .catch((error: unknown) => {
            context.log.warn("no answer recorded for the owner's message", {
              messageId: message.messageId,
              error: String(error),
            });
          });
      }
      return { message, ...(delivery === undefined ? {} : { delivery }) };
    },
  });

  context.commands.register({
    name: "agents.ask",
    description:
      "Asks an agent, a thread or the owner a question. An agent answers in a turn of its current generation, or with `generation` an earlier one answers in a side turn; the owner answers later through the inbox (`pending`)",
    ...MessageCommands["agents.ask"],
    permissions: [MESSAGE_PERMISSION],
    handler: async ({ to: given, question, from, generation, messageId }, invocation) => {
      const to = await addressOf(given);
      const sender = await senderOf(from, invocation);
      const target = partyOf(to, "to");
      const id = messageId ?? Crypto.randomUUID();
      if (target.nodeId !== nodeId) {
        return forward(
          target.nodeId,
          "agents.ask",
          {
            to,
            question,
            from: sender,
            messageId: id,
            ...(generation === undefined ? {} : { generation }),
          },
          invocation,
        );
      }
      if (generation !== undefined && target.kind !== "agent") {
        throw new AgentsError("GENERATION_NOT_FOUND", `${to} has no generations`, { to });
      }
      const { message, delivery } = await deliverHere({
        messageId: id,
        kind: "ask",
        from: sender,
        to,
        body: question,
        traceId: invocation.traceId ?? Crypto.randomUUID(),
        sentAt: now(),
        ...(generation === undefined ? {} : { generation }),
      });
      if (delivery === undefined) return { message, status: "pending" as const };
      const answer = await answerIn(delivery.threadId, message.messageId);
      if (answer === undefined) {
        throw new AgentsError("NO_ANSWER", `${to} gave no answer`, {
          to,
          messageId: message.messageId,
          threadId: delivery.threadId,
        });
      }
      await answered(message, to, answer);
      return { message, status: "answered" as const, answer, answeredBy: to, delivery };
    },
  });

  /** The inbox, folded from its stream, and the head it reflects (D626). */
  async function inbox(): Promise<{ head: number; items: Map<string, InboxItem> }> {
    const head = await log.head(INBOX_STREAM);
    const items = new Map<string, InboxItem>();
    for (const event of await log.read(INBOX_STREAM)) {
      if (event.sequence > head) break;
      if (event.type === MessageEvents.received) {
        const item = event.payload as unknown as InboxItem;
        items.set(item.message.messageId, item);
      } else if (event.type === MessageEvents.inboxAnswered) {
        const { messageId, answer, answeredAt } = event.payload as {
          messageId: string;
          answer: string;
          answeredAt: string;
        };
        const item = items.get(messageId);
        if (item !== undefined)
          items.set(messageId, { ...item, status: "answered", answer, answeredAt });
      } else if (event.type === MessageEvents.inboxDismissed) {
        const { messageId, dismissedAt } = event.payload as {
          messageId: string;
          dismissedAt: string;
        };
        const item = items.get(messageId);
        if (item !== undefined) items.set(messageId, { ...item, status: "dismissed", dismissedAt });
      }
    }
    return { head, items };
  }

  context.commands.register({
    name: "agents.inbox.list",
    description:
      "What agents sent and asked this node's owner, oldest first (open ones by default), and the head of the agents/inbox stream they reflect",
    ...MessageCommands["agents.inbox.list"],
    permissions: [INBOX_PERMISSION],
    handler: async ({ status }) => {
      const { head, items } = await inbox();
      const wanted = status ?? "open";
      return {
        head,
        items: [...items.values()].filter((item) => wanted === "all" || item.status === wanted),
      };
    },
  });

  context.commands.register({
    name: "agents.conversation",
    description:
      "The messages between this node's owner and an agent (or an alias such as lead@team), oldest first: the owner's messages and asks with their answers, and what the agent sent or asked the owner with the state of its inbox item",
    ...MessageCommands["agents.conversation"],
    permissions: [INBOX_PERMISSION, "agents.read"],
    handler: async ({ with: given, limit }) => {
      const other = await addressOf(given);
      partyOf(other, "to");
      const owner = ownerAddress(nodeId);
      const head = await log.head(MESSAGES_STREAM);
      const { items } = await inbox();
      const entries: ConversationEntry[] = [];
      const asks = new Map<string, number>();
      // Every message is recorded where it is delivered (D627): the owner's
      // on the agent's node, the agent's to the owner here.
      for (const event of await log.read(MESSAGES_STREAM)) {
        if (event.sequence > head) break;
        if (event.type === MessageEvents.delivered) {
          const { message } = event.payload as unknown as Delivered;
          const between =
            (message.from === owner && message.to === other) ||
            (message.from === other && message.to === owner);
          if (!between) continue;
          const item = message.to === owner ? items.get(message.messageId) : undefined;
          // An ask's answer, and the agent's answer to the owner's message (D1221).
          if (message.kind === "ask" || (message.kind === "message" && message.from === owner)) {
            asks.set(message.messageId, entries.length);
          }
          entries.push({
            message,
            ...(item === undefined ? {} : { inbox: item.status }),
            ...(item?.answer === undefined
              ? {}
              : { answer: item.answer, answeredBy: owner, answeredAt: item.answeredAt }),
          });
        } else if (event.type === MessageEvents.answered) {
          const payload = event.payload as {
            messageId: string;
            answeredBy: string;
            answeredAt: string;
            answer?: string;
          };
          const at = asks.get(payload.messageId);
          if (at === undefined) continue;
          // An event recorded before D1061 has no text: the ask is answered all the same.
          entries[at] = {
            ...entries[at]!,
            ...(payload.answer === undefined ? {} : { answer: payload.answer }),
            answeredBy: payload.answeredBy,
            answeredAt: payload.answeredAt,
          };
        }
      }
      return { head, owner, with: other, entries: entries.slice(-(limit ?? 200)) };
    },
  });

  /** Answers one item at a time, so an item is answered once. */
  let answering: Promise<unknown> = Promise.resolve();
  context.commands.register({
    name: "agents.inbox.answer",
    description:
      "Answers a message or an ask in the owner's inbox: the answer goes back to its sender as a message, which wakes the asking agent",
    ...MessageCommands["agents.inbox.answer"],
    permissions: [INBOX_PERMISSION],
    handler: (input, invocation) => {
      const task = async () => {
        const { messageId, answer } = input;
        const item = (await inbox()).items.get(messageId);
        if (item === undefined) {
          throw new AgentsError("ASK_NOT_FOUND", `The inbox has no message ${messageId}`, {
            messageId,
          });
        }
        if (item.status === "dismissed") {
          throw new AgentsError("ITEM_CLOSED", `The message ${messageId} is dismissed`, {
            messageId,
            status: item.status,
          });
        }
        if (item.status === "answered") {
          throw new AgentsError("ASK_ANSWERED", `The message ${messageId} is answered already`, {
            messageId,
          });
        }
        const sent = (await context.commands.execute(
          "agents.send",
          { to: item.message.from, body: answer, from: item.message.to, inReplyTo: messageId },
          invocation.traceId === undefined ? {} : { traceId: invocation.traceId },
        )) as { message: AgentMessage; delivery?: MessageDelivery };
        const answeredAt = now();
        await log.append(INBOX_STREAM, [
          {
            type: MessageEvents.inboxAnswered,
            payload: {
              messageId,
              answer,
              answeredAt,
              ...(sent.delivery === undefined ? {} : { delivery: sent.delivery }),
            } as unknown as Json,
          },
        ]);
        if (item.message.kind === "ask") await answered(item.message, item.message.to, answer);
        return {
          item: { ...item, status: "answered" as const, answer, answeredAt },
          message: sent.message,
          ...(sent.delivery === undefined ? {} : { delivery: sent.delivery }),
        };
      };
      const result = answering.then(task, task);
      answering = result.catch(() => undefined);
      return result;
    },
  });

  context.commands.register({
    name: "agents.inbox.dismiss",
    description:
      "Closes an open message or ask in the owner's inbox without an answer (D1274): an ask's sender is told, which wakes it; a message's is not",
    ...MessageCommands["agents.inbox.dismiss"],
    permissions: [INBOX_PERMISSION],
    handler: (input, invocation) => {
      const task = async () => {
        const { messageId } = input;
        const item = (await inbox()).items.get(messageId);
        if (item === undefined) {
          throw new AgentsError("ASK_NOT_FOUND", `The inbox has no message ${messageId}`, {
            messageId,
          });
        }
        if (item.status !== "open") {
          throw new AgentsError("ITEM_CLOSED", `The message ${messageId} is closed already`, {
            messageId,
            status: item.status,
          });
        }
        let sent: { message: AgentMessage; delivery?: MessageDelivery } | undefined;
        if (item.message.kind === "ask") {
          sent = (await context.commands.execute(
            "agents.send",
            {
              to: item.message.from,
              body: "The owner dismissed your question without an answer.",
              from: item.message.to,
              inReplyTo: messageId,
            },
            invocation.traceId === undefined ? {} : { traceId: invocation.traceId },
          )) as { message: AgentMessage; delivery?: MessageDelivery };
        }
        const dismissedAt = now();
        await log.append(INBOX_STREAM, [
          {
            type: MessageEvents.inboxDismissed,
            payload: {
              messageId,
              dismissedAt,
              ...(sent?.delivery === undefined ? {} : { delivery: sent.delivery }),
            } as unknown as Json,
          },
        ]);
        return {
          item: { ...item, status: "dismissed" as const, dismissedAt },
          ...(sent === undefined ? {} : { message: sent.message }),
          ...(sent?.delivery === undefined ? {} : { delivery: sent.delivery }),
        };
      };
      const result = answering.then(task, task);
      answering = result.catch(() => undefined);
      return result;
    },
  });
}
