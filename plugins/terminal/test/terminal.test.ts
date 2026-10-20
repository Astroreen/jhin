import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { THREADS_STREAM, ThreadEvents } from "@jhin/agent-api";
import {
  LIVE_STREAMS_CAPABILITY,
  createLiveStreams,
  createMemoryStreams,
  type RpcClient,
} from "@jhin/rpc";
import type { Logger } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import {
  TERMINALS_STREAM,
  TerminalEvents,
  terminalStream,
  type TerminalSnapshot,
  type TerminalSummary,
} from "@jhin/terminal-api";
import {
  connectInMemory,
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
} from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { parseProcessTable, subprocessOf } from "../src/processes.ts";
import { loadNodePty, type PtySpawner } from "../src/pty.ts";
import { createSessions } from "../src/sessions.ts";
import terminal from "../src/index.ts";

const manifest = JSON.parse(
  Fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).jhin;

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** A node with the terminal plugin, an RPC client and a folder to start terminals in. */
async function node(
  options: {
    streams?: boolean;
    scrollback?: number;
    caller?: { id: string; permissions: string[] };
  } = {},
) {
  const cwd = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-terminal-"));
  const storage = memoryStoragePlugin();
  const live = createLiveStreams();
  const kernel = await createTestKernel({
    plugins: [
      storage,
      ...(options.streams === false ? [] : [mockCapability(LIVE_STREAMS_CAPABILITY, live)]),
      { manifest, definition: terminal },
    ],
    // A plain POSIX shell: no prompt themes or rc files in the way.
    config: {
      node: {
        "jhin.terminal": {
          shell: "/bin/sh",
          ...(options.scrollback === undefined ? {} : { scrollback: options.scrollback }),
        },
      },
    },
  });
  const { client } = connectInMemory(kernel, {
    log: storage.storage.log,
    streams: live,
    ...(options.caller === undefined ? {} : { caller: options.caller }),
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    client.close();
    await kernel.stop();
    Fs.rmSync(cwd, { recursive: true, force: true });
  };
  stops.push(stop);
  return { kernel, client, cwd, storage, stop };
}

/** Follows a stream; resolves waits on events seen or still to come. */
function watch(client: RpcClient, stream: string, after = 0) {
  const events: StoredEvent[] = [];
  const waiters: { test: (events: StoredEvent[]) => boolean; resolve: () => void }[] = [];
  const subscription = client.subscribe(stream, { after }, (event) => {
    events.push(event);
    for (const waiter of waiters.filter((item) => item.test(events))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  });
  const until = (test: (events: StoredEvent[]) => boolean) =>
    test(events)
      ? Promise.resolve(events)
      : new Promise<StoredEvent[]>((resolve) =>
          waiters.push({ test, resolve: () => resolve(events) }),
        );
  const output = () =>
    events
      .filter((event) => event.type === TerminalEvents.output)
      .map((event) => (event.payload as { data: string }).data)
      .join("");
  return {
    events,
    subscription,
    until,
    output,
    untilOutput: (text: string) => until(() => output().includes(text)),
    untilType: (type: string) => until((seen) => seen.some((event) => event.type === type)),
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("jhin.terminal", () => {
  it("opens a PTY in the folder, runs echo, streams its output and closes", async () => {
    const { client, cwd } = await node();
    const opened = await client.call<TerminalSummary>("terminals.open", {
      threadId: "thread-1",
      terminalId: "term-1",
      cwd,
      cols: 80,
      rows: 24,
    });
    expect(opened).toMatchObject({ status: "running", cwd, cols: 80, rows: 24 });
    expect(opened.pid).toBeGreaterThan(0);

    const stream = watch(client, terminalStream("thread-1", "term-1"));
    await stream.untilType(TerminalEvents.started);
    // The arithmetic tells the output from the shell echoing what was typed.
    await client.call("terminals.write", {
      threadId: "thread-1",
      terminalId: "term-1",
      data: "echo jhin-$((6*7)) && pwd\r",
    });
    await stream.untilOutput("jhin-42");
    await stream.untilOutput(Fs.realpathSync(cwd));

    expect(await client.call("terminals.close", { threadId: "thread-1" })).toEqual({ closed: 1 });
    await stream.untilType(TerminalEvents.closed);
    // The exit closing caused is not reported as the process exiting by itself.
    expect(stream.events.map((event) => event.type)).not.toContain(TerminalEvents.exited);
    expect(alive(opened.pid!)).toBe(false);
    expect(await client.call("terminals.list", {})).toEqual({ terminals: [] });
  });

  it("gives a late subscriber the scrollback, and terminals.get the same output", async () => {
    const { client, cwd } = await node();
    await client.call("terminals.open", { threadId: "t", terminalId: "term-1", cwd });
    const first = watch(client, terminalStream("t", "term-1"));
    await client.call("terminals.write", {
      threadId: "t",
      terminalId: "term-1",
      data: "echo early-$((1+1))\r",
    });
    await first.untilOutput("early-2");

    const late = watch(client, terminalStream("t", "term-1"));
    await late.untilOutput("early-2");
    expect(late.events[0]?.type).toBe(TerminalEvents.started);

    const snapshot = await client.call<TerminalSnapshot>("terminals.get", {
      threadId: "t",
      terminalId: "term-1",
    });
    expect(snapshot.history).toContain("early-2");
    expect(snapshot.sequence).toBe(first.events.at(-1)!.sequence);
  });

  it("keeps a terminal opened again while the old one is still being closed", async () => {
    const { client, cwd } = await node();
    const input = { threadId: "t", terminalId: "term-1", cwd };
    await client.call("terminals.open", input);
    const old = watch(client, terminalStream("t", "term-1"));
    // A shell that ignores SIGHUP: closing it takes the whole kill grace.
    await client.call("terminals.write", {
      ...input,
      data: "trap '' HUP; echo trapped-$((1+1))\r",
    });
    await old.untilOutput("trapped-2");

    const sessions = watch(client, TERMINALS_STREAM);
    const listed = () =>
      (sessions.events.at(-1)?.payload as { terminals: TerminalSummary[] } | undefined)?.terminals;
    await sessions.until(() => listed()?.length === 1);
    const closing = client.call("terminals.close", input);
    // Gone from the list at once; its process is still being stopped.
    await sessions.until(() => listed()?.length === 0);
    const reopened = await client.call<TerminalSummary>("terminals.open", input);
    const fresh = watch(client, terminalStream("t", "term-1"));
    await fresh.untilType(TerminalEvents.started);
    await client.call("terminals.write", { ...input, data: "echo new-$((5*5))\r" });
    await fresh.untilOutput("new-25");
    await closing;

    // The old close neither ended the new stream nor wiped what it printed.
    expect(fresh.events.map((event) => event.type)).not.toContain(TerminalEvents.closed);
    const snapshot = await client.call<TerminalSnapshot>("terminals.get", input);
    expect(snapshot).toMatchObject({ pid: reopened.pid, status: "running" });
    expect(snapshot.history).toContain("new-25");
  });

  it("forgets the oldest output past the scrollback, and keeps the stream's start", async () => {
    const { client, cwd } = await node({ scrollback: 100 });
    const input = { threadId: "t", terminalId: "term-1", cwd };
    await client.call("terminals.open", input);
    const stream = watch(client, terminalStream("t", "term-1"));
    await client.call("terminals.write", { ...input, data: "seq 1 300\r" });
    await stream.untilOutput("\n300");
    await client.call("terminals.write", { ...input, data: "echo done-$((2*2))\r" });
    await stream.untilOutput("done-4");

    const late = watch(client, terminalStream("t", "term-1"));
    await late.untilOutput("done-4");
    expect(late.events[0]?.type).toBe(TerminalEvents.started);
    expect(late.output()).not.toMatch(/\n2\r\n3\r\n4\r\n/);
  });

  it("lets only callers with terminals.read follow terminal streams", async () => {
    const { client, cwd } = await node({
      caller: { id: "writer", permissions: ["terminals.write"] },
    });
    await client.call("terminals.open", { threadId: "t", terminalId: "term-1", cwd });
    for (const stream of [terminalStream("t", "term-1"), TERMINALS_STREAM]) {
      await expect(
        new Promise((_, reject) => client.subscribe(stream, { onError: reject }, () => undefined)),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
  });

  it("starts one process for two opens at once, and resizes on open", async () => {
    const { client, cwd } = await node();
    const input = { threadId: "t", terminalId: "term-1", cwd };
    const [a, b] = await Promise.all([
      client.call<TerminalSummary>("terminals.open", input),
      client.call<TerminalSummary>("terminals.open", input),
    ]);
    expect(a.pid).toBe(b.pid);
    const resized = await client.call<TerminalSummary>("terminals.open", {
      ...input,
      cols: 100,
      rows: 40,
    });
    expect(resized).toMatchObject({ pid: a.pid, cols: 100, rows: 40 });
    const { terminals } = await client.call<{ terminals: TerminalSummary[] }>("terminals.list", {});
    expect(terminals).toHaveLength(1);
  });

  it("reports an exited shell, and starts a new one when it is opened again", async () => {
    const { client, cwd } = await node();
    const input = { threadId: "t", terminalId: "term-1", cwd };
    const first = await client.call<TerminalSummary>("terminals.open", input);
    const stream = watch(client, terminalStream("t", "term-1"));
    await stream.untilType(TerminalEvents.started);
    await client.call("terminals.write", { ...input, data: "exit 3\r" }).catch(() => undefined);
    await stream.untilType(TerminalEvents.exited);
    expect(stream.events.find((event) => event.type === TerminalEvents.exited)?.payload).toEqual({
      exitCode: 3,
      signal: expect.anything(),
    });
    await expect(client.call("terminals.write", { ...input, data: "x" })).rejects.toMatchObject({
      code: "TERMINAL_NOT_RUNNING",
    });

    const again = await client.call<TerminalSummary>("terminals.open", input);
    expect(again.status).toBe("running");
    expect(again.pid).not.toBe(first.pid);
    await stream.until(
      (seen) => seen.filter((event) => event.type === TerminalEvents.started).length === 2,
    );
  });

  it("refuses a folder that is not there and a terminal that is not open", async () => {
    const { client, cwd } = await node();
    await expect(
      client.call("terminals.open", {
        threadId: "t",
        terminalId: "term-1",
        cwd: Path.join(cwd, "missing"),
      }),
    ).rejects.toMatchObject({ code: "TERMINAL_CWD_INVALID" });
    Fs.writeFileSync(Path.join(cwd, "file"), "");
    await expect(
      client.call("terminals.open", {
        threadId: "t",
        terminalId: "term-1",
        cwd: Path.join(cwd, "file"),
      }),
    ).rejects.toMatchObject({ code: "TERMINAL_CWD_INVALID" });
    await expect(
      client.call("terminals.write", { threadId: "t", terminalId: "term-9", data: "x" }),
    ).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" });
    await expect(
      client.call("terminals.open", { threadId: "a/b", terminalId: "term-1", cwd }),
    ).rejects.toMatchObject({ code: "COMMAND_INPUT_INVALID" });
  });

  it("sends the node's sessions on the terminals stream, with the program each runs", async () => {
    const { client, cwd } = await node();
    const sessions = watch(client, TERMINALS_STREAM);
    const latest = () =>
      (sessions.events.at(-1)?.payload as { terminals: TerminalSummary[] } | undefined)
        ?.terminals ?? [];
    // Before any terminal: the stream already says there are none.
    await sessions.until((seen) => seen.length > 0);
    expect(latest()).toEqual([]);

    const input = { threadId: "t", terminalId: "term-1", cwd };
    await client.call("terminals.open", input);
    await sessions.until(() => latest().some((item) => item.status === "running"));
    await client.call("terminals.write", { ...input, data: "sleep 30\r" });
    await sessions.until(() => latest()[0]?.hasRunningSubprocess === true);
    expect(latest()[0]?.label).toBe("sleep");

    // A late subscriber gets the latest list only.
    const late = watch(client, TERMINALS_STREAM);
    await late.until((seen) => seen.length > 0);
    expect(late.events).toHaveLength(1);
    expect(late.events[0]?.payload).toEqual(sessions.events.at(-1)?.payload);

    await client.call("terminals.write", { ...input, data: "\u0003" });
    await sessions.until(() => latest()[0]?.hasRunningSubprocess === false);
  });

  it("ends every session when the plugin deactivates", async () => {
    const { client, cwd, kernel } = await node();
    const opened = await client.call<TerminalSummary>("terminals.open", {
      threadId: "t",
      terminalId: "term-1",
      cwd,
    });
    const stream = watch(client, terminalStream("t", "term-1"));
    await stream.untilType(TerminalEvents.started);
    await kernel.reload("jhin.terminal");
    await stream.untilType(TerminalEvents.closed);
    expect(alive(opened.pid!)).toBe(false);
  });

  it("closes the terminals of a deleted thread", async () => {
    const { client, cwd, storage } = await node();
    await client.call("terminals.open", { threadId: "gone", terminalId: "term-1", cwd });
    await client.call("terminals.open", { threadId: "kept", terminalId: "term-1", cwd });
    const stream = watch(client, terminalStream("gone", "term-1"));
    await stream.untilType(TerminalEvents.started);
    await storage.storage.log.append(THREADS_STREAM, [
      { type: ThreadEvents.threadDeleted, payload: { id: "gone" } },
    ]);
    await stream.untilType(TerminalEvents.closed);
    const { terminals } = await client.call<{ terminals: TerminalSummary[] }>("terminals.list", {});
    expect(terminals.map((item) => item.threadId)).toEqual(["kept"]);
  });

  it("runs without live streams; output is then read with terminals.get", async () => {
    const { client, cwd } = await node({ streams: false });
    const opened = await client.call<TerminalSummary>("terminals.open", {
      threadId: "t",
      terminalId: "term-1",
      cwd,
    });
    expect(opened.status).toBe("running");
    const snapshot = await client.call<TerminalSnapshot>("terminals.get", {
      threadId: "t",
      terminalId: "term-1",
    });
    expect(snapshot.pid).toBe(opened.pid);
  });
});

describe("terminal sessions", () => {
  const quiet: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => quiet,
  };

  it("fails an open whose terminal was closed while node-pty loaded", async () => {
    const cwd = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-terminal-"));
    let loaded!: (pty: PtySpawner) => void;
    const loading = new Promise<PtySpawner>((resolve) => (loaded = resolve));
    let asked!: () => void;
    const loadAsked = new Promise<void>((resolve) => (asked = resolve));
    const sessions = createSessions({
      streams: createMemoryStreams(),
      pty: () => {
        asked();
        return loading;
      },
      config: () => ({ shell: "/bin/sh", scrollback: 5000 }),
      log: quiet,
    });
    const input = { threadId: "t", terminalId: "term-1", cwd };
    const opening = sessions.open(input);
    // The session is there and waits for node-pty: close it now.
    await loadAsked;
    const closing = sessions.close(input);
    loaded(await loadNodePty());

    await expect(opening).rejects.toMatchObject({ code: "TERMINAL_NOT_FOUND" });
    expect(await closing).toBe(1);
    expect(sessions.list()).toEqual([]);
    // Opened again afterwards, it starts cleanly.
    expect(await sessions.open(input)).toMatchObject({ status: "running" });
    await sessions.dispose();
    Fs.rmSync(cwd, { recursive: true, force: true });
  });

  /** A deferred: the test decides when it settles, no timer involved. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => (resolve = done));
    return { promise, resolve };
  }

  /** node-pty that only counts the shells it is asked to start. */
  function countingPty() {
    const spawned: string[] = [];
    const pty: PtySpawner = {
      spawn(options) {
        spawned.push(options.cwd);
        throw new Error("no shell in this test");
      },
    };
    return { pty, spawned };
  }

  it("starts no shell for an open still reading its folder when the plugin stops (D143)", async () => {
    const { pty, spawned } = countingPty();
    const folder = deferred<Fs.Stats>();
    let asked!: () => void;
    const statAsked = new Promise<void>((resolve) => (asked = resolve));
    const sessions = createSessions({
      streams: createMemoryStreams(),
      pty: async () => pty,
      stat: () => {
        asked();
        return folder.promise;
      },
      config: () => ({ shell: "/bin/sh", scrollback: 5000 }),
      log: quiet,
    });
    const opening = sessions.open({ threadId: "t", terminalId: "term-1", cwd: "/work" });
    await statAsked;
    await sessions.dispose();
    folder.resolve(Fs.statSync(Os.tmpdir()));

    await expect(opening).rejects.toMatchObject({ code: "TERMINAL_UNAVAILABLE" });
    expect(spawned).toEqual([]);
    expect(sessions.list()).toEqual([]);
  });

  it("starts no shell for an open waiting for node-pty when the plugin stops (D143)", async () => {
    const { pty, spawned } = countingPty();
    const loading = deferred<PtySpawner>();
    let asked!: () => void;
    const loadAsked = new Promise<void>((resolve) => (asked = resolve));
    const sessions = createSessions({
      streams: createMemoryStreams(),
      pty: () => {
        asked();
        return loading.promise;
      },
      config: () => ({ shell: "/bin/sh", scrollback: 5000 }),
      log: quiet,
    });
    const opening = sessions.open({ threadId: "t", terminalId: "term-1", cwd: Os.tmpdir() });
    await loadAsked;
    const disposing = sessions.dispose();
    loading.resolve(pty);

    await expect(opening).rejects.toMatchObject({ code: "TERMINAL_UNAVAILABLE" });
    await disposing;
    expect(spawned).toEqual([]);
    expect(sessions.list()).toEqual([]);
  });

  it("keeps its output, scrollback and close whole past a subscriber that throws", async () => {
    const cwd = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-terminal-"));
    const streams = createMemoryStreams({ log: quiet });
    const sessions = createSessions({
      streams,
      pty: loadNodePty,
      config: () => ({ shell: "/bin/sh", scrollback: 5000 }),
      log: quiet,
    });
    const input = { threadId: "t", terminalId: "term-1", cwd };
    const stream = terminalStream("t", "term-1");
    // A subscriber whose peer just closed, ahead of one that follows the output.
    streams.subscribe(stream, () => {
      throw new Error("peer closed");
    });
    let printed = "";
    let shown!: () => void;
    const answered = new Promise<void>((resolve) => (shown = resolve));
    streams.subscribe(stream, (event) => {
      if (event.type !== TerminalEvents.output) return;
      printed += (event.payload as { data: string }).data;
      if (printed.includes("whole-21")) shown();
    });

    await sessions.open(input);
    sessions.write({ ...input, data: "echo whole-$((3*7))\r" });
    await answered;
    expect(sessions.get("t", "term-1")?.history).toContain("whole-21");

    expect(await sessions.close(input)).toBe(1);
    // Closed for good: its stream is gone, not left behind by the failing listener.
    expect(streams.events(stream)).toEqual([]);
    expect(await streams.head(stream)).toBe(0);
    await sessions.dispose();
    Fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("refuses another folder for a running terminal, takes a link to the same one (D140)", async () => {
    const { client, cwd } = await node();
    const input = { threadId: "t", terminalId: "term-1", cwd };
    const opened = await client.call<TerminalSummary>("terminals.open", input);
    await expect(
      client.call("terminals.open", { ...input, cwd: Os.tmpdir() }),
    ).rejects.toMatchObject({ code: "TERMINAL_CWD_MISMATCH", details: { cwd } });
    const link = `${cwd}-link`;
    Fs.symlinkSync(cwd, link);
    try {
      expect(await client.call("terminals.open", { ...input, cwd: link })).toMatchObject({
        pid: opened.pid,
        status: "running",
      });
    } finally {
      Fs.rmSync(link);
    }
  });

  it("sends the terminals stream again when a terminal is resized", async () => {
    const { client, cwd } = await node();
    const input = { threadId: "t", terminalId: "term-1", cwd };
    await client.call("terminals.open", { ...input, cols: 80, rows: 24 });
    const sessions = watch(client, TERMINALS_STREAM);
    const latest = () =>
      (sessions.events.at(-1)?.payload as { terminals: TerminalSummary[] } | undefined)
        ?.terminals[0];
    await sessions.until(() => latest()?.cols === 80);

    await client.call("terminals.resize", { ...input, cols: 100, rows: 30 });
    await sessions.until(() => latest()?.cols === 100);
    expect(latest()).toMatchObject({ cols: 100, rows: 30 });
    // Resized by an open of the running terminal too.
    await client.call("terminals.open", { ...input, cols: 90, rows: 20 });
    await sessions.until(() => latest()?.cols === 90);
    const { terminals } = await client.call<{ terminals: TerminalSummary[] }>("terminals.list", {});
    expect(terminals[0]).toMatchObject({ cols: 90, rows: 20 });
    expect(latest()).toEqual(terminals[0]);
  });

  it("warns once when the process table cannot be read, then waits quietly", async () => {
    const cwd = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-terminal-"));
    const warnings: string[] = [];
    const debugs: string[] = [];
    let reads = 0;
    let fourthRead!: () => void;
    const fourReads = new Promise<void>((resolve) => (fourthRead = resolve));
    // A shell that never prints and exits only when killed: the process table is under test.
    const pty: PtySpawner = {
      spawn: () => {
        const exits = new Set<(exit: { exitCode: number; signal: number | null }) => void>();
        return {
          pid: 4242,
          write: () => undefined,
          resize: () => undefined,
          kill: () => {
            for (const exit of exits) exit({ exitCode: 0, signal: 1 });
          },
          onData: () => () => undefined,
          onExit: (listener) => {
            exits.add(listener);
            return () => exits.delete(listener);
          },
        };
      },
    };
    const sessions = createSessions({
      streams: createMemoryStreams(),
      pty: async () => pty,
      processTable: async () => {
        reads += 1;
        if (reads === 4) fourthRead();
        throw new Error("stdout maxBuffer length exceeded");
      },
      pollIntervalMs: 1,
      config: () => ({ shell: "/bin/sh", scrollback: 5000 }),
      log: {
        ...quiet,
        warn: (message) => warnings.push(message),
        debug: (message) => debugs.push(message),
      },
    });
    await sessions.open({ threadId: "t", terminalId: "term-1", cwd });
    // Reads are one after the other: by the fourth, the second and third failed and were logged.
    await fourReads;
    expect(warnings).toEqual([
      "process table not read; terminal labels and indicators wait for it",
    ]);
    expect(debugs).toEqual(["process table not read", "process table not read"]);
    await sessions.dispose();
    Fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("refuses another folder to an open that waited for the same terminal to start", async () => {
    const first = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-terminal-"));
    const second = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-terminal-"));
    const loading = deferred<PtySpawner>();
    let asked!: () => void;
    const loadAsked = new Promise<void>((resolve) => (asked = resolve));
    const sessions = createSessions({
      streams: createMemoryStreams(),
      pty: () => {
        asked();
        return loading.promise;
      },
      config: () => ({ shell: "/bin/sh", scrollback: 5000 }),
      log: quiet,
    });
    const ids = { threadId: "t", terminalId: "term-1" };
    const starting = sessions.open({ ...ids, cwd: first });
    // The terminal is starting in the first folder; the second open waits for it.
    await loadAsked;
    const waiting = sessions.open({ ...ids, cwd: second });
    loading.resolve(await loadNodePty());

    expect(await starting).toMatchObject({ status: "running", cwd: first });
    await expect(waiting).rejects.toMatchObject({
      code: "TERMINAL_CWD_MISMATCH",
      details: { cwd: first },
    });
    await sessions.dispose();
    for (const dir of [first, second]) Fs.rmSync(dir, { recursive: true, force: true });
  });

  it("trims past events other than output, never stopping at them", async () => {
    const cwd = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-terminal-"));
    const streams = createMemoryStreams();
    const stream = terminalStream("t", "term-1");
    let printed = "";
    const waiting: { text: string; resolve: () => void }[] = [];
    /** Every output event as it came, to tell what trimming should keep. */
    const outputs: { sequence: number; data: string }[] = [];
    streams.subscribe(stream, (event) => {
      if (event.type !== TerminalEvents.output) return;
      outputs.push({ sequence: event.sequence, data: (event.payload as { data: string }).data });
      printed += (event.payload as { data: string }).data;
      for (const waiter of waiting.filter((item) => printed.includes(item.text))) {
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.resolve();
      }
    });
    const shows = (text: string) =>
      printed.includes(text)
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiting.push({ text, resolve }));
    const sessions = createSessions({
      streams,
      pty: loadNodePty,
      config: () => ({ shell: "/bin/sh", scrollback: 100 }),
      log: quiet,
    });
    const input = { threadId: "t", terminalId: "term-1", cwd };
    await sessions.open(input);
    sessions.write({ ...input, data: "seq 1 300\r" });
    await shows("\n300");
    // An event of another kind among the output, as a later kind (a title) would be.
    streams.append(stream, "terminal.title", { title: "seq" });
    for (const [from, to] of [
      [301, 600],
      [601, 900],
    ]) {
      sessions.write({ ...input, data: `seq ${from} ${to}\r` });
      await shows(`\n${to}`);
    }
    // Short output, then a run just under the limit: trimming must forget only
    // the oldest of the short ones, not everything but the newest event.
    for (const n of [1, 2, 3]) {
      sessions.write({ ...input, data: `echo tail-$((${n}+10))\r` });
      await shows(`tail-${n + 10}`);
    }
    sessions.write({ ...input, data: "seq 1001 1095\r" });
    await shows("\n1095");

    const kept = streams.events(stream);
    expect(kept[0]?.type).toBe(TerminalEvents.started);
    expect(kept.map((event) => event.type)).toContain("terminal.title");
    // Output after the other event was trimmed too: the middle run is gone.
    expect(sessions.get("t", "term-1")?.history).not.toMatch(/\n450\r\n/);
    // And exactly what fits stays: the newest output events whose lines add up
    // to the limit (100), never fewer; the newest alone when it is longer.
    const lineCount = (data: string) => data.split("\n").length - 1;
    const keptOutput = kept.filter((event) => event.type === TerminalEvents.output);
    const fitting = [outputs.at(-1)!];
    let total = lineCount(outputs.at(-1)!.data);
    for (const output of outputs.slice(0, -1).toReversed()) {
      if (total + lineCount(output.data) > 100) break;
      total += lineCount(output.data);
      fitting.unshift(output);
    }
    expect(keptOutput.map((event) => event.sequence)).toEqual(
      fitting.map((output) => output.sequence),
    );
    expect(fitting.length).toBeGreaterThan(1);
    expect(sessions.get("t", "term-1")?.history).toContain("tail-13");
    expect(sessions.get("t", "term-1")?.history).toContain("\n1095");
    await sessions.dispose();
    Fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("trims the scrollback with at most one look at the stream per flush", async () => {
    const cwd = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-terminal-"));
    const inner = createMemoryStreams();
    const stream = terminalStream("t", "term-1");
    /** How often each flush looked at the session's stream (its trim). */
    const looksPerFlush: number[] = [];
    let printed = "";
    const waiting: { text: string; resolve: () => void }[] = [];
    const streams: typeof inner = {
      ...inner,
      events(name) {
        if (name === stream && looksPerFlush.length > 0) {
          looksPerFlush[looksPerFlush.length - 1]! += 1;
        }
        return inner.events(name);
      },
      append(name, type, payload) {
        const event = inner.append(name, type, payload);
        if (name === stream && type === TerminalEvents.output) {
          looksPerFlush.push(0);
          printed += (payload as { data: string }).data;
          for (const waiter of waiting.filter((item) => printed.includes(item.text))) {
            waiting.splice(waiting.indexOf(waiter), 1);
            waiter.resolve();
          }
        }
        return event;
      },
    };
    const shows = (text: string) =>
      printed.includes(text)
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiting.push({ text, resolve }));
    const sessions = createSessions({
      streams,
      pty: loadNodePty,
      config: () => ({ shell: "/bin/sh", scrollback: 100 }),
      log: quiet,
    });
    const input = { threadId: "t", terminalId: "term-1", cwd };
    await sessions.open(input);
    // Three runs of 300 lines: each flush past the limit forgets older events.
    for (const [from, to] of [
      [1, 300],
      [301, 600],
      [601, 900],
    ]) {
      sessions.write({ ...input, data: `seq ${from} ${to}\r` });
      await shows(`\n${to}`);
    }
    // Some flushes trimmed (the line limit is 100), none looked more than once.
    expect(looksPerFlush.some((looks) => looks === 1)).toBe(true);
    expect(Math.max(...looksPerFlush)).toBe(1);
    expect(sessions.get("t", "term-1")?.history).not.toMatch(/\n2\r\n3\r\n/);
    await sessions.dispose();
    Fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("the program a terminal runs", () => {
  const table = parseProcessTable(
    [
      "  100     1 zsh",
      "  101   100 zsh",
      "  200     1 bash",
      "  201   200 /usr/bin/vim notes.md",
      "  300     1 sh",
    ].join("\n"),
  );

  it("is a child of the shell, by its name", () => {
    expect(subprocessOf(table, 200)).toEqual({ running: true, label: "vim" });
    expect(subprocessOf(table, 300)).toEqual({ running: false, label: "" });
  });

  it("is not a copy of the shell waiting without children (async prompts)", () => {
    expect(subprocessOf(table, 100)).toEqual({ running: false, label: "" });
  });
});
