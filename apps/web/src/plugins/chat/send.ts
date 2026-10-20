// Sending, queueing and steering follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/client-runtime/src/state/composerDispatch.ts (what a send does while a turn runs).
// The queue itself lives on the node (docs/plans/t3-parity.md, D201).
import type { TurnAttachment } from "@jhin/agent-api";
import type { NodeTarget, ThreadsCatalog } from "@jhin/client-api";

/** The agent, model and modes a message is sent with. */
interface MessageSettings {
  readonly agentId?: string;
  readonly model?: string;
  readonly runtimeMode?: string;
  readonly interactionMode?: string;
}

/** A message as the composer sends it. */
export interface OutgoingMessage {
  readonly text: string;
  readonly attachments: readonly TurnAttachment[];
  /** What it was typed with: it goes with these, whatever the composer shows later. */
  readonly settings: MessageSettings;
}

/** What sending a message came to. */
export type SendOutcome =
  | { readonly kind: "sent" }
  /** Queued on the node: it starts when the thread is free. */
  | { readonly kind: "queued" }
  /** Steered into the running turn. */
  | { readonly kind: "steered" }
  /** `start` only: the thread runs a turn, and nothing was sent. */
  | { readonly kind: "busy" }
  | { readonly kind: "failed"; readonly message: string };

/** What a message sent while a turn runs does (T3's "Follow-up behavior"). */
export type FollowUpBehavior = "queue" | "steer";

/** T3's resolveComposerDispatchMode: the setting, or the other one for one message. */
export function dispatchMode(
  behavior: FollowUpBehavior,
  alternate: boolean,
  canSteer: boolean,
): FollowUpBehavior {
  const mode = alternate ? (behavior === "queue" ? "steer" : "queue") : behavior;
  // An agent that cannot steer gets the message after its turn instead.
  return mode === "steer" && !canSteer ? "queue" : mode;
}

const failure = (error: unknown): SendOutcome => ({
  kind: "failed",
  message: (error as Error | null)?.message ?? String(error),
});

/**
 * Sends a message to a thread (D201, D205). `queue` adds it to the thread's
 * queue on its node (a free thread starts it at once), `steer` sends it into
 * the running turn, and `send` starts a turn, queueing it after all when the
 * thread turned out busy.
 */
export async function sendMessage(
  threads: Pick<ThreadsCatalog, "call">,
  target: NodeTarget,
  threadId: string,
  message: OutgoingMessage,
  /** `start` refuses a busy thread (`busy`) instead of queueing the message. */
  mode: "send" | "start" | FollowUpBehavior = "send",
): Promise<SendOutcome> {
  const input = {
    threadId,
    text: message.text,
    ...(message.attachments.length === 0 ? {} : { attachments: message.attachments }),
    ...message.settings,
  };
  try {
    if (mode === "steer") {
      try {
        const sent = await threads.call<{ outcome?: unknown }>(target, "threads.steer", input);
        // The node queues a steer whose turn ended first (D205): nothing is lost.
        const outcomes: Record<string, SendOutcome> = {
          steered: { kind: "steered" },
          queued: { kind: "queued" },
          started: { kind: "sent" },
        };
        const answer = String(sent?.outcome);
        const outcome = Object.hasOwn(outcomes, answer) ? outcomes[answer] : undefined;
        return (
          outcome ?? failure(new Error(`The node answered a steer with ${String(sent?.outcome)}`))
        );
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== "STEER_UNSUPPORTED") throw error;
      }
    } else if (mode === "send" || mode === "start") {
      try {
        await threads.call(target, "threads.send", input);
        return { kind: "sent" };
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== "TURN_IN_PROGRESS") throw error;
        if (mode === "start") return { kind: "busy" };
      }
    }
    const queued = await threads.call<{ turnId?: string }>(target, "threads.queue.add", input);
    return { kind: queued.turnId === undefined ? "queued" : "sent" };
  } catch (error) {
    return failure(error);
  }
}
