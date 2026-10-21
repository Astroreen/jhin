import * as Fs from "node:fs";

import type { AgentItem } from "@jhin/agent-api";
import type { StoredEvent } from "@jhin/storage-api";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DECLINED,
  RECONNECT_FAILED,
  SESSION_GONE,
  STILL_STOPPING,
  declinedNote,
  sessionRules,
} from "../src/index.ts";
import { answer, type Play, type Script } from "./fake-server.ts";
import { THREAD, connected, drain, failure, manualClock, request } from "./support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(...args: Parameters<typeof connected>) {
  const env = await connected(...args);
  cleanups.push(env.cleanup);
  return env;
}

const b64 = (id: string) => Buffer.from(id).toString("base64url");
const kinds = (items: readonly AgentItem[]) => items.map((item) => item.kind);
const ids = (play: Play) => ({ sessionID: play.sessionId, assistantMessageID: "msg_a1" });

/** Emits a tool call of `name` with `input`, as OpenCode streams one. */
function tool(play: Play, id: string, name: string, input: Record<string, unknown>) {
  play.emit("session.tool.input.started", { ...ids(play), id, name });
  play.emit("session.tool.called", { ...ids(play), id, input, executed: true });
}

describe("jhin.agent-opencode: a turn", () => {
  it("creates the thread's session, streams the answer and reuses the session", async () => {
    const { fake, runtime, sessions } = await setup({
      scripts: [answer("Hello there"), answer("Again")],
    });

    const items = await drain(runtime.startTurn(request()));
    expect(kinds(items)).toEqual(["message.delta", "message.delta", "message.completed", "usage"]);
    expect(items[2]).toEqual({
      kind: "message.completed",
      itemId: "msg_a1:text:0",
      text: "Hello there",
    });
    expect(items[3]).toEqual({
      kind: "usage",
      usage: {
        inputTokens: 160,
        outputTokens: 25,
        cachedInputTokens: 50,
        contextTokens: 180,
        contextWindow: 1_000_000,
      },
    });
    const [created] = fake.calls("POST", "/api/session");
    expect(created!.body).toEqual({
      location: { directory: "/work" },
      model: { providerID: "anthropic", id: "claude-sonnet-5-5" },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    });
    expect(sessions.records.get(THREAD)).toEqual({ id: "ses_1", turnId: "turn-1" });
    expect(fake.calls("POST", "/prompt")[0]!.body).toEqual({
      id: "msg_jhin_turn_ses_1:turn-1",
      text: "hello",
    });
    expect(fake.calls("GET", "/api/info")[0]!.authorization).toBe(
      `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
    );

    await drain(runtime.startTurn(request({ turnId: "turn-2" })));
    expect(fake.calls("POST", "/api/session")).toHaveLength(1);
    // Nothing changed: the agent, model and rules stay as written.
    expect(fake.calls("POST", "/model")).toHaveLength(0);
    expect(fake.calls("PATCH", "/ses_1")).toHaveLength(0);
    expect(fake.calls("POST", "/prompt")[1]!.body).toMatchObject({
      id: "msg_jhin_turn_ses_1:turn-2",
    });
  });

  it("starts a new session with the transcript when a rollback dropped its last turn", async () => {
    const { fake, runtime, sessions } = await setup({ scripts: [answer("One"), answer("Two")] });
    await drain(runtime.startTurn(request()));
    expect(sessions.records.get(THREAD)).toEqual({ id: "ses_1", turnId: "turn-1" });
    // turn-1 was rolled back: the thread no longer shows it, but OpenCode's session holds it.
    const history = [
      {
        type: "agent.turn.started",
        payload: { turnId: "turn-0", agentId: "jhin.agent-fake", input: { text: "kept" } },
      },
    ] as unknown as StoredEvent[];
    await drain(runtime.startTurn(request({ turnId: "turn-2", history })));
    expect(fake.calls("POST", "/api/session")).toHaveLength(2);
    expect(fake.calls("POST", "/prompt")[1]!.body?.["text"]).toContain("User: kept");
    expect(sessions.records.get(THREAD)).toEqual({ id: "ses_2", turnId: "turn-2" });
  });

  it("hands OpenCode the turns another agent ran before it joined", async () => {
    const { fake, runtime } = await setup({ scripts: [answer("ok")] });
    const history = [
      {
        type: "agent.turn.started",
        payload: { turnId: "a", agentId: "jhin.agent-fake", input: { text: "first" } },
      },
      {
        type: "agent.item.completed",
        payload: { turnId: "a", kind: "message", text: "Echo: first" },
      },
    ] as unknown as StoredEvent[];
    await drain(runtime.startTurn(request({ history })));
    expect(fake.calls("POST", "/prompt")[0]!.body?.["text"]).toBe(
      [
        "This thread started before you joined it. The conversation so far:",
        "",
        "User: first",
        "Assistant: Echo: first",
        "",
        "The user's new message follows.",
        "hello",
      ].join("\n"),
    );
  });

  it("shows reasoning, tool calls, todos as plans and failed tools", async () => {
    const { runtime } = await setup({
      scripts: [
        (play) => {
          play.emit("session.execution.started", { sessionID: play.sessionId });
          play.emit("session.reasoning.delta", { ...ids(play), ordinal: 0, delta: "Thinking" });
          play.emit("session.reasoning.ended", { ...ids(play), ordinal: 0, text: "Thinking." });
          tool(play, "call_1", "shell", { command: "ls -la" });
          play.emit("session.tool.success", {
            ...ids(play),
            id: "call_1",
            content: [{ type: "text", text: "README.md" }],
            executed: true,
          });
          tool(play, "call_2", "todowrite", {
            todos: [
              { content: "Read", status: "completed", priority: "high" },
              { content: "Write", status: "in_progress", priority: "high" },
            ],
          });
          play.emit("session.tool.success", {
            ...ids(play),
            id: "call_2",
            content: [{ type: "text", text: "ok" }],
            executed: true,
          });
          tool(play, "call_3", "read", { filePath: "/work/missing.md" });
          play.emit("session.tool.failed", {
            ...ids(play),
            id: "call_3",
            error: { type: "unknown", message: "File not found" },
            executed: true,
          });
          play.emit("session.execution.succeeded", { sessionID: play.sessionId });
        },
      ],
    });
    const items = await drain(runtime.startTurn(request()));
    expect(items).toEqual([
      { kind: "reasoning.delta", itemId: "msg_a1:reasoning:0", text: "Thinking" },
      { kind: "reasoning.completed", itemId: "msg_a1:reasoning:0", text: "Thinking." },
      {
        kind: "tool.started",
        itemId: "call_1",
        tool: {
          name: "shell",
          kind: "command",
          title: "Ran command",
          detail: "ls -la",
          input: { command: "ls -la" },
        },
      },
      { kind: "tool.completed", itemId: "call_1", status: "completed", output: "README.md" },
      {
        kind: "plan.updated",
        steps: [
          { text: "Read", status: "completed" },
          { text: "Write", status: "in_progress" },
        ],
      },
      {
        kind: "tool.started",
        itemId: "call_3",
        tool: {
          name: "read",
          kind: "file_read",
          title: "Read file",
          detail: "/work/missing.md",
          input: { filePath: "/work/missing.md" },
        },
      },
      { kind: "tool.completed", itemId: "call_3", status: "failed", error: "File not found" },
    ]);
  });

  it("fails with OpenCode's message when its execution fails", async () => {
    const { runtime } = await setup({
      scripts: [
        (play) => {
          play.emit("session.execution.started", { sessionID: play.sessionId });
          play.emit("session.execution.failed", {
            sessionID: play.sessionId,
            error: { type: "provider_auth", message: "Anthropic API key is invalid" },
          });
        },
      ],
    });
    expect((await failure(runtime.startTurn(request()))).message).toBe(
      "Anthropic API key is invalid",
    );
  });

  it("refuses a model that is not provider/model", async () => {
    const { runtime } = await setup();
    expect((await failure(runtime.startTurn(request({ model: "sonnet" })))).message).toBe(
      "OpenCode model 'sonnet' must use provider/model format",
    );
  });

  it("uses OpenCode's default model when the turn names none", async () => {
    const { fake, runtime } = await setup({
      defaultModel: {
        providerID: "openai",
        id: "gpt-6",
        name: "GPT-6",
        limit: { context: 400_000, input: 272_000 },
      },
      scripts: [answer("ok")],
    });
    const { model: _none, ...rest } = request();
    const items = await drain(runtime.startTurn(rest));
    expect(fake.calls("POST", "/api/session")[0]!.body?.["model"]).toEqual({
      providerID: "openai",
      id: "gpt-6",
    });
    // The window is the model's input limit.
    expect(items.at(-1)).toMatchObject({ kind: "usage", usage: { contextWindow: 272_000 } });
  });

  it("lists a model's variants and sends the one a turn chose", async () => {
    const { fake, runtime } = await setup({
      models: [
        {
          providerID: "anthropic",
          id: "claude-sonnet-5-5",
          name: "Claude Sonnet 5.5",
          variants: [{ id: "low" }, { id: "high" }, { id: "max-thinking" }],
        },
        { providerID: "openai", id: "gpt-6", name: "GPT-6" },
      ],
      scripts: [answer("one"), answer("two"), answer("three")],
    });
    await runtime.status!();
    expect(runtime.models).toEqual([
      {
        id: "anthropic/claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        description: "anthropic",
        options: [
          {
            id: "variant",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High", isDefault: true },
              { id: "max-thinking", label: "Max Thinking" },
            ],
          },
        ],
      },
      { id: "openai/gpt-6", name: "GPT-6", description: "openai" },
    ]);

    const variant = (value: string) => ({ modelOptions: [{ id: "variant", value }] });
    await drain(runtime.startTurn(request(variant("max-thinking"))));
    expect(fake.calls("POST", "/api/session")[0]!.body?.["model"]).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-5-5",
      variant: "max-thinking",
    });
    // Another variant switches the session's model.
    await drain(runtime.startTurn(request({ turnId: "turn-2", ...variant("low") })));
    expect(fake.calls("POST", "/model").map((call) => call.body?.["model"])).toEqual([
      { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "low" },
    ]);
    // A variant the model lacks is dropped: OpenCode's default variant again.
    await drain(runtime.startTurn(request({ turnId: "turn-3", ...variant("xhigh") })));
    expect(fake.calls("POST", "/model").map((call) => call.body?.["model"])).toEqual([
      { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "low" },
      { providerID: "anthropic", id: "claude-sonnet-5-5" },
    ]);
  });

  it("steers a message into the running turn, which waits for its answer", async () => {
    const { fake, runtime } = await setup({
      scripts: [
        async (play) => {
          const steered = play.next("POST", "/prompt");
          play.emit("session.execution.started", { sessionID: play.sessionId });
          const steer = await steered;
          // The execution ends before the steer is delivered: the turn goes on.
          play.emit("session.execution.succeeded", { sessionID: play.sessionId });
          play.emit("session.inbox.delivered", {
            sessionID: play.sessionId,
            inboxID: steer.body!["id"],
          });
          // The execution that answers it asks first: the turn is still listening.
          play.emit("session.execution.started", { sessionID: play.sessionId });
          tool(play, "call_1", "shell", { command: "ls" });
          play.emit("permission.asked", {
            id: "per_1",
            sessionID: play.sessionId,
            action: "shell",
            resources: ["ls"],
            save: [],
            source: { type: "tool", messageID: "msg_a1", id: "call_1" },
          });
          await play.next("POST", "/permission/per_1/reply");
          await answer("Steered")(play);
        },
      ],
    });
    const turn = runtime.startTurn(request({ runtimeMode: "approval-required" }));
    // Sent before OpenCode took the prompt: it goes out once it did.
    turn.steer!({ text: "  also this  " });
    const items = await drain(turn, () => ({ kind: "approval", decision: "accept" }));
    expect(items.find((item) => item.kind === "message.completed")).toMatchObject({
      text: "Steered",
    });
    expect(fake.calls("POST", "/prompt")[1]!.body).toEqual({
      id: "msg_jhin_steer_ses_1:turn-1:1",
      text: "also this",
      delivery: "steer",
    });
    expect(() => turn.steer!({ text: "late" })).toThrow(
      "The OpenCode turn takes no more messages.",
    );
  });

  it("ends a held turn whose steer OpenCode refused", async () => {
    const { fake, runtime } = await setup({
      scripts: [
        async (play) => {
          play.emit("session.execution.started", { sessionID: play.sessionId });
          play.emit("session.execution.succeeded", { sessionID: play.sessionId });
        },
        answer("Next"),
      ],
    });
    fake.rejectSteer(400, "InvalidRequestError", "no");
    const turn = runtime.startTurn(request());
    turn.steer!({ text: "more" });
    expect(await drain(turn)).toEqual([]);
    // A clear refusal is not taken back later.
    await drain(runtime.startTurn(request({ turnId: "turn-2" })));
    expect(fake.calls("DELETE", "/inbox/msg_jhin_steer_ses_1%3Aturn-1%3A1")).toHaveLength(0);
  });

  it("ends a turn whose undelivered steer OpenCode cancelled", async () => {
    const { runtime } = await setup({
      scripts: [
        async (play) => {
          const steered = play.next("POST", "/prompt");
          play.emit("session.execution.started", { sessionID: play.sessionId });
          const steer = await steered;
          play.emit("session.execution.succeeded", { sessionID: play.sessionId });
          play.emit("session.inbox.cancelled", {
            sessionID: play.sessionId,
            inboxID: steer.body!["id"],
          });
        },
      ],
    });
    const turn = runtime.startTurn(request());
    turn.steer!({ text: "more" });
    expect(await drain(turn)).toEqual([]);
  });

  it("takes back the steers a stopped turn left before the next prompt", async () => {
    let stopTurn = () => {};
    const { fake, runtime } = await setup({
      scripts: [
        async (play) => {
          const steered = play.next("POST", "/prompt");
          play.emit("session.execution.started", { sessionID: play.sessionId });
          await steered;
          stopTurn();
        },
        answer("Next"),
        answer("Again"),
      ],
    });
    // Gone by the time it is taken back: done, not asked for again.
    fake.inboxGone();
    const turn = runtime.startTurn(request());
    stopTurn = () => turn.interrupt();
    turn.steer!({ text: "never delivered" });
    await drain(turn);
    expect(() => turn.steer!({ text: "late" })).toThrow();
    await drain(runtime.startTurn(request({ turnId: "turn-2" })));
    const cancelled = fake.calls("DELETE", "/inbox/msg_jhin_steer_ses_1%3Aturn-1%3A1");
    expect(cancelled).toHaveLength(1);
    await drain(runtime.startTurn(request({ turnId: "turn-3" })));
    expect(fake.received.filter((call) => call.method === "DELETE")).toHaveLength(1);
    // Taken back before the next prompt went out.
    const order = fake.received.map((call) => `${call.method} ${call.path}`);
    expect(order.indexOf(`DELETE ${cancelled[0]!.path}`)).toBeLessThan(
      order.lastIndexOf("POST /api/session/ses_1/prompt"),
    );
  });

  it("fails the turn and forgets a session OpenCode no longer has", async () => {
    const { runtime, sessions } = await setup({}, { [THREAD]: "ses_gone" });
    expect((await failure(runtime.startTurn(request()))).message).toBe(SESSION_GONE);
    expect(sessions.records.has(THREAD)).toBe(false);
  });

  it("compacts on /compact and runs OpenCode's own commands", async () => {
    const { fake, runtime } = await setup({
      commands: [{ name: "review" }],
      scripts: [
        (play) => {
          play.emit("session.execution.started", { sessionID: play.sessionId });
          play.emit("session.compaction.started", {
            sessionID: play.sessionId,
            reason: "manual",
            recent: 2,
          });
          play.emit("session.compaction.ended", {
            sessionID: play.sessionId,
            reason: "manual",
            recent: 2,
            text: "Summary",
          });
          play.emit("session.execution.succeeded", { sessionID: play.sessionId });
        },
        answer("Reviewed"),
        answer("Unknown command goes as text"),
      ],
    });
    const compacted = await drain(runtime.startTurn(request({ input: { text: "/compact" } })));
    expect(compacted).toEqual([
      {
        kind: "tool.started",
        itemId: "turn-1:compaction",
        tool: { name: "compaction", kind: "other", title: "Compacting context" },
      },
      {
        kind: "tool.completed",
        itemId: "turn-1:compaction",
        status: "completed",
        output: "Summary",
      },
    ]);
    expect(fake.calls("POST", "/compact")[0]!.body).toEqual({ id: "msg_jhin_turn_ses_1:turn-1" });

    await drain(
      runtime.startTurn(request({ turnId: "turn-2", input: { text: "/review the diff" } })),
    );
    expect(fake.calls("POST", "/command")[0]!.body).toEqual({ name: "review", text: "the diff" });

    await drain(runtime.startTurn(request({ turnId: "turn-3", input: { text: "/nope" } })));
    expect(fake.calls("POST", "/prompt")[0]!.body).toMatchObject({ text: "/nope" });
  });

  it("names attached images by the file they are saved in", async () => {
    let seen: string | undefined;
    const { fake, runtime, attachmentsDir } = await setup({
      scripts: [
        (play) => {
          // OpenCode reads the file while the turn runs.
          seen = Fs.readFileSync(
            `${attachmentsDir}/${b64(THREAD)}/${b64("turn-1")}/1-cat.png`,
            "utf8",
          );
          return answer("A cat")(play);
        },
      ],
    });
    await drain(
      runtime.startTurn(
        request({
          input: {
            text: "What is this?",
            attachments: [
              {
                kind: "image",
                name: "cat.png",
                mimeType: "image/png",
                dataUrl: "data:image/png;base64,aGk=",
              },
            ],
          },
        }),
      ),
    );
    const file = `${attachmentsDir}/${b64(THREAD)}/${b64("turn-1")}/1-cat.png`;
    expect(fake.calls("POST", "/prompt")[0]!.body?.["text"]).toBe(
      `What is this?\n\n[Attached image "cat.png" is saved at: ${file}]`,
    );
    expect(seen).toBe("hi");
    // Kept while the thread is (its session's history names the path), removed with it.
    expect(Fs.existsSync(file)).toBe(true);
    await runtime.forget(THREAD);
    expect(Fs.existsSync(`${attachmentsDir}/${b64(THREAD)}`)).toBe(false);
  });

  it("hands the earlier turns to the next prompt when the first one is refused", async () => {
    const { fake, runtime, sessions } = await setup({ scripts: [answer("ok")] });
    fake.rejectPrompt(400, "InvalidRequestError", "Prompt rejected");
    const history = [
      {
        type: "agent.turn.started",
        payload: { turnId: "a", agentId: "jhin.agent-fake", input: { text: "first" } },
      },
    ] as unknown as StoredEvent[];
    expect((await failure(runtime.startTurn(request({ history })))).message).toBe(
      "Prompt rejected",
    );
    // Recorded, but fresh: no prompt reached the session yet.
    expect(sessions.records.get(THREAD)).toEqual({ id: "ses_1", fresh: true });
    await drain(runtime.startTurn(request({ turnId: "turn-2", history })));
    expect(fake.calls("POST", "/api/session")).toHaveLength(1);
    expect(fake.calls("POST", "/prompt")[1]!.body?.["text"]).toContain("User: first");
    expect(sessions.records.get(THREAD)).toEqual({ id: "ses_1", turnId: "turn-2" });
  });
});

describe("jhin.agent-opencode: modes", () => {
  it("maps runtime and interaction modes onto OpenCode rules (T3's sessionRules)", () => {
    expect(sessionRules("approval-required", "default", [], [])).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "ask" },
      { action: "external_directory", resource: "*", effect: "ask" },
    ]);
    expect(sessionRules("auto-accept-edits", "default", [], [])[1]).toEqual({
      action: "edit",
      resource: "*",
      effect: "allow",
    });
    const plan = { action: "edit", resource: ".opencode/plans/*.md", effect: "allow" } as const;
    expect(sessionRules("full-access", "plan", [plan], [])).toEqual([
      { action: "*", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
      plan,
    ]);
  });

  it("switches to the plan agent with its plan file allowed", async () => {
    const { fake, runtime } = await setup({
      agents: [
        { id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] },
        {
          id: "plan",
          permissions: [{ action: "edit", resource: ".opencode/plans/*.md", effect: "allow" }],
        },
      ],
      scripts: [answer("Plan"), answer("Built")],
    });
    await drain(
      runtime.startTurn(request({ runtimeMode: "approval-required", interactionMode: "plan" })),
    );
    expect(fake.calls("POST", "/agent")[0]!.body).toEqual({ agent: "plan" });
    expect(fake.calls("POST", "/api/session")[0]!.body?.["permissions"]).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "ask" },
      { action: "external_directory", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: ".opencode/plans/*.md", effect: "allow" },
    ]);

    // Back to building: the build agent, and the rules written again.
    await drain(runtime.startTurn(request({ turnId: "turn-2", runtimeMode: "approval-required" })));
    expect(fake.calls("POST", "/agent")[1]!.body).toEqual({ agent: "build" });
    expect(fake.calls("PATCH", "/ses_1")[0]!.body).toEqual({
      permissions: sessionRules("approval-required", "default", [], []),
    });
  });
});

describe("jhin.agent-opencode: approvals and questions", () => {
  /** A shell call that asks first, then finishes as the reply says. */
  const asking =
    (save: string[] = []): Script =>
    async (play) => {
      play.emit("session.execution.started", { sessionID: play.sessionId });
      tool(play, "call_1", "shell", { command: "rm -rf build" });
      play.emit("permission.asked", {
        id: "per_1",
        sessionID: play.sessionId,
        action: "shell",
        resources: ["rm -rf build"],
        save,
        source: { type: "tool", messageID: "msg_a1", id: "call_1" },
      });
      const reply = await play.next("POST", "/permission/per_1/reply");
      if (reply.body?.["decision"] === "once") {
        play.emit("session.tool.success", {
          ...ids(play),
          id: "call_1",
          content: [{ type: "text", text: "removed" }],
          executed: true,
        });
        play.emit("session.execution.succeeded", { sessionID: play.sessionId });
      } else if (reply.body?.["message"] !== undefined) {
        play.emit("session.tool.failed", {
          ...ids(play),
          id: "call_1",
          error: { type: "rejected", message: "The user declined this request." },
          executed: false,
        });
        play.emit("session.execution.succeeded", { sessionID: play.sessionId });
      } else {
        play.emit("session.tool.failed", {
          ...ids(play),
          id: "call_1",
          error: { type: "aborted", message: "Stopped" },
          executed: false,
        });
        play.emit("session.execution.interrupted", { sessionID: play.sessionId, reason: "user" });
      }
    };
  const supervised = request({ runtimeMode: "approval-required" });

  it("asks before a command and runs it once accepted", async () => {
    const { fake, runtime } = await setup({ scripts: [asking()] });
    const items = await drain(runtime.startTurn(supervised), () => ({
      kind: "approval",
      decision: "accept",
    }));
    expect(items.find((item) => item.kind === "request.opened")).toEqual({
      kind: "request.opened",
      requestId: "per_1",
      request: {
        kind: "approval",
        tool: {
          name: "shell",
          kind: "command",
          title: "Run command",
          detail: "rm -rf build",
          input: { command: "rm -rf build" },
        },
      },
    });
    expect(items.at(-1)).toEqual({
      kind: "tool.completed",
      itemId: "call_1",
      status: "completed",
      output: "removed",
    });
    expect(fake.calls("POST", "/reply")[0]!.body).toEqual({ decision: "once" });
  });

  it("allows the request's patterns for the rest of the session", async () => {
    const { fake, runtime, sessions } = await setup({ scripts: [asking(["rm *"])] });
    await drain(runtime.startTurn(supervised), () => ({
      kind: "approval",
      decision: "accept-for-session",
    }));
    // Kept with the session's record, so a reload or restart keeps the grant.
    expect(sessions.records.get(THREAD)).toEqual({
      id: "ses_1",
      turnId: "turn-1",
      grants: [{ action: "shell", resource: "rm *", effect: "allow" }],
    });
    expect(fake.calls("PATCH", "/ses_1")[0]!.body).toEqual({
      permissions: [
        ...sessionRules("approval-required", "default", [], []),
        { action: "shell", resource: "rm *", effect: "allow" },
      ],
    });
    // Once, not OpenCode's "always", which would save the grant for the whole project.
    expect(fake.calls("POST", "/reply")[0]!.body).toEqual({ decision: "once" });
  });

  it("tells OpenCode not to retry a declined request", async () => {
    const { fake, runtime } = await setup({ scripts: [asking()] });
    const items = await drain(runtime.startTurn(supervised), () => ({
      kind: "approval",
      decision: "decline",
    }));
    expect(fake.calls("POST", "/synthetic")[0]!.body).toEqual({
      text: declinedNote("shell", ["rm -rf build"]),
      delivery: "steer",
      resume: false,
    });
    expect(fake.calls("POST", "/reply")[0]!.body).toEqual({
      decision: "reject",
      message: DECLINED,
    });
    expect(items.at(-1)).toMatchObject({
      kind: "tool.completed",
      itemId: "call_1",
      status: "declined",
    });
  });

  it("stops OpenCode when a request is cancelled", async () => {
    const { fake, runtime } = await setup({ scripts: [asking()] });
    const turn = runtime.startTurn(supervised);
    await expect(drain(turn, () => ({ kind: "approval", decision: "cancel" }))).rejects.toThrow(
      "OpenCode stopped the turn.",
    );
    expect(fake.calls("POST", "/reply")[0]!.body).toEqual({ decision: "reject" });
  });

  it("asks OpenCode's questions and answers the form", async () => {
    const { fake, runtime } = await setup({
      scripts: [
        async (play) => {
          play.emit("session.execution.started", { sessionID: play.sessionId });
          play.emit("form.created", {
            form: {
              id: "frm_1",
              sessionID: play.sessionId,
              title: "Questions",
              fields: [
                {
                  key: "db",
                  type: "string",
                  title: "Database",
                  description: "Which database?",
                  options: [
                    { value: "pg", label: "Postgres", description: "Relational" },
                    { value: "sqlite", label: "SQLite" },
                  ],
                },
                {
                  key: "extras",
                  type: "multiselect",
                  title: "Extras",
                  options: [
                    { value: "auth", label: "Auth" },
                    { value: "mail", label: "Mail" },
                  ],
                },
              ],
            },
          });
          await play.next("POST", "/form/frm_1/reply");
          play.emit("session.execution.succeeded", { sessionID: play.sessionId });
        },
      ],
    });
    const items = await drain(runtime.startTurn(request()), () => ({
      kind: "user-input",
      answers: { db: "Postgres", extras: ["Auth", "Mail"] },
    }));
    expect(items[0]).toEqual({
      kind: "request.opened",
      requestId: "frm_1",
      request: {
        kind: "user-input",
        questions: [
          {
            id: "db",
            header: "Database",
            question: "Which database?",
            options: [
              { label: "Postgres", description: "Relational" },
              { label: "SQLite", description: "SQLite" },
            ],
            multiSelect: false,
            allowCustomAnswer: false,
          },
          {
            id: "extras",
            header: "Extras",
            question: "Extras",
            options: [
              { label: "Auth", description: "Auth" },
              { label: "Mail", description: "Mail" },
            ],
            multiSelect: true,
            allowCustomAnswer: false,
          },
        ],
      },
    });
    expect(fake.calls("POST", "/form/frm_1/reply")[0]!.body).toEqual({
      answer: { db: "pg", extras: ["auth", "mail"] },
    });
  });

  it("declines a form Jhin cannot show and fails the turn", async () => {
    const { fake, runtime } = await setup({
      scripts: [
        (play) => {
          play.emit("session.execution.started", { sessionID: play.sessionId });
          play.emit("form.created", {
            form: {
              id: "frm_2",
              sessionID: play.sessionId,
              title: "Sign in",
              fields: [{ key: "url", type: "external", url: "https://example.com" }],
            },
          });
          // OpenCode's stop for the cancel may come back before the cancel's answer.
          void play.next("DELETE", "/form/frm_2").then(() =>
            play.emit("session.execution.interrupted", {
              sessionID: play.sessionId,
              reason: "user",
            }),
          );
        },
      ],
    });
    expect((await failure(runtime.startTurn(request()))).message).toBe(
      "OpenCode asked for a link to open, which Jhin can't show. The question was declined.",
    );
    expect(fake.calls("DELETE", "/form/frm_2")).toHaveLength(1);
  });
});

describe("jhin.agent-opencode: interrupts and lost streams", () => {
  it("interrupts OpenCode's execution and records nothing after it", async () => {
    const { fake, runtime } = await setup({
      scripts: [
        (play) => {
          play.emit("session.execution.started", { sessionID: play.sessionId });
          play.emit("session.text.delta", { ...ids(play), ordinal: 0, delta: "Working" });
        },
      ],
    });
    // OpenCode finishes the text it was writing, then ends the execution as interrupted.
    fake.setInterrupt((sessionId) => {
      fake.emit("session.text.ended", {
        sessionID: sessionId,
        assistantMessageID: "msg_a1",
        ordinal: 0,
        text: "Working on it",
      });
      fake.emit("session.execution.interrupted", { sessionID: sessionId, reason: "user" });
      return { interrupted: true };
    });
    const turn = runtime.startTurn(request());
    const items = turn.items[Symbol.asyncIterator]();
    expect((await items.next()).value).toMatchObject({ kind: "message.delta", text: "Working" });
    turn.interrupt();
    expect(await items.next()).toEqual({ done: true, value: undefined });
    expect(fake.calls("POST", "/interrupt")).toHaveLength(1);
  });

  it("answers an open request with a stop when the turn is interrupted", async () => {
    const { fake, runtime } = await setup({
      scripts: [
        (play) => {
          play.emit("session.execution.started", { sessionID: play.sessionId });
          play.emit("permission.asked", {
            id: "per_9",
            sessionID: play.sessionId,
            action: "shell",
            resources: ["make"],
          });
        },
      ],
    });
    const turn = runtime.startTurn(request({ runtimeMode: "approval-required" }));
    const items = turn.items[Symbol.asyncIterator]();
    expect((await items.next()).value).toMatchObject({
      kind: "request.opened",
      requestId: "per_9",
    });
    const replied = fake.next("POST", "/permission/per_9/reply");
    turn.interrupt();
    expect(await items.next()).toEqual({ done: true, value: undefined });
    expect((await replied).body).toEqual({ decision: "reject" });
  });

  it("gives up a prompt OpenCode has not answered when the turn is interrupted", async () => {
    const { fake, runtime, sessions } = await setup({
      scripts: [
        (play) => {
          play.emit("session.execution.started", { sessionID: play.sessionId });
        },
      ],
    });
    const release = fake.holdPrompt();
    const prompted = fake.next("POST", "/prompt");
    const turn = runtime.startTurn(request());
    const done = drain(turn);
    await prompted;
    const interrupted = fake.next("POST", "/interrupt");
    turn.interrupt();
    // The turn ends at once; OpenCode is told to stop, and the next turn checks first.
    expect(await done).toEqual([]);
    await interrupted;
    expect(sessions.records.get(THREAD)).toEqual({ id: "ses_1", unsettled: true, fresh: true });
    release();
  });

  it("fails the turn when the event stream goes silent and does not open again", async () => {
    const silence = manualClock();
    const env = await connected(
      {
        scripts: [
          (play) => {
            play.emit("session.execution.started", { sessionID: play.sessionId });
          },
        ],
      },
      {},
      silence.clock,
    );
    cleanups.push(env.cleanup);
    const prompted = env.fake.next("POST", "/prompt");
    const failed = failure(env.runtime.startTurn(request()));
    await prompted;
    // Open, but 45 s without a byte (D330): the stream counts as lost. Opened again five
    // times, 2 s apart (D887), it is refused each time.
    env.fake.refuseStreams(5);
    silence.fire(45_000);
    for (let attempt = 1; attempt < 5; attempt++) {
      await silence.armed(2_000);
      silence.fire(2_000);
    }
    expect((await failed).message).toBe(RECONNECT_FAILED);
    expect(env.sessions.records.get(THREAD)).toMatchObject({ id: "ses_1", unsettled: true });
  });

  it("takes no end of an earlier execution for this turn's", async () => {
    // A session left unsettled: its stopped execution's end may still be on its way.
    const { fake, runtime, sessions } = await setup({
      scripts: [
        answer("First"),
        (play) => {
          // A stop that landed after its turn gave up, then this turn's own execution.
          play.emit("session.execution.interrupted", { sessionID: play.sessionId, reason: "user" });
          return answer("Fresh answer")(play);
        },
      ],
    });
    await drain(runtime.startTurn(request({ turnId: "turn-0" })));
    sessions.records.set(THREAD, { id: "ses_1", unsettled: true });
    const items = await drain(runtime.startTurn(request()));
    expect(fake.calls("GET", "/api/session/active")).toHaveLength(1);
    expect(items.at(-2)).toMatchObject({ kind: "message.completed", text: "Fresh answer" });
  });

  it("fails a prompt OpenCode does not answer in time", async () => {
    const timers = manualClock();
    const env = await connected({ scripts: [answer("late")] }, {}, timers.clock);
    cleanups.push(env.cleanup);
    const release = env.fake.holdPrompt();
    const prompted = env.fake.next("POST", "/prompt");
    const failed = failure(env.runtime.startTurn(request()));
    await prompted;
    timers.fire(60_000);
    expect((await failed).message).toBe("OpenCode did not answer the prompt in time.");
    expect(env.sessions.records.get(THREAD)).toEqual({ id: "ses_1", unsettled: true, fresh: true });
    release();
  });

  it("ends the turn when OpenCode does not answer the interrupt in time", async () => {
    const timers = manualClock();
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const env = await connected(
      {
        scripts: [
          (play) => {
            play.emit("session.execution.started", { sessionID: play.sessionId });
            started();
          },
        ],
      },
      {},
      timers.clock,
    );
    cleanups.push(env.cleanup);
    env.fake.setInterrupt(() => new Promise(() => undefined));
    const turn = env.runtime.startTurn(request());
    const done = drain(turn);
    await running;
    const asked = env.fake.next("POST", "/interrupt");
    turn.interrupt();
    await asked;
    timers.fire(10_000);
    expect(await done).toEqual([]);
    expect(env.sessions.records.get(THREAD)).toMatchObject({ id: "ses_1", unsettled: true });
  });

  it("reads back a turn that ended while its event stream was down", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const { fake, runtime, sessions } = await setup({
      scripts: [
        (play) => {
          play.emit("session.execution.started", { sessionID: play.sessionId });
          play.emit("session.text.delta", { ...ids(play), ordinal: 0, delta: "Hel" });
          started();
        },
      ],
    });
    const done = drain(runtime.startTurn(request()));
    await running;
    // What OpenCode did while the stream was down: only its history has it.
    fake.record("ses_1", {
      id: "msg_old",
      type: "assistant",
      content: [{ type: "text", text: "Old" }],
    });
    fake.record("ses_1", { id: "msg_jhin_turn_ses_1:turn-1", type: "user" });
    fake.record("ses_1", {
      id: "msg_a1",
      type: "assistant",
      content: [
        { type: "text", text: "Hello" },
        {
          type: "tool",
          id: "call_1",
          name: "bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            content: [{ type: "text", text: "README.md" }],
          },
        },
      ],
    });
    fake.record("ses_1", { id: "msg_i1", type: "idle", outcome: "succeeded" });
    fake.active.delete("ses_1");
    fake.dropStreams();
    const items = await done;
    expect(items.filter((item) => item.kind !== "message.delta")).toEqual([
      { kind: "message.completed", itemId: "msg_a1:text:0", text: "Hello" },
      {
        kind: "tool.started",
        itemId: "call_1",
        tool: expect.objectContaining({ name: "bash", kind: "command" }),
      },
      { kind: "tool.completed", itemId: "call_1", status: "completed", output: "README.md" },
    ]);
    expect(sessions.records.get(THREAD)).toEqual({ id: "ses_1", turnId: "turn-1" });
  });

  it("goes on with a turn still running once its stream is open again", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    let reopened!: () => void;
    const back = new Promise<void>((resolve) => (reopened = resolve));
    const { fake, runtime } = await setup({
      scripts: [
        async (play) => {
          play.emit("session.execution.started", { sessionID: play.sessionId });
          started();
          await back;
          await answer("Still here")(play);
        },
      ],
    });
    const done = drain(runtime.startTurn(request()));
    await running;
    fake.resetStreamOpened();
    const read = fake.next("GET", "/message");
    fake.dropStreams();
    await fake.streamOpened();
    await read;
    reopened();
    expect((await done).at(-2)).toMatchObject({ kind: "message.completed", text: "Still here" });
  });

  it("fails a turn whose event stream is lost, and lets the next one wait for the stop", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const timers = manualClock();
    const env = await connected(
      {
        scripts: [
          (play) => {
            play.emit("session.execution.started", { sessionID: play.sessionId });
            started();
          },
          answer("Back"),
        ],
      },
      {},
      timers.clock,
    );
    cleanups.push(env.cleanup);
    const { fake, runtime, sessions } = env;
    const lost = failure(runtime.startTurn(request()));
    await running;
    fake.refuseStreams(5);
    fake.dropStreams();
    for (let attempt = 1; attempt < 5; attempt++) {
      await timers.armed(2_000);
      timers.fire(2_000);
    }
    expect((await lost).message).toBe(RECONNECT_FAILED);
    // Recorded, so the check survives a reload of the plugin.
    expect(sessions.records.get(THREAD)).toEqual({
      id: "ses_1",
      unsettled: true,
      turnId: "turn-1",
    });

    // OpenCode still runs the lost turn: the next turn stops it and asks to send again.
    expect(fake.active.has("ses_1")).toBe(true);
    expect((await failure(runtime.startTurn(request({ turnId: "turn-2" })))).message).toBe(
      STILL_STOPPING,
    );
    expect(fake.calls("POST", "/interrupt")).toHaveLength(1);
    expect(sessions.records.get(THREAD)).toEqual({
      id: "ses_1",
      unsettled: true,
      turnId: "turn-1",
    });

    // Stopped now: the one after runs, on a stream opened again.
    const items = await drain(runtime.startTurn(request({ turnId: "turn-3" })));
    expect(items.at(-2)).toMatchObject({ kind: "message.completed", text: "Back" });
    expect(sessions.records.get(THREAD)).toEqual({ id: "ses_1", turnId: "turn-3" });
  });
});
