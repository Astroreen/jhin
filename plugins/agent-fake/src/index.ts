import {
  AGENT_RUNTIME_CAPABILITY,
  type AgentItem,
  type AgentResponse,
  type AgentRuntime,
  type AgentTurn,
  type TurnInput,
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
 * - "/options" answers with the model options the turn runs with;
 * - "/attachments" answers with each attachment's name, size and, for text, its content;
 * - in plan mode, anything else is answered with a proposed plan titled after it;
 * - "/write <file> <text>" writes the text to a file of its working directory;
 * - "/subagent <task>" runs a subagent titled after the task that answers "Echo: <task>" (D876);
 * - anything else is answered "Echo: <text>", one word per delta.
 * A message steered into a turn (D204) is answered "Echo: <text>" before the
 * turn ends; it ends a "/hold" turn.
 */
export function fakeTurn(request: TurnRequest): AgentTurn {
  let interrupted = false;
  const interruption = latch<undefined>();
  /** Messages steered into the turn and not answered yet; `ended` once it takes no more. */
  const steers: TurnInput[] = [];
  let steered = latch<undefined>();
  let ended = false;
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
    if (text.startsWith("/subagent")) {
      const task = text.slice("/subagent".length).trim() || "something";
      const subagentId = nextId();
      yield { kind: "subagent.started", subagentId, title: task, prompt: task };
      yield {
        kind: "subagent.item",
        subagentId,
        item: { kind: "message.completed", itemId: nextId(), text: `Echo: ${task}` },
      };
      yield { kind: "subagent.ended", subagentId, status: "completed" };
      yield* say(`Ran a subagent for ${task}`);
      return;
    }
    if (text.startsWith("/hold")) {
      yield { kind: "message.delta", itemId: nextId(), text: "Holding" };
      // Until it is interrupted or steered (a steer that came first counts).
      if (steers.length === 0) await Promise.race([interruption.wait(), steered.wait()]);
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
    if (/^\/write(\s|$)/.test(text)) {
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
    if (text.startsWith("/attachments")) {
      const described = await Promise.all(
        (request.input.attachments ?? []).map(async (attachment) => {
          if (!("read" in attachment)) return `${attachment.name} (inline)`;
          const bytes = await attachment.read();
          const content = attachment.mimeType.startsWith("text/")
            ? `: ${String.fromCharCode(...bytes.slice(0, 40))}`
            : "";
          return `${attachment.name} (${bytes.length} bytes${content})`;
        }),
      );
      yield* say(`Attached: ${described.length === 0 ? "nothing" : described.join(", ")}`);
      return;
    }
    if (text.replace(/^Ultrathink:\s*/, "").startsWith("/options")) {
      const chosen = (request.modelOptions ?? []).map(({ id, value }) => `${id}=${String(value)}`);
      // T3 writes Ultrathink into the prompt; the agent sees it there.
      if (text.startsWith("Ultrathink:")) chosen.push("prompt=Ultrathink");
      yield* say(`Options: ${chosen.length === 0 ? "none" : chosen.join(" ")}`);
      return;
    }
    if (request.interactionMode === "plan") {
      yield* say("Here is my plan.");
      yield {
        kind: "plan.proposed",
        itemId: nextId(),
        markdown: `# ${text.trim() || "Plan"}\n\n1. Read the code\n2. Change it\n3. Test it\n`,
      };
      return;
    }
    yield* say(`Echo: ${text}`);
  }

  async function* all(): AsyncGenerator<AgentItem> {
    try {
      yield* items$();
      // What was steered in is answered before the turn ends.
      while (!interrupted && steers.length > 0) yield* say(`Echo: ${steers.shift()!.text}`);
    } finally {
      ended = true;
    }
  }

  return {
    items: all(),
    steer(input) {
      if (ended || interrupted) throw new Error("fake agent: the turn has ended");
      steers.push(input);
      steered.open(undefined);
      steered = latch<undefined>();
    },
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
      models: [
        {
          id: "echo",
          name: "Echo",
          description: "Repeats what it is told",
          options: [
            {
              type: "select",
              id: "effort",
              label: "Reasoning",
              options: [
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
                { id: "ultrathink", label: "Ultrathink" },
              ],
              promptInjectedValues: ["ultrathink"],
            },
            { type: "boolean", id: "fastMode", label: "Fast Mode" },
          ],
        },
        { id: "plain", name: "Plain", description: "Echo without options" },
      ],
      defaultModel: "echo",
      runtimeModes: ["approval-required", "auto-accept-edits", "full-access"],
      interactionModes: ["default", "plan"],
      steering: true,
      // A command and a skill, so the composer's menus have something to offer.
      commands: async ({ cwd }) => ({
        commands: [
          { name: "review", description: "Review the changes", input: { hint: "<path>" } },
        ],
        skills: [
          {
            name: "deploy",
            description: "Deploy the app",
            path: `${cwd}/.claude/skills/deploy/SKILL.md`,
            scope: "project",
          },
        ],
      }),
      startTurn: fakeTurn,
    };
    context.services.provide(AGENT_RUNTIME_CAPABILITY, runtime);
  },
});
