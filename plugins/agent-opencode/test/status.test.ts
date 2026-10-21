import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { Config, createOpenCodeRuntime, parseVersion, serverEnvironment } from "../src/index.ts";
import { createServerOwner } from "../src/server.ts";
import { answer, fakeOpenCode } from "./fake-server.ts";
import { PASSWORD, drain, manualClock, memorySessions, request } from "./support.ts";

const FAKE_BINARY = fileURLToPath(new URL("./fake-opencode.mjs", import.meta.url));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function runtime(settings: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env) {
  const config = Config.parse(settings);
  const server = createServerOwner({ settings: () => config, env: () => env, idleMs: () => 0 });
  const opencode = createOpenCodeRuntime({
    server,
    sessions: memorySessions().store,
    config: () => config,
    env: () => env,
  });
  cleanups.push(() => opencode.dispose());
  return opencode;
}

describe("jhin.agent-opencode: status", () => {
  it("is off until enabled, and starts nothing", async () => {
    const opencode = runtime({ binaryPath: "/nonexistent/opencode" });
    expect(await opencode.status!()).toEqual({
      available: false,
      message: "OpenCode is disabled in Jhin settings.",
    });
    expect(opencode.models).toEqual([]);
  });

  it("lists a configured server's models with OpenCode's default", async () => {
    const fake = await fakeOpenCode({ password: PASSWORD });
    cleanups.push(() => fake.close());
    const opencode = runtime({ enabled: true, serverUrl: fake.url, serverPassword: PASSWORD });
    expect(await opencode.status!()).toEqual({
      available: true,
      version: "2.0.29",
      message: "OpenCode 2.0.29 lists 2 models.",
    });
    expect(opencode.models).toEqual([
      { id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5", description: "anthropic" },
      { id: "openai/gpt-6", name: "GPT-6", description: "openai" },
    ]);
    expect(opencode.defaultModel).toBe("anthropic/claude-sonnet-5-5");
    // The probe needs no event stream.
    expect(fake.calls("GET", "/api/event")).toEqual([]);
  });

  it("says when the server rejects the password", async () => {
    const fake = await fakeOpenCode({ password: PASSWORD });
    cleanups.push(() => fake.close());
    const opencode = runtime({ enabled: true, serverUrl: fake.url, serverPassword: "wrong" });
    expect(await opencode.status!()).toEqual({
      available: false,
      message: "The OpenCode server rejected the server password.",
    });
  });

  it("says when OpenCode is not installed", async () => {
    const opencode = runtime({ enabled: true, binaryPath: "/nonexistent/opencode" });
    expect(await opencode.status!()).toEqual({
      available: false,
      message: "OpenCode CLI (`/nonexistent/opencode`) is not installed or not on PATH.",
    });
  });

  it("refuses a configured server that is not OpenCode 2", async () => {
    const fake = await fakeOpenCode({ password: PASSWORD, version: "1.14.20" });
    cleanups.push(() => fake.close());
    const opencode = runtime({ enabled: true, serverUrl: fake.url, serverPassword: PASSWORD });
    expect(await opencode.status!()).toEqual({
      available: false,
      version: "1.14.20",
      message: "OpenCode v1.14.20 is too old. Upgrade to OpenCode 2.",
    });
  });

  it("refuses OpenCode 1.x", async () => {
    const opencode = runtime(
      { enabled: true, binaryPath: FAKE_BINARY },
      { ...process.env, FAKE_OPENCODE_VERSION: "1.14.20" },
    );
    expect(await opencode.status!()).toEqual({
      available: false,
      version: "1.14.20",
      message: "OpenCode v1.14.20 is too old. Upgrade to OpenCode 2.",
    });
  });

  it("parses the version as T3's probe does", () => {
    expect(parseVersion("opencode v2.0.3")).toBe("2.0.3");
    expect(parseVersion("1.14.20\n")).toBe("1.14.20");
    expect(parseVersion("opencode")).toBeUndefined();
  });
});

describe("jhin.agent-opencode: the server it starts", () => {
  it("starts `opencode serve` with its own password and runs turns on it", async () => {
    const log = Path.join(Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-opencode-")), "serve.json");
    const started = () =>
      Fs.existsSync(log)
        ? (JSON.parse(Fs.readFileSync(log, "utf8")) as {
            args: string[];
            password: string;
            inherited: string | null;
          })
        : undefined;
    // The fake server takes the password the binary was started with.
    const fake = await fakeOpenCode({
      password: () => started()?.password,
      scripts: [answer("Hi")],
    });
    cleanups.push(() => fake.close());
    const opencode = runtime(
      { enabled: true, binaryPath: FAKE_BINARY },
      {
        ...process.env,
        FAKE_OPENCODE_URL: fake.url,
        FAKE_OPENCODE_LOG: log,
        OPENCODE_SERVER_PASSWORD: "inherited",
      },
    );

    expect(await opencode.status!()).toMatchObject({ available: true });
    const serve = started()!;
    expect(serve.args.slice(0, 2)).toEqual(["serve", "--hostname=127.0.0.1"]);
    expect(serve.args[2]).toMatch(/^--port=\d+$/);
    expect(serve.password).toMatch(/^[\w-]{43}$/);
    // OPENCODE_PASSWORD wins in OpenCode 2; the inherited 1.x variable is dropped.
    expect(serve.inherited).toBeNull();

    const items = await drain(opencode.startTurn(request()));
    expect(items.at(-2)).toMatchObject({ kind: "message.completed", text: "Hi" });
  });

  it("drops the inherited 1.x password from the server's environment", () => {
    expect(serverEnvironment({ OPENCODE_SERVER_PASSWORD: "old", PATH: "/bin" }, "new")).toEqual({
      PATH: "/bin",
      OPENCODE_PASSWORD: "new",
    });
  });
});

describe("jhin.agent-opencode: a settings change", () => {
  it("keeps the old server for the turn running on it and gives new turns the new one", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let playing!: () => void;
    const started = new Promise<void>((resolve) => (playing = resolve));
    const first = await fakeOpenCode({
      password: PASSWORD,
      scripts: [
        async (play) => {
          play.emit("session.execution.started", { sessionID: play.sessionId });
          playing();
          await held;
          answer("From the first server")(play);
        },
      ],
    });
    const second = await fakeOpenCode({ password: PASSWORD, scripts: [answer("From the second")] });
    cleanups.push(
      () => first.close(),
      () => second.close(),
    );
    let config = Config.parse({ enabled: true, serverUrl: first.url, serverPassword: PASSWORD });
    const server = createServerOwner({
      settings: () => config,
      env: () => process.env,
      idleMs: () => 0,
    });
    const opencode = createOpenCodeRuntime({
      server,
      sessions: memorySessions().store,
      config: () => config,
    });
    cleanups.push(() => opencode.dispose());

    const running = drain(opencode.startTurn(request()));
    await started;
    config = Config.parse({ enabled: true, serverUrl: second.url, serverPassword: PASSWORD });
    const other = await drain(opencode.startTurn(request({ threadId: "other", turnId: "t2" })));
    expect(other.at(-2)).toMatchObject({ text: "From the second" });

    release();
    expect((await running).at(-2)).toMatchObject({ text: "From the first server" });
  });

  it("stops a server it took out of service when it is disposed, though a turn still uses it", async () => {
    let playing!: () => void;
    const started = new Promise<void>((resolve) => (playing = resolve));
    const first = await fakeOpenCode({
      password: PASSWORD,
      scripts: [
        (play) => {
          play.emit("session.execution.started", { sessionID: play.sessionId });
          playing();
        },
      ],
    });
    const second = await fakeOpenCode({ password: PASSWORD, scripts: [answer("ok")] });
    cleanups.push(
      () => first.close(),
      () => second.close(),
    );
    let config = Config.parse({ enabled: true, serverUrl: first.url, serverPassword: PASSWORD });
    const server = createServerOwner({
      settings: () => config,
      env: () => process.env,
      idleMs: () => 0,
    });
    const opencode = createOpenCodeRuntime({
      server,
      sessions: memorySessions().store,
      config: () => config,
    });
    void drain(opencode.startTurn(request())).catch(() => undefined);
    await started;
    config = Config.parse({ enabled: true, serverUrl: second.url, serverPassword: PASSWORD });
    await drain(opencode.startTurn(request({ threadId: "other", turnId: "t2" })));
    // The first server still serves its turn; disposing the owner closes its stream too.
    const closed = first.streamClosed();
    server.dispose();
    await closed;
  });
});

describe("jhin.agent-opencode: the server owner", () => {
  it("keeps every other session's events when one session's handler fails", async () => {
    const fake = await fakeOpenCode({ password: PASSWORD });
    cleanups.push(() => fake.close());
    const config = Config.parse({ enabled: true, serverUrl: fake.url, serverPassword: PASSWORD });
    const server = createServerOwner({
      settings: () => config,
      env: () => process.env,
      idleMs: () => 0,
    });
    cleanups.push(() => server.dispose());
    await server.use(async (connection) => {
      connection.listen("ses_a", () => {
        throw new Error("broken handler");
      });
      const received = new Promise<string>((resolve) =>
        connection.listen("ses_b", (event) => resolve(event.type)),
      );
      let lost = false;
      connection.onLost(() => (lost = true));
      fake.emit("session.text.delta", { sessionID: "ses_a", delta: "x" });
      fake.emit("session.execution.started", { sessionID: "ses_b" });
      expect(await received).toBe("session.execution.started");
      expect(lost).toBe(false);
    });
  });

  it("applies a changed idle time to a server waiting idle", async () => {
    const fake = await fakeOpenCode({ password: PASSWORD });
    cleanups.push(() => fake.close());
    const config = Config.parse({ enabled: true, serverUrl: fake.url, serverPassword: PASSWORD });
    const timers = manualClock();
    let idleMs = 600_000;
    const server = createServerOwner({
      settings: () => config,
      env: () => process.env,
      idleMs: () => idleMs,
      clock: timers.clock,
    });
    cleanups.push(() => server.dispose());
    await server.use(async () => undefined, false);
    // Turned to 0 (no idle end): the pending ten minutes no longer end it.
    idleMs = 0;
    server.rearm();
    timers.fire(600_000);
    expect(server.running).toBe(true);
    // One minute now: the server ends once it passed.
    idleMs = 60_000;
    server.rearm();
    timers.fire(60_000);
    expect(server.running).toBe(false);
  });
});

describe("jhin.agent-opencode: models", () => {
  it("says when a running OpenCode lists no models yet", async () => {
    const fake = await fakeOpenCode({ password: PASSWORD, models: [] });
    cleanups.push(() => fake.close());
    const config = Config.parse({ enabled: true, serverUrl: fake.url, serverPassword: PASSWORD });
    const waits: number[] = [];
    const clock = {
      after(ms: number, run: () => void) {
        waits.push(ms);
        queueMicrotask(run);
        return () => {};
      },
    };
    const server = createServerOwner({
      settings: () => config,
      env: () => process.env,
      idleMs: () => 0,
    });
    const opencode = createOpenCodeRuntime({
      server,
      sessions: memorySessions().store,
      config: () => config,
      clock,
    });
    cleanups.push(() => opencode.dispose());
    expect(await opencode.status!()).toEqual({
      available: false,
      version: "2.0.29",
      message: "OpenCode 2 is running, but it did not list any models yet.",
    });
    // Five seconds of 250 ms waits for a fresh server to list some.
    expect(waits).toHaveLength(20);
  });

  it("takes a default model cleared to blank as unset", async () => {
    const fake = await fakeOpenCode({ password: PASSWORD });
    cleanups.push(() => fake.close());
    const opencode = runtime({
      enabled: true,
      serverUrl: fake.url,
      serverPassword: PASSWORD,
      defaultModel: " ",
    });
    await opencode.status!();
    expect(opencode.defaultModel).toBe("anthropic/claude-sonnet-5-5");
  });
});
