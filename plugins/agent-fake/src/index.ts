import {
  AGENT_RUNTIME_CAPABILITY,
  type AgentItem,
  type AgentResponse,
  type AgentRuntime,
  type AgentTurn,
  type TurnRequest,
} from "@jhin/agent-api";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import { definePlugin } from "@jhin/sdk";

export const FAKE_AGENT_ID = "jhin.agent-fake";

/** A one-shot latch: `wait()` resolves once `open()` is called (or at once if it was). */
function latch<T>(): { wait(): Promise<T>; open(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { wait: () => promise, open: (value) => resolve(value) };
}

/**
 * Scripted, timer-free and deterministic:
 * - "/hold …" sends one delta, then waits until interrupted;
 * - "/fail …" fails the turn;
 * - "/think …" reasons first, then answers;
 * - "/tool <command>" runs a pretend command and reports its output;
 * - "/approve <command>" asks for approval before running it;
 * - "/ask" asks a question and answers with the choice;
 * - "/plan" publishes a three-step plan and completes it;
 * - "/write <file> <text>" writes the text to a file of its working directory;
 * - anything else is answered "Echo: <text>", one word per delta.
 */
export function fakeTurn(request: TurnRequest): AgentTurn {
  let interrupted = false;
  const interruption = latch<undefined>();
  const answers = new Map<string, ReturnType<typeof latch<AgentResponse | undefined>>>();
  const turnId = request.turnId;
  const text = request.input.text;
  const command = text.replace(/^\/\w+\s*/, "").trim() || "ls";
  let items = 0;
  const nextId = () => `${turnId}:${++items}`;

  /**
   * Starts listening for an answer to `requestId` before the request is yielded:
   * `respond` may come as soon as the request is out, before the next item is
   * pulled. The promise ends with the answer, or with `undefined` on an interrupt.
   */
  const awaitAnswer = (requestId: string) => {
    const waiting = latch<AgentResponse | undefined>();
    answers.set(requestId, waiting);
    return Promise.race([waiting.wait(), interruption.wait()]);
  };

  async function* say(words: string): AsyncGenerator<AgentItem> {
    const itemId = nextId();
    const parts = words.split(" ");
    for (const [index, word] of parts.entries()) {
      if (interrupted) return;
      yield { kind: "message.delta", itemId, text: index === 0 ? word : ` ${word}` };
    }
    yield { kind: "message.completed", itemId, text: parts.join(" ") };
  }

  async function* run(line: string): AsyncGenerator<AgentItem> {
    const itemId = nextId();
    yield {
      kind: "tool.started",
      itemId,
      tool: { name: "Bash", kind: "command", title: "Ran command", detail: line, input: { line } },
    };
    yield { kind: "tool.output", itemId, text: `$ ${line}\n` };
    yield { kind: "tool.output", itemId, text: "done\n" };
    yield { kind: "tool.completed", itemId, status: "completed", output: `$ ${line}\ndone\n` };
  }

  async function* items$(): AsyncGenerator<AgentItem> {
    if (text.startsWith("/fail")) throw new Error("fake agent: asked to fail");
    if (text.startsWith("/hold")) {
      yield { kind: "message.delta", itemId: nextId(), text: "Holding" };
      await interruption.wait();
      return;
    }
    if (text.startsWith("/think")) {
      const itemId = nextId();
      yield { kind: "reasoning.delta", itemId, text: "Thinking about " };
      yield { kind: "reasoning.delta", itemId, text: "the request" };
      yield { kind: "reasoning.completed", itemId, text: "Thinking about the request" };
      yield* say(`Thought about: ${command}`);
      return;
    }
    if (text.startsWith("/write")) {
      const [file = "notes.txt", ...words] = command.split(" ");
      const path = Path.resolve(request.cwd, file);
      if (!path.startsWith(Path.resolve(request.cwd) + Path.sep)) {
        throw new Error("fake agent: writes only inside its working directory");
      }
      const itemId = nextId();
      yield {
        kind: "tool.started",
        itemId,
        tool: { name: "Write", kind: "file_change", title: "Edited file", detail: file },
      };
      await Fs.mkdir(Path.dirname(path), { recursive: true });
      await Fs.writeFile(path, `${words.join(" ")}\n`);
      yield { kind: "tool.completed", itemId, status: "completed" };
      yield* say(`Wrote ${file}`);
      return;
    }
    if (text.startsWith("/tool")) {
      yield* run(command);
      yield* say(`Ran ${command}`);
      return;
    }
    if (text.startsWith("/approve")) {
      const requestId = nextId();
      const tool = {
        name: "Bash",
        kind: "command" as const,
        title: "Run command",
        detail: command,
      };
      const answered = awaitAnswer(requestId);
      yield { kind: "request.opened", requestId, request: { kind: "approval", tool } };
      const response = await answered;
      if (interrupted || response === undefined) return;
      const decision = response.kind === "approval" ? response.decision : "decline";
      if (decision === "accept" || decision === "accept-for-session") {
        yield* run(command);
        yield* say(`Approved and ran ${command}`);
      } else {
        yield* say(`Did not run ${command}`);
      }
      return;
    }
    if (text.startsWith("/ask")) {
      const requestId = nextId();
      const answered = awaitAnswer(requestId);
      yield {
        kind: "request.opened",
        requestId,
        request: {
          kind: "user-input",
          questions: [
            {
              id: "color",
              header: "Color",
              question: "Which color should I use?",
              options: [
                { label: "Red", description: "Warm" },
                { label: "Blue", description: "Calm" },
              ],
            },
          ],
        },
      };
      const response = await answered;
      if (interrupted || response === undefined) return;
      const chosen = response.kind === "user-input" ? response.answers["color"] : undefined;
      yield* say(`You chose ${Array.isArray(chosen) ? chosen.join(", ") : (chosen ?? "nothing")}`);
      return;
    }
    if (text.startsWith("/plan")) {
      const steps = ["Read the code", "Change it", "Test it"];
      yield {
        kind: "plan.updated",
        steps: steps.map((step, index) => ({
          text: step,
          status: index === 0 ? "in_progress" : "pending",
        })),
      };
      yield {
        kind: "plan.updated",
        steps: steps.map((step) => ({ text: step, status: "completed" })),
      };
      yield* say("Plan done");
      return;
    }
    yield* say(`Echo: ${text}`);
  }

  return {
    items: items$(),
    interrupt() {
      interrupted = true;
      interruption.open(undefined);
    },
    respond(requestId, response) {
      answers.get(requestId)?.open(response);
      answers.delete(requestId);
    },
  };
}

export default definePlugin({
  activate(context) {
    const runtime: AgentRuntime = {
      agentId: FAKE_AGENT_ID,
      name: "Fake agent",
      models: [{ id: "echo", name: "Echo", description: "Repeats what it is told" }],
      defaultModel: "echo",
      runtimeModes: ["approval-required", "auto-accept-edits", "full-access"],
      interactionModes: ["default", "plan"],
      startTurn: fakeTurn,
    };
    context.services.provide(AGENT_RUNTIME_CAPABILITY, runtime);
  },
});
