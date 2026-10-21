import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { noopLogger } from "@jhin/kernel";
import {
  LIVE_STREAMS_CAPABILITY,
  createLiveStreams,
  createPeerPair,
  createRpcClient,
  serveRpc,
  type LiveStreams,
  type Peer,
  type RpcClient,
} from "@jhin/rpc";
import { TerminalEvents, terminalStream } from "@jhin/terminal-api";
import {
  connectInMemory,
  createMemoryNetwork,
  createTestKernel,
  mockCapability,
  startMeshNode,
  type TestKernel,
} from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import terminal from "../../../plugins/terminal/src/index.ts";
import {
  TERMINAL_OUTPUT_WINDOW,
  attachTerminal,
  type TerminalSink,
} from "../src/plugins/terminal/attach.ts";
import { terminalChannel } from "../src/plugins/terminal/channel.ts";

const manifest = JSON.parse(
  Fs.readFileSync(new URL("../../../plugins/terminal/package.json", import.meta.url), "utf8"),
).jhin;

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function node() {
  const cwd = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-web-terminal-"));
  const live = createLiveStreams();
  const kernel = await createTestKernel({
    plugins: [mockCapability(LIVE_STREAMS_CAPABILITY, live), { manifest, definition: terminal }],
    config: { node: { "jhin.terminal": { shell: "/bin/sh" } } },
  });
  const connection = connectInMemory(kernel, { streams: live });
  stops.push(async () => {
    connection.client.close();
    await kernel.stop();
    Fs.rmSync(cwd, { recursive: true, force: true });
  });
  return { ...connection, cwd, kernel, live };
}

/**
 * A client whose connection the test cuts and lets back in: while it is
 * away, other things happen on the node.
 */
function gatedClient(kernel: TestKernel, live: LiveStreams) {
  let gate: Promise<void> = Promise.resolve();
  let server: Peer | undefined;
  const client: RpcClient = createRpcClient({
    retryDelay: () => 0,
    async connect() {
      await gate;
      const [clientEnd, serverEnd] = createPeerPair();
      server = serverEnd;
      serveRpc(serverEnd, {
        execute: (name, input, invocation) => kernel.commands.execute(name, input, invocation),
        caller: { id: "owner", permissions: ["*"] },
        streams: live,
        hello: () => ({}),
        newTraceId: () => "trace",
        logger: noopLogger,
      });
      return clientEnd;
    },
  });
  stops.push(async () => client.close());
  /** Drops the connection and holds it off; resolves once the client knows. */
  const cut = async () => {
    let letIn!: () => void;
    gate = new Promise((resolve) => (letIn = resolve));
    const away = new Promise<void>((resolve) => {
      const watching = client.onState((state) => {
        if (state === "open") return;
        watching.dispose();
        resolve();
      });
    });
    server?.close(1006, "cut by test");
    await away;
    return letIn;
  };
  return { client, cut };
}

/** A sink recording what a viewport would show; `until` waits for a fact about it. */
function recorder() {
  const log: { kind: string; text: string; replay?: boolean }[] = [];
  const waiters: { test: () => boolean; resolve: () => void }[] = [];
  const settle = () => {
    for (const waiter of waiters.filter((item) => item.test())) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  const screen = () => {
    const last = log.findLastIndex((entry) => entry.kind === "reset");
    return log
      .slice(last + 1)
      .filter((entry) => entry.kind === "write" || entry.kind === "system")
      .map((entry) => entry.text)
      .join("");
  };
  const sink: TerminalSink = {
    reset: () => (log.push({ kind: "reset", text: "" }), settle()),
    write: (text, replay) => (log.push({ kind: "write", text, replay }), settle()),
    system: (text) => (log.push({ kind: "system", text }), settle()),
    ended: (reason) => (log.push({ kind: "ended", text: reason }), settle()),
  };
  const until = (test: () => boolean) =>
    test() ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ test, resolve }));
  return {
    log,
    sink,
    screen,
    until,
    shows: (text: string) => until(() => screen().includes(text)),
  };
}

