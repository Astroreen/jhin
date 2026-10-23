// Messaging between agents, and the owner (docs/plans/agents.md#a2-messaging-between-agents-and-the-owner-d621d640):
// addresses that send and receive, the message every surface records, the
// owner's inbox and the schemas of `agents.send`, `agents.ask` and
// `agents.inbox.*`, so A5 (teams) and A7 (health) read one contract.
import { z } from "@jhin/sdk";

import { parseAgentAddress } from "./agents.ts";

/** `jhin://<nodeId>/owner`: the owner, as agents of that node reach them (D622). */
export const ownerAddress = (nodeId: string): string => `jhin://${nodeId}/owner`;

/**
 * `jhin://<nodeId>/threads/<threadId>`: the agent of a thread that is no
 * generation (a Threads-mode thread), so it can send, ask and be answered (D622).
 */
export const threadAddress = (nodeId: string, threadId: string): string =>
  `jhin://${nodeId}/threads/${threadId}`;

/** Who sends or receives a message (D622). */
export type MessageParty =
  | { readonly kind: "agent"; readonly nodeId: string; readonly agentId: string }
  | { readonly kind: "owner"; readonly nodeId: string }
  | { readonly kind: "thread"; readonly nodeId: string; readonly threadId: string };

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** The party at an address, or `undefined` when it is none of an agent, an owner or a thread. */
export function parseMessageAddress(address: string): MessageParty | undefined {
  const agent = parseAgentAddress(address);
  if (agent !== undefined) return { kind: "agent", ...agent };
  const owner = /^jhin:\/\/([^/?#]+)\/owner$/.exec(address);
  if (owner !== null) return { kind: "owner", nodeId: owner[1]! };
  const thread = /^jhin:\/\/([^/?#]+)\/threads\/([^/?#]+)$/.exec(address);
  if (thread !== null && THREAD_ID.test(thread[2]!)) {
    return { kind: "thread", nodeId: thread[1]!, threadId: thread[2]! };
  }
  return undefined;
}

/** The longest body or question a message carries, in characters. */
export const MAX_MESSAGE_LENGTH = 32_000;

/** What a message is (D621): a note, a question awaiting an answer, or a reply to either. */
export const MESSAGE_KINDS = ["message", "ask", "answer"] as const;
export const MessageKind = z.enum(MESSAGE_KINDS);
export type MessageKind = z.output<typeof MessageKind>;

/**
 * One message (D621): who sent it to whom, its text and the `traceId` of the
 * request that sent it, so a chain of asks can be followed across nodes
 * (just following orders). `messageId` is chosen by the first node that
 * handles it and stays the same on every hop.
 */
export const AgentMessage = z.object({
  messageId: z.string().min(1),
  kind: MessageKind,
  /** The sender's address: an agent, an owner or a thread (D622). */
  from: z.string(),
  /** The recipient's address: an agent, an owner or a thread. */
  to: z.string(),
  body: z.string(),
  traceId: z.string(),
  sentAt: z.string(),
  /** The message an `answer` replies to. */
  inReplyTo: z.string().optional(),
  /** An ask to an earlier generation (D625). */
  generation: z.number().int().positive().optional(),
});
export type AgentMessage = z.output<typeof AgentMessage>;

/**
 * What a turn started by a message carries (D623): the threads plugin keeps
 * it on the queued message and the turn's `agent.turn.started` as `origin`,
 * so the thread shows the message as from its sender, with a link back.
 */
export const MessageOrigin = AgentMessage.pick({
  messageId: true,
  kind: true,
  from: true,
  traceId: true,
  inReplyTo: true,
});
export type MessageOrigin = z.output<typeof MessageOrigin>;

/** Where a message went on the recipient's node (D623). */
export const MessageDelivery = z.object({
  nodeId: z.string(),
  /** The thread that got it: a generation's, a side turn's (D625) or the addressed thread. */
  threadId: z.string(),
  /** The recipient agent; absent for a thread. */
  agentId: z.string().optional(),
  /** The generation that got it; the asked one for a side turn (D625). */
  generation: z.number().int().positive().optional(),
  /** The turn it started at once; absent while it waits in the thread's queue. */
  turnId: z.string().optional(),
  queued: z.boolean(),
});
export type MessageDelivery = z.output<typeof MessageDelivery>;

/** The node's stream of messages it delivered and answered (D627), for A7's sensors. */
export const MESSAGES_STREAM = "agents/messages";

/** The node's stream of the owner's inbox (D626). */
export const INBOX_STREAM = "agents/inbox";

/** Event types of the `agents/messages` and `agents/inbox` streams (D626, D627). */
export const MessageEvents = {
  /** `agents/messages`: `{ message: AgentMessage, delivery?: MessageDelivery }`; no delivery for the owner. */
  delivered: "agents.message.delivered",
  /**
   * `agents/messages`: `{ messageId, traceId, answeredBy, answeredAt, answer? }` once an ask
   * is answered; `answer` is its text (C1, D1061), absent in events recorded before it.
   */
  answered: "agents.message.answered",
  /** `agents/inbox`: `InboxItem`, a message or an ask to the owner. */
  received: "agents.inbox.received",
  /** `agents/inbox`: `{ messageId, answer, answeredAt, delivery? }`. */
  inboxAnswered: "agents.inbox.answered",
  /** `agents/inbox`: `{ messageId, dismissedAt, delivery? }`, an item closed without an answer (D1274). */
  inboxDismissed: "agents.inbox.dismissed",
} as const;

/**
 * A message or an ask to the owner, in the inbox of the owner's node (D626):
 * open until the owner answers it.
 */
export const InboxItem = z.object({
  message: AgentMessage,
  status: z.enum(["open", "answered", "dismissed"]),
  answer: z.string().optional(),
  answeredAt: z.string().optional(),
  /** When the owner closed it without an answer (D1274). */
  dismissedAt: z.string().optional(),
});
export type InboxItem = z.output<typeof InboxItem>;

/**
 * One message between the owner and another party, as `agents.conversation`
 * returns it (C1, D1061): an ask carries its answer once it has one; a message
 * to the owner carries the state of its inbox item.
 */
export const ConversationEntry = z.object({
  message: AgentMessage,
  /** An ask's answer: the answering turn's last message (D624) or the owner's (D626). */
  answer: z.string().optional(),
  answeredBy: z.string().optional(),
  answeredAt: z.string().optional(),
  /** For a message to the owner: whether its inbox item is still open (D626). */
  inbox: z.enum(["open", "answered", "dismissed"]).optional(),
});
export type ConversationEntry = z.output<typeof ConversationEntry>;

/** Error codes of `agents.send`, `agents.ask` and `agents.inbox.*`, beside `AgentErrorCode`. */
export type MessageErrorCode =
  /** `to` or `from` is none of an agent's, an owner's or a thread's address. */
  | "ADDRESS_INVALID"
  /** The caller may not send as `from` (D622). `details.expected` names who it is. */
  | "SENDER_MISMATCH"
  /** No such generation of the agent (D625). */
  | "GENERATION_NOT_FOUND"
  /** The turn that was to answer failed or was interrupted, or said nothing (D624). */
  | "NO_ANSWER"
  /** A `messageId` given again, by another sender. */
  | "MESSAGE_EXISTS"
  /** `agents.inbox.answer` of an ask the inbox does not have. */
  | "ASK_NOT_FOUND"
  /** `agents.inbox.answer` of an ask already answered. */
  | "ASK_ANSWERED"
  /** `agents.inbox.dismiss` of an item that is not open, or `agents.inbox.answer` of a dismissed one (D1274). */
  | "ITEM_CLOSED";

/** Permission to send and ask (D628); agents hold it through their node's MCP server. */
export const MESSAGE_PERMISSION = "agents.message";

/** Permission to read and answer the owner's inbox (D628); agents never hold it. */
export const INBOX_PERMISSION = "agents.inbox";

const Address = z.string().min(1).meta({
  description:
    "An agent's address, an owner's or a thread's (jhin://<node>/...), or a team member's alias (builder@workshop)",
});
const From = z.string().min(1).optional().meta({
  description:
    "Who sends it; the caller by default: the calling thread's agent, or the owner (D622)",
});
const MessageIdInput = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  .optional()
  .meta({ description: "Makes a retry idempotent; a new id by default" });

/** Input and output schemas of the messaging commands (D623–D626). */
export const MessageCommands = {
  "agents.send": {
    input: z.object({
      to: Address,
      body: z.string().min(1).max(MAX_MESSAGE_LENGTH),
      from: From,
      /** The message this one replies to: it goes as an `answer`. */
      inReplyTo: z.string().min(1).optional(),
      messageId: MessageIdInput,
    }),
    output: z.object({
      message: AgentMessage,
      /** Absent for the owner, whose messages go to the inbox. */
      delivery: MessageDelivery.optional(),
    }),
  },
  "agents.ask": {
    input: z.object({
      to: Address,
      question: z.string().min(1).max(MAX_MESSAGE_LENGTH),
      from: From,
      /** Ask this earlier generation of the agent instead (D625): the library of minds. */
      generation: z.number().int().positive().optional(),
      messageId: MessageIdInput,
    }),
    output: z.object({
      message: AgentMessage,
      /**
       * `answered` with `answer` from an agent; `pending` for the owner, whose
       * answer arrives later as an `answer` message (D626).
       */
      status: z.enum(["answered", "pending"]),
      answer: z.string().optional(),
      /** The address that answered; the agent's, with `generation` for an earlier one. */
      answeredBy: z.string().optional(),
      delivery: MessageDelivery.optional(),
    }),
  },
  "agents.inbox.list": {
    input: z.object({
      status: z
        .enum(["open", "answered", "dismissed", "all"])
        .optional()
        .meta({ description: "`open` by default" }),
    }),
    /** Oldest first, and the head of the `agents/inbox` stream they reflect. */
    output: z.object({ head: z.number(), items: z.array(InboxItem) }),
  },
  "agents.conversation": {
    input: z.object({
      with: Address,
      limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .meta({ description: "The newest entries to return; 200 by default" }),
    }),
    /**
     * The messages between this node's owner and `with`, oldest first, and the
     * head of the `agents/messages` stream they reflect.
     */
    output: z.object({
      head: z.number(),
      owner: z.string(),
      /** `with` as a full address, an alias resolved. */
      with: z.string(),
      entries: z.array(ConversationEntry),
    }),
  },
  "agents.inbox.answer": {
    input: z.object({
      messageId: z.string().min(1).meta({ description: "The ask's id" }),
      answer: z.string().min(1).max(MAX_MESSAGE_LENGTH),
    }),
    output: z.object({
      item: InboxItem,
      /** The `answer` message sent back to the asker. */
      message: AgentMessage,
      delivery: MessageDelivery.optional(),
    }),
  },
  "agents.inbox.dismiss": {
    input: z.object({
      messageId: z.string().min(1).meta({ description: "The inbox item's message id" }),
    }),
    output: z.object({
      item: InboxItem,
      /** For an ask, the notice sent to the asker; none for a message. */
      message: AgentMessage.optional(),
      delivery: MessageDelivery.optional(),
    }),
  },
} as const;

/**
 * The text a recipient's turn gets for a message (D623): a header naming the
 * sender, the trace and how to reply, then the body. The structured message
 * travels beside it as the turn's `origin`.
 */
export function messageText(message: AgentMessage, replyTool = "agents_send"): string {
  const generation =
    message.generation === undefined ? "" : ` (to your generation #${message.generation})`;
  const meta = `id ${message.messageId}, trace ${message.traceId}`;
  switch (message.kind) {
    case "ask":
      return `[Question from ${message.from}${generation}; ${meta}]\n\n${message.body}\n\n[Your last message in this turn is the answer: answer it directly, and say so when you cannot judge it.]`;
    case "answer":
      return `[Answer from ${message.from} to your message ${message.inReplyTo ?? "?"}; ${meta}]\n\n${message.body}`;
    default:
      return `[Message from ${message.from}; ${meta}. Reply with ${replyTool} to ${message.from}, inReplyTo ${message.messageId}.]\n\n${message.body}`;
  }
}
