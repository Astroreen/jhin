// Messaging between agents, and the owner (docs/plans/agents.md, A2: D621–D629):
// `agents.send` and `agents.ask` deliver through W1's thread queue, on this
// node or another one (`mesh.call`); messages to the owner go to the inbox.
import * as Crypto from "node:crypto";

import {
  AGENTS_STREAM,
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
import { MESH_STREAMS_CAPABILITY, isAway, type MeshStreams } from "@jhin/mesh-api";
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
  // The agents stream takes what `agents.catalog` takes (M1, D1521).
  if (live?.guard !== undefined) {
    context.subscriptions.add(live.guard(AGENTS_STREAM, ["agents.read"]));
    context.subscriptions.add(live.guard(MESSAGES_STREAM, ["agents.read"]));
    context.subscriptions.add(live.guard(INBOX_STREAM, [INBOX_PERMISSION]));
  }
  // Members read the agents, messages and inbox through relays, within their
  // grants and those guards (M1, D1521): never shared without them.
  const shared = context.services.tryGet<MeshStreams>(MESH_STREAMS_CAPABILITY);
  if (shared !== undefined && live?.guard !== undefined) {
    for (const stream of [AGENTS_STREAM, MESSAGES_STREAM, INBOX_STREAM]) {
      context.subscriptions.add(shared.share(stream));
    }
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

  /**
   * A reply forwarded to another node is delivered there (D627), so this node
   * remembers it by the id it answers (M1, D1524): in memory, as the turns
   * followed for an answer are (a restart follows none), the newest
   * `MAX_REPLIES` only.
   */
  const replies = new Map<string, { from: string; to: string }>();
  const MAX_REPLIES = 1000;
  const rememberReply = (inReplyTo: string, from: string, to: string) => {
    replies.delete(inReplyTo);
    replies.set(inReplyTo, { from, to });
    for (const oldest of replies.keys()) {
      if (replies.size <= MAX_REPLIES) break;
      replies.delete(oldest);
    }
  };

  /** Whether the recipient of `message` sent an answer to it (D1262), here or elsewhere (D1524). */
  const repliedTo = async (message: AgentMessage): Promise<boolean> => {
    const forwarded = replies.get(message.messageId);
    if (forwarded?.from === message.to && forwarded.to === message.from) {
      // Asked once, at the end of the message's turn: the record has served then.
      replies.delete(message.messageId);
      return true;
    }
    return (await log.read(MESSAGES_STREAM)).some((event) => {
      if (event.type !== MessageEvents.delivered) return false;
      const reply = (event.payload as unknown as Delivered).message;
      return (
        reply.inReplyTo === message.messageId &&
        reply.from === message.to &&
        reply.to === message.from
      );
    });
  };

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
        const sent = await forward<{ message: AgentMessage; delivery?: MessageDelivery }>(
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
        // Only a reply to an owner can stand for a turn's answer (D1221, D1262).
        if (inReplyTo !== undefined && target.kind === "owner") {
          rememberReply(inReplyTo, sender, to);
        }
        return sent;
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
      // only in the agent's thread (D1221). Nobody waits for it. Any owner of
      // the mesh, not only this node's (M1, D1524).
      if (
        fresh === true &&
        message.kind === "message" &&
        parseMessageAddress(message.from)?.kind === "owner" &&
        delivery?.agentId !== undefined
      ) {
        void answerIn(delivery.threadId, message.messageId)
          .then(async (answer) => {
            if (answer === undefined) return;
            // An agent that answered the message itself (`agents.send` with
            // `inReplyTo`) has said what it meant for the owner (D1262).
            if (await repliedTo(message)) return;
            await answered(message, message.to, answer);
          })
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

  /** Whether an item's sender lives on a node away now (D1549), by `mesh.streams@1.1`'s members (D1551). */
  function awayCheck(): (item: InboxItem) => boolean {
    const members = shared?.members?.();
    return (item) => {
      const sender = parseMessageAddress(item.message.from)?.nodeId;
      return sender !== undefined && sender !== nodeId && isAway(members, sender);
    };
  }
  /** Refuses to send to an item's sender while its node is away: the item stays open (D1549). */
  const assertSenderHere = async (item: InboxItem) => {
    if (awayCheck()(item)) {
      throw new AgentsError(
        "SENDER_AWAY",
        `The node of ${item.message.from} is away: answer once it is back`,
        { messageId: item.message.messageId, from: item.message.from },
      );
    }
  };

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
    handler: async ({ status, from }) => {
      const { head, items } = await inbox();
      const wanted = status ?? "open";
      const away = awayCheck();
      return {
        head,
        items: [...items.values()]
          .filter(
            (item) =>
              (wanted === "all" || item.status === wanted) &&
              (from === undefined || item.message.from === from),
          )
          .map((item) => (item.status === "open" && away(item) ? { ...item, away: true } : item)),
      };
    },
  });

  /**
   * The messages between `owner` and `other` this node recorded (D627, D1061),
   * oldest first; the inbox's state only for this node's owner, whose inbox it is.
   */
  async function conversationHere(
    owner: string,
    other: string,
  ): Promise<{ head: number; entries: ConversationEntry[] }> {
    const head = await log.head(MESSAGES_STREAM);
    const items = owner === ownerAddress(nodeId) ? (await inbox()).items : new Map();
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
    return { head, entries };
  }

  context.commands.register({
    name: "agents.conversation",
    description:
      "The messages between this node's owner and an agent (or an alias such as lead@team), oldest first: the owner's messages and asks with their answers, and what the agent sent or asked the owner with the state of its inbox item; an agent on another node adds the half recorded there",
    ...MessageCommands["agents.conversation"],
    permissions: [INBOX_PERMISSION, "agents.read"],
    handler: async ({ with: given, owner: asked, limit }, invocation) => {
      const other = await addressOf(given);
      const party = partyOf(other, "to");
      const owner = asked ?? ownerAddress(nodeId);
      const ownerParty = partyOf(owner, "from");
      if (ownerParty.kind !== "owner") {
        throw new AgentsError("ADDRESS_INVALID", `${owner} is not an owner's address`, { owner });
      }
      // Another owner's half is read only by that owner's node, through the
      // mesh, or by this node's own code (D1523).
      const caller = invocation.caller;
      if (
        owner !== ownerAddress(nodeId) &&
        caller !== undefined &&
        caller.id !== `node:${ownerParty.nodeId}`
      ) {
        throw new AgentsError(
          "OWNER_MISMATCH",
          `Only node ${ownerParty.nodeId} reads the conversation of ${owner} here`,
          { owner },
        );
      }
      const here = await conversationHere(owner, other);
      const keep = limit ?? 200;
      // Asked by another node for the half recorded here: no further hop.
      if (party.nodeId === nodeId || owner !== ownerAddress(nodeId)) {
        return { head: here.head, owner, with: other, entries: here.entries.slice(-keep) };
      }
      // The owner's messages to an agent of another node are recorded there
      // (D627): that node's half joins this one (M1, D1523).
      let elsewhere: { nodeId: string; head?: number; error?: string };
      let there: ConversationEntry[] = [];
      try {
        const answer = (await context.commands.execute(
          "mesh.call",
          {
            node: party.nodeId,
            method: "agents.conversation",
            params: { with: other, owner, limit: keep },
          },
          {
            ...(invocation.traceId === undefined ? {} : { traceId: invocation.traceId }),
            // The caller's own grants go along (D416); this node's own code
            // asks with what reading the conversation takes.
            caller: caller ?? {
              id: context.plugin.id,
              permissions: ["mesh.call", INBOX_PERMISSION, "agents.read"],
            },
          },
        )) as { head: number; owner: string; entries: ConversationEntry[] };
        // A node that does not know `owner` answers for its own owner: not this half.
        if (answer.owner !== owner) {
          throw new Error(`${party.nodeId} answered for ${answer.owner}, not ${owner}`);
        }
        there = answer.entries;
        elsewhere = { nodeId: party.nodeId, head: answer.head };
      } catch (error) {
        elsewhere = {
          nodeId: party.nodeId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const seen = new Set(here.entries.map((entry) => entry.message.messageId));
      const entries = [
        ...here.entries,
        ...there.filter((entry) => !seen.has(entry.message.messageId)),
        // By the time each node stamped (ISO strings compare as text); two
        // nodes' clocks may differ by a little (D1523).
      ].toSorted((a, b) =>
        a.message.sentAt < b.message.sentAt ? -1 : a.message.sentAt > b.message.sentAt ? 1 : 0,
      );
      return { head: here.head, owner, with: other, entries: entries.slice(-keep), elsewhere };
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
        await assertSenderHere(item);
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
        await assertSenderHere(item);
        if (item.message.kind === "ask") {
          sent = (await context.commands.execute(
            "agents.send",
            {
              to: item.message.from,
              body: "The owner dismissed your question without an answer.",
              from: item.message.to,
              inReplyTo: messageId,
              // One notice per item: a retry after a failed append is delivered once (D1274).
              messageId: `dismissed-${messageId}`,
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
