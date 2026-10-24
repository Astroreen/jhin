// The owner's conversation with a team's lead (docs/plans/agents.md, C1:
// D1061, D1062): `agents.conversation`, read again on each event of the
// node's `agents/messages` stream after the head it reflects, and of the lead's
// node's when the lead lives on another node (M1, D1533).
import { MESSAGES_STREAM, type ConversationEntry } from "@jhin/agent-api";
import type { RpcClient } from "@jhin/rpc";
import { toDisposable, type Disposable } from "@jhin/sdk";

/** What a client knows of one conversation. */
export interface ConversationView {
  /** `unavailable`: the node has no `agents.conversation`, or this client may not read it. */
  readonly status: "loading" | "ready" | "unavailable" | "error";
  readonly entries: readonly ConversationEntry[];
  /** The owner's address on the node, once read. */
  readonly owner?: string;
  /** The lead's address, as the node resolved it, once read (D1393). */
  readonly lead?: string;
  /** The lead's node when it is another node of the mesh (D1523). */
  readonly elsewhere?: string;
  /** Why the lead's node's half could not be read; this node's half shows alone. */
  readonly elsewhereError?: string;
  readonly error?: string;
}

/** Follows another node's `agents/messages` after `after` (through its relay, D1533). */
export type FollowElsewhere = (
  nodeId: string,
  after: number,
  onEvent: () => void,
  onError: (error: unknown) => void,
) => Disposable;

export const CONVERSATION_LOADING: ConversationView = { status: "loading", entries: [] };
const UNAVAILABLE = new Set(["COMMAND_NOT_FOUND", "METHOD_NOT_FOUND", "PERMISSION_DENIED"]);

/** Follows the conversation with `address` (an alias such as `lead@workshop`) until disposed. */
export function followConversation(
  client: Pick<RpcClient, "call" | "subscribe">,
  address: string,
  onView: (view: ConversationView) => void,
  followElsewhere?: FollowElsewhere,
): Disposable {
  let stopped = false;
  let subscription: Disposable | undefined;
  /** The lead's node's stream, once a read named its head (D1533). */
  let elsewhere: Disposable | undefined;
  let view = CONVERSATION_LOADING;
  /** Answers come in order of asking: a late answer never replaces a newer one. */
  let asked = 0;
  const set = (next: ConversationView) => {
    if (stopped) return;
    view = next;
    onView(next);
  };
  const failed = (error: unknown) => {
    if (UNAVAILABLE.has(String((error as { code?: unknown } | null)?.code))) {
      set({ ...CONVERSATION_LOADING, status: "unavailable" });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    set({ ...view, status: "error", error: message });
  };
  /** Reads the conversation; a read that a newer one overtook says nothing, answer or error. */
  const read = async (): Promise<number | undefined> => {
    const ask = ++asked;
    try {
      const answer = await client.call<{
        head: number;
        owner: string;
        with?: string;
        entries: ConversationEntry[];
        elsewhere?: { nodeId: string; head?: number; error?: string };
      }>("agents.conversation", { with: address });
      if (stopped || ask !== asked) return undefined;
      set({
        status: "ready",
        entries: answer.entries,
        owner: answer.owner,
        ...(answer.with === undefined ? {} : { lead: answer.with }),
        ...(answer.elsewhere === undefined ? {} : { elsewhere: answer.elsewhere.nodeId }),
        ...(answer.elsewhere?.error === undefined
          ? {}
          : { elsewhereError: answer.elsewhere.error }),
      });
      // The lead's node records the owner's messages to it (D627): its stream
      // tells when they change. A read that could not reach it follows it once
      // a later read does.
      const there = answer.elsewhere;
      if (followElsewhere !== undefined && elsewhere === undefined && there?.head !== undefined) {
        elsewhere = followElsewhere(
          there.nodeId,
          there.head,
          () => {
            if (!stopped) void read();
          },
          (error) => {
            elsewhere?.dispose();
            elsewhere = undefined;
            if (stopped) return;
            set({
              ...view,
              elsewhereError: error instanceof Error ? error.message : String(error),
            });
          },
        );
        if (stopped) elsewhere.dispose();
      }
      return answer.head;
    } catch (error) {
      if (!stopped && ask === asked) failed(error);
      return undefined;
    }
  };
  void read().then((head) => {
    if (stopped || head === undefined) return;
    // Any message of the node may be one of this conversation: read it again.
    subscription = client.subscribe(MESSAGES_STREAM, { after: head, onError: failed }, () => {
      if (!stopped) void read();
    });
    if (stopped) subscription.dispose();
  });
  return toDisposable(() => {
    stopped = true;
    subscription?.dispose();
    elsewhere?.dispose();
  });
}

/**
 * Whether the owner's ask still has no answer. The view shows the ones this
 * page is waiting for as being worked on, the others as having none (D1063).
 */
export function unanswered(entry: ConversationEntry, owner: string | undefined): boolean {
  // An ask answered before D1061 has its answerer but no text.
  return (
    entry.message.from === owner &&
    entry.message.kind === "ask" &&
    entry.answer === undefined &&
    entry.answeredBy === undefined
  );
}