const size = () => ({ cols: 80, rows: 24 });

/**
 * What a `terminal.sessions@1.0` node answers: no `instance` in summaries,
 * snapshots or `TERMINAL_NOT_FOUND`'s details.
 */
function asOneZeroNode(client: RpcClient): RpcClient {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (typeof value !== "object" || value === null) return value;
    const { instance: _instance, ...rest } = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(rest).map(([key, item]) => [key, strip(item)]));
  };
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== "call") return Reflect.get(target, property, receiver);
      return async (method: string, params?: unknown, options?: { trace?: string }) => {
        try {
          return strip(await target.call(method, params, options));
        } catch (error) {
          const failure = error as { code?: string; details?: unknown; message: string };
          throw Object.assign(new Error(failure.message), {
            code: failure.code,
            details: strip(failure.details),
          });
        }
      };
    },
  });
}

describe("attaching a terminal (the drawer's viewport)", () => {
  it("opens the shell, streams what it prints, and ends with the process", async () => {
    const { client, cwd } = await node();
    const view = recorder();
    const attached = attachTerminal({
      client,
      threadId: "t",
      terminalId: "term-1",
      cwd,
      size,
      sink: view.sink,
    });
    await view.until(() => view.log.some((entry) => entry.kind === "reset"));
    await client.call("terminals.write", {
      threadId: "t",
      terminalId: "term-1",
      data: "echo web-$((2*21))\r",
    });
    await view.shows("web-42");

    await client.call("terminals.write", { threadId: "t", terminalId: "term-1", data: "exit\r" });
    await view.until(() => view.log.some((entry) => entry.kind === "ended"));
    expect(view.log.filter((entry) => entry.kind === "ended")).toEqual([
      { kind: "ended", text: "exited" },
    ]);
    expect(view.screen()).toContain("Process exited");
    attached.dispose();
  });

  it("keeps what is typed before the terminal is open and sends it then", async () => {
    const { client, cwd } = await node();
    const view = recorder();
    const attached = attachTerminal({
      client,
      threadId: "t",
      terminalId: "term-1",
      cwd,
      size,
      sink: view.sink,
    });
    // Typed at once, while the shell is still starting.
    attached.write("echo early-$((2+3))\r");
    await view.shows("early-5");
    expect(view.screen()).not.toContain("No terminal");
    attached.dispose();
  });

  it("ends at once for a shell that exited while nobody watched, without a new one", async () => {
    const { client, cwd } = await node();
    const input = { threadId: "t", terminalId: "term-1", cwd };
    const opened = await client.call<{ pid: number }>("terminals.open", input);
    const exited = new Promise<void>((resolve) =>
      client.subscribe(terminalStream("t", "term-1"), {}, (event) => {
        if (event.type === TerminalEvents.exited) resolve();
      }),
    );
    await client.call("terminals.write", { ...input, data: "echo bye-$((4+4)); exit\r" });
    await exited;

    const view = recorder();
    attachTerminal({ ...input, client, size, sink: view.sink });
    await view.until(() => view.log.some((entry) => entry.kind === "ended"));
    expect(view.log.filter((entry) => entry.kind === "ended")).toEqual([
      { kind: "ended", text: "exited" },
    ]);
    expect(view.screen()).toContain("bye-8");
    // Still the old, exited session: nothing started in its place.
    expect(await client.call("terminals.get", input)).toMatchObject({
      status: "exited",
      pid: opened.pid,
    });
  });

  it("shows a second client what the terminal printed before, as a replay", async () => {
    const { client, cwd } = await node();
    const first = recorder();
    attachTerminal({ client, threadId: "t", terminalId: "term-1", cwd, size, sink: first.sink });
    await first.until(() => first.log.some((entry) => entry.kind === "reset"));
    await client.call("terminals.write", {
      threadId: "t",
      terminalId: "term-1",
      data: "echo before-$((1+1))\r",
    });
    await first.shows("before-2");

    const second = recorder();
    attachTerminal({ client, threadId: "t", terminalId: "term-1", cwd, size, sink: second.sink });
    await second.shows("before-2");
    expect(second.log.find((entry) => entry.text.includes("before-2"))?.replay).toBe(true);

    // Both follow what comes next.
    await client.call("terminals.write", {
      threadId: "t",
      terminalId: "term-1",
      data: "echo after-$((1+2))\r",
    });
    await Promise.all([first.shows("after-3"), second.shows("after-3")]);
  });

  it("says the terminal closed when another client closes it", async () => {
    const { client, cwd } = await node();
    const view = recorder();
    attachTerminal({ client, threadId: "t", terminalId: "term-1", cwd, size, sink: view.sink });
    await view.until(() => view.log.some((entry) => entry.kind === "reset"));
    await client.call("terminals.close", { threadId: "t", terminalId: "term-1" });
    await view.until(() => view.log.some((entry) => entry.kind === "ended"));
    expect(view.log.at(-1)).toEqual({ kind: "ended", text: "closed" });
    expect(view.screen()).toContain("Terminal closed");
  });

  it("opens the terminal again when the connection comes back", async () => {
    const { client, cwd, drop } = await node();
    const view = recorder();
    attachTerminal({ client, threadId: "t", terminalId: "term-1", cwd, size, sink: view.sink });
    await view.until(() => view.log.some((entry) => entry.kind === "reset"));
    await client.call("terminals.write", {
      threadId: "t",
      terminalId: "term-1",
      data: "echo kept-$((3*3))\r",
    });
    await view.shows("kept-9");

    drop();
    // Read again from the node: the screen starts over with what the node kept.
    await view.until(() => view.log.filter((entry) => entry.kind === "reset").length === 2);
    await view.shows("kept-9");
    await client.call("terminals.write", {
      threadId: "t",
      terminalId: "term-1",
      data: "echo again-$((2+2))\r",
    });
    await view.shows("again-4");
  });

  it("does not bring back a terminal closed elsewhere while the connection was away", async () => {
    const { client: other, cwd, kernel, live } = await node();
    const { client, cut } = gatedClient(kernel, live);
    const input = { threadId: "t", terminalId: "term-1", cwd };
    const view = recorder();
    attachTerminal({ ...input, client, size, sink: view.sink });
    await view.until(() => view.log.some((entry) => entry.kind === "reset"));

    const letIn = await cut();
    await other.call("terminals.close", input);
    letIn();

    await view.until(() => view.log.some((entry) => entry.kind === "ended"));
    expect(view.log.filter((entry) => entry.kind === "ended")).toEqual([
      { kind: "ended", text: "closed" },
    ]);
    // Nothing opened in its place.
    expect(await other.call("terminals.list", {})).toEqual({ terminals: [] });
  });

  it("opens the terminal again when the node started over while the connection was away", async () => {
    const { client: other, cwd, kernel, live } = await node();
    const { client, cut } = gatedClient(kernel, live);
    const input = { threadId: "t", terminalId: "term-1", cwd };
    const view = recorder();
    attachTerminal({ ...input, client, size, sink: view.sink });
    await view.until(() => view.log.some((entry) => entry.kind === "reset"));

    const letIn = await cut();
    // The node's terminals start over (as after a restart): a new run, no sessions.
    await kernel.reload("jhin.terminal");
    letIn();

    await view.until(() => view.log.filter((entry) => entry.kind === "reset").length === 2);
    expect(view.log.some((entry) => entry.kind === "ended")).toBe(false);
    const { terminals } = await other.call<{ terminals: { status: string }[] }>(
      "terminals.list",
      {},
    );
    expect(terminals).toMatchObject([{ status: "running" }]);
  });

  it("opens a new shell against a 1.0 node, which names no run, when its session is gone (D471)", async () => {
    const { client: other, cwd, kernel, live } = await node();
    const { client: gated, cut } = gatedClient(kernel, live);
    const client = asOneZeroNode(gated);
    const input = { threadId: "t", terminalId: "term-1", cwd };
    const view = recorder();
    attachTerminal({ ...input, client, size, sink: view.sink });
    await view.until(() => view.log.some((entry) => entry.kind === "reset"));
    const first = await other.call<{ pid: number }>("terminals.get", input);

    const letIn = await cut();
    // Closed elsewhere while the connection was away: a 1.1 node would say
    // it is the same run; a 1.0 node cannot, so the session's absence reads
    // as a node that started over.
    await other.call("terminals.close", input);
    letIn();

    await view.until(() => view.log.filter((entry) => entry.kind === "reset").length === 2);
    expect(view.log.some((entry) => entry.kind === "ended")).toBe(false);
    const second = await other.call<{ pid: number; status: string }>("terminals.get", input);
    expect(second.status).toBe("running");
    expect(second.pid).not.toBe(first.pid);
  });

  it("starts a new shell for one that exited when asked to restart it (D463)", async () => {
    const { client, cwd } = await node();
    const input = { threadId: "t", terminalId: "term-1", cwd };
    const opened = await client.call<{ pid: number }>("terminals.open", input);
    const exited = new Promise<void>((resolve) =>
      client.subscribe(terminalStream("t", "term-1"), {}, (event) => {
        if (event.type === TerminalEvents.exited) resolve();
      }),
    );
    await client.call("terminals.write", { ...input, data: "exit\r" });
    await exited;

    const view = recorder();
    const attached = attachTerminal({
      ...input,
      client,
      size,
      sink: view.sink,
      restartIfNotRunning: true,
      env: { W15_VAR: "kept" },
    });
    await view.until(() => view.log.some((entry) => entry.kind === "reset"));
    // The new shell has the terminal's own variables.
    attached.write("echo v-$W15_VAR\r");
    await view.shows("v-kept");
    const now = await client.call<{ pid: number; status: string }>("terminals.get", input);
    expect(now.status).toBe("running");
    expect(now.pid).not.toBe(opened.pid);
    expect(view.log.some((entry) => entry.kind === "ended")).toBe(false);
  });

  it("has at most T3's output window on its way, and gets the rest as output is shown (D470)", async () => {
    const { client, cwd } = await node();
    const input = { threadId: "t", terminalId: "term-1", cwd };
    const shown: (() => void)[] = [];
    let release = false;
    let written = "";
    const view = recorder();
    const sink: TerminalSink = {
      ...view.sink,
      write(data, replay) {
        written += data;
        view.sink.write(data, replay);
        // Shown only when the test says so: a slow client.
        if (replay || release) return undefined;
        return new Promise<void>((resolve) => shown.push(resolve));
      },
    };
    const attached = attachTerminal({ ...input, client, size, sink });
    await view.until(() => view.log.some((entry) => entry.kind === "reset"));
    // Another client, without a window, sees the whole run.
    const observer = new Promise<void>((resolve) => {
      let seen = "";
      client.subscribe(terminalStream("t", "term-1"), {}, (event) => {
        if (event.type !== TerminalEvents.output) return;
        seen += (event.payload as { data: string }).data;
        if (seen.includes("\n20000")) resolve();
      });
    });
    attached.write("seq 1 20000\r");
    await observer;
    // Everything sent before this answer arrived first: at most the window.
    await client.call("terminals.list", {});
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThanOrEqual(TERMINAL_OUTPUT_WINDOW.events);
    expect(written).not.toContain("\n20000");

    // Showing what came lets the rest come.
    release = true;
    for (const resolve of shown.splice(0)) resolve();
    await view.until(() => written.includes("\n20000"));
    attached.dispose();
  });

  it("reads the terminal again when the node ends a subscription that fell behind (D470)", async () => {
    const { client, cwd } = await node();
    const input = { threadId: "t", terminalId: "term-1", cwd };
    let ended = false;
    // The node's first subscription ends at its first event, as an overflow does.
    const overflowing = new Proxy(client, {
      get(target, property, receiver) {
        if (property !== "subscribe") return Reflect.get(target, property, receiver);
        return (
          stream: string,
          options: Parameters<RpcClient["subscribe"]>[1],
          onEvent: Parameters<RpcClient["subscribe"]>[2],
        ) => {
          const subscription = target.subscribe(stream, options, (event) => {
            if (ended) return onEvent(event);
            ended = true;
            subscription.dispose();
            options.onError?.(
              Object.assign(new Error("fell too far behind"), {
                code: "SUBSCRIPTION_OVERFLOW",
              }) as never,
            );
          });
          return subscription;
        };
      },
    });
    const view = recorder();
    const attached = attachTerminal({ ...input, client: overflowing, size, sink: view.sink });
    await view.until(() => view.log.some((entry) => entry.kind === "reset"));
    attached.write("echo back-$((20+22))\r");
    await view.shows("back-42");
    expect(view.log.filter((entry) => entry.kind === "reset")).toHaveLength(2);
    expect(view.screen()).not.toContain("fell too far behind");
  });

  it("shows why a terminal cannot open", async () => {
    const { client, cwd } = await node();
    const view = recorder();
    attachTerminal({
      client,
      threadId: "t",
      terminalId: "term-1",
      cwd: Path.join(cwd, "missing"),
      size,
      sink: view.sink,
    });
    await view.shows("Terminal cwd does not exist");
  });
});

