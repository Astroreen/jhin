// The owner's conversation with a team's lead (docs/plans/agents.md, C1:
// D1061, D1062): `agents.conversation`, read again on each event of the
// node's `agents/messages` stream after the head it reflects.
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
  readonly error?: string;
}

export const CONVERSATION_LOADING: ConversationView = { status: "loading", entries: [] };
const UNAVAILABLE = new Set(["COMMAND_NOT_FOUND", "METHOD_NOT_FOUND", "PERMISSION_DENIED"]);

/** Follows the conversation with `address` (an alias such as `lead@workshop`) until disposed. */
export function followConversation(
  client: Pick<RpcClient, "call" | "subscribe">,
  address: string,
  onView: (view: ConversationView) => void,
): Disposable {
  let stopped = false;
  let subscription: Disposable | undefined;
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
  const read = async (): Promise<number | undefined> => {
    const ask = ++asked;
    const answer = await client.call<{
      head: number;
      owner: string;
      entries: ConversationEntry[];
    }>("agents.conversation", { with: address });
    if (stopped || ask !== asked) return undefined;
    set({ status: "ready", entries: answer.entries, owner: answer.owner });
    return answer.head;
  };
  void read()
    .then((head) => {
      if (stopped || head === undefined) return;
      // Any message of the node may be one of this conversation: read it again.
      subscription = client.subscribe(MESSAGES_STREAM, { after: head, onError: failed }, () => {
        if (!stopped) void read().catch(failed);
      });
      if (stopped) subscription.dispose();
    })
    .catch(failed);
  return toDisposable(() => {
    stopped = true;
    subscription?.dispose();
  });
}

/** Whether the owner's latest message is an ask that still waits for its answer. */
export function waitingForAnswer(view: ConversationView): boolean {
  const last = view.entries.findLast((entry) => entry.message.from === view.owner);
  return last !== undefined && last.message.kind === "ask" && last.answer === undefined;
}
