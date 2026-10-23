// How a message between agents reads in a transcript (docs/plans/agents.md, A2: D623, D1381).
import { parseMessageAddress, type MessageOrigin, type MessageParty } from "@jhin/agent-api";

/** Who sent a delivered message, as the turn it started carries it. */
export type TimelineOrigin = MessageOrigin;

const KIND_LABELS = { message: "message", ask: "question", answer: "answer" } as const;

export interface OriginView {
  /** The sender as the address gives it: an agent's id, "Owner", or a thread's title or id. */
  readonly name: string;
  /** The small line under the message: the sender, the kind and, for an answer, what it answers. */
  readonly caption: string;
  /** The accessible name of the message. */
  readonly label: string;
  /** The sender's party; undefined for an address that is none of an agent, an owner or a thread. */
  readonly party: MessageParty | undefined;
}

export function describeOrigin(
  origin: TimelineOrigin,
  titleOf?: (threadId: string) => string | undefined,
): OriginView {
  const party = parseMessageAddress(origin.from);
  const name =
    party === undefined
      ? origin.from
      : party.kind === "agent"
        ? party.agentId
        : party.kind === "owner"
          ? "Owner"
          : (titleOf?.(party.threadId) ?? party.threadId);
  const kind =
    origin.kind === "answer" && origin.inReplyTo !== undefined
      ? `answer to ${origin.inReplyTo}`
      : KIND_LABELS[origin.kind];
  return {
    name,
    caption: `${name} · ${kind}`,
    label: `${name}, ${KIND_LABELS[origin.kind]}`,
    party,
  };
}