describe("a terminal of a thread on a mesh member (D504)", () => {
  /** A client of a, and c with the terminal plugin, joined to a's mesh. */
  async function member(options: { relays?: boolean } = {}) {
    const network = createMemoryNetwork();
    // a, the connected node, runs no terminal plugin: what runs is c's.
    const a = await startMeshNode(network, "a");
    const c = await startMeshNode(network, "c", {
      plugins: [{ manifest, definition: terminal }],
      config: { node: { "jhin.terminal": { shell: "/bin/sh" } } },
    });
    const cwd = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-web-terminal-member-"));
    await c.join(a);
    const connection = a.connect();
    if (options.relays === false) {
      // A node from before relays: mesh.relay is no command there.
      const call = connection.client.call.bind(connection.client);
      connection.client.call = (async (method: string, params?: unknown) =>
        method === "mesh.relay"
          ? Promise.reject(
              Object.assign(new Error("no such command"), { code: "COMMAND_NOT_FOUND" }),
            )
          : call(method, params)) as typeof connection.client.call;
    }
    stops.push(async () => {
      await a.stop();
      await c.stop();
      Fs.rmSync(cwd, { recursive: true, force: true });
    });
    return { channel: terminalChannel(connection.client, "c"), client: connection.client, cwd };
  }

  it("opens the member's shell through the connected node and streams it through the relay", async () => {
    const { channel, client, cwd } = await member();
    expect(terminalChannel(client, "c")).toBe(channel);
    const view = recorder();
    const attached = attachTerminal({
      client: channel,
      threadId: "t",
      terminalId: "term-1",
      cwd,
      size,
      sink: view.sink,
    });
    attached.write("echo member-$((6*7))\r");
    await view.shows("member-42");
    // It runs on c: the connected node has no terminal plugin at all.
    await expect(
      client.call("terminals.get", { threadId: "t", terminalId: "term-1" }),
    ).rejects.toMatchObject({ code: "COMMAND_NOT_FOUND" });

    attached.write("exit\r");
    await view.until(() => view.log.some((entry) => entry.kind === "ended"));
    expect(view.screen()).toContain("Process exited");
    attached.dispose();
  });

  it("says so in the terminal when the connected node cannot relay", async () => {
    const { channel, cwd } = await member({ relays: false });
    const view = recorder();
    const attached = attachTerminal({
      client: channel,
      threadId: "t",
      terminalId: "term-1",
      cwd,
      size,
      sink: view.sink,
    });
    await view.shows("This node cannot stream terminals of other nodes of its mesh");
    attached.dispose();
  });
});
