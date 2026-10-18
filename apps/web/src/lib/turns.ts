import { ThreadEvents } from "@jhin/agent-api";
import type { StoredEvent } from "@jhin/storage-api";

type TurnStatus = "running" | "completed" | "interrupted" | "failed";

export interface ChatTurn {
  readonly turnId: string;
  readonly agentId: string;
  readonly userText: string;
  readonly assistantText: string;
  readonly status: TurnStatus;
  readonly error?: string;
}

interface Payload {
  readonly turnId?: string;
  readonly agentId?: string;
  readonly input?: { readonly text?: string };
  readonly text?: string;
  readonly error?: string;
}

/** Folds a thread's events into turns, in order. Unknown event types are ignored. */
export function reduceTurns(events: readonly StoredEvent[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const index = new Map<string, number>();
  const update = (turnId: string, change: (turn: ChatTurn) => ChatTurn) => {
    const position = index.get(turnId);
    if (position !== undefined) turns[position] = change(turns[position]!);
  };
  for (const event of events) {
    const payload = (event.payload ?? {}) as Payload;
    const turnId = payload.turnId;
    if (turnId === undefined) continue;
    switch (event.type) {
      case ThreadEvents.turnStarted:
        index.set(turnId, turns.length);
        turns.push({
          turnId,
          agentId: payload.agentId ?? "",
          userText: payload.input?.text ?? "",
          assistantText: "",
          status: "running",
        });
        break;
      case ThreadEvents.itemDelta:
        update(turnId, (turn) => ({
          ...turn,
          assistantText: turn.assistantText + (payload.text ?? ""),
        }));
        break;
      case ThreadEvents.itemCompleted:
        update(turnId, (turn) => ({ ...turn, assistantText: payload.text ?? turn.assistantText }));
        break;
      case ThreadEvents.turnCompleted:
        update(turnId, (turn) => ({ ...turn, status: "completed" }));
        break;
      case ThreadEvents.turnInterrupted:
        update(turnId, (turn) => ({ ...turn, status: "interrupted" }));
        break;
      case ThreadEvents.turnFailed:
        update(turnId, (turn) => ({
          ...turn,
          status: "failed",
          ...(payload.error === undefined ? {} : { error: payload.error }),
        }));
        break;
    }
  }
  return turns;
}
