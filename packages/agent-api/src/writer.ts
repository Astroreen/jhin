// Moved from plugins/source-control/src/writer.ts (t3-parity.md D1174): a writer turn as
// T3 Code's text generation runs one (packages/provider-core/src/server/textGeneration*).
import type { AgentRuntime } from "./index.ts";

/** When a writer's turn has taken too long: a promise that resolves then, and how to drop it. */
export interface Deadline {
  readonly reached: Promise<void>;
  dispose(): void;
}

/**
 * Asks an agent runtime for an answer in a turn of its own that reads nothing of any
 * thread: no history, every request it opens declined (T3's text generation). `cwd`
 * should be a folder of its own. A turn still running at `deadline` is interrupted and
 * fails. Resolves with the agent's last message.
 */
export async function askAgent(
  runtime: AgentRuntime,
  request: {
    readonly prompt: string;
    readonly cwd: string;
    /** A fresh id: the throwaway thread and turn are named after it. */
    readonly id: string;
    readonly label?: string;
  },
  deadline?: Deadline,
): Promise<string> {
  let turn: ReturnType<AgentRuntime["startTurn"]>;
  try {
    turn = runtime.startTurn({
      threadId: `${request.label ?? "jhin.writer"}-${request.id}`,
      turnId: request.id,
      input: { text: request.prompt },
      history: [],
      cwd: request.cwd,
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
  } catch (error) {
    // Its deadline's timer goes with it.
    deadline?.dispose();
    throw error;
  }
  const consume = async () => {
    let text = "";
    for await (const item of turn.items) {
      if (item.kind === "message.completed") text = item.text;
      if (item.kind !== "request.opened") continue;
      turn.respond?.(
        item.requestId,
        item.request.kind === "approval"
          ? { kind: "approval", decision: "decline" }
          : { kind: "user-input", answers: {} },
      );
    }
    return text;
  };
  if (deadline === undefined) return consume();
  try {
    return await Promise.race([
      consume(),
      deadline.reached.then((): never => {
        turn.interrupt();
        throw new Error("the writer took too long");
      }),
    ]);
  } finally {
    deadline.dispose();
  }
}

/** The first JSON object in an answer, fenced or not. */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  for (const candidate of [
    fenced,
    text,
    text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
  ]) {
    if (candidate === undefined || candidate.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}
