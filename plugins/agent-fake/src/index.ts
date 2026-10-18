import {
  AGENT_RUNTIME_CAPABILITY,
  type AgentItem,
  type AgentRuntime,
  type AgentTurn,
  type TurnRequest,
} from "@jhin/agent-api";
import { definePlugin } from "@jhin/sdk";

export const FAKE_AGENT_ID = "jhin.agent-fake";

/**
 * Scripted, timer-free and deterministic:
 * - "/hold …" sends one delta, then waits until interrupted;
 * - "/fail …" fails the turn;
 * - anything else is answered "Echo: <text>", one word per delta.
 */
export function fakeTurn(request: TurnRequest): AgentTurn {
  let interrupted = false;
  let wake: (() => void) | undefined;
  const interruption = new Promise<void>((resolve) => (wake = resolve));
  const itemId = `${request.turnId}:1`;
  const text = request.input.text;

  async function* items(): AsyncGenerator<AgentItem> {
    if (text.startsWith("/fail")) throw new Error("fake agent: asked to fail");
    if (text.startsWith("/hold")) {
      yield { kind: "message.delta", itemId, text: "Holding" };
      await interruption;
      return;
    }
    const words = `Echo: ${text}`.split(" ");
    for (const [index, word] of words.entries()) {
      if (interrupted) return;
      yield { kind: "message.delta", itemId, text: index === 0 ? word : ` ${word}` };
    }
    yield { kind: "message.completed", itemId, text: words.join(" ") };
  }

  return {
    items: items(),
    interrupt() {
      interrupted = true;
      wake?.();
    },
  };
}

export default definePlugin({
  activate(context) {
    const runtime: AgentRuntime = { agentId: FAKE_AGENT_ID, startTurn: fakeTurn };
    context.services.provide(AGENT_RUNTIME_CAPABILITY, runtime);
  },
});
