import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { LIVE_STREAMS_CAPABILITY, createLiveStreams } from "@jhin/rpc";
import { TerminalEvents, terminalStream } from "@jhin/terminal-api";
import { connectInMemory, createTestKernel, mockCapability } from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import terminal from "../../../plugins/terminal/src/index.ts";
import { attachTerminal, type TerminalSink } from "../src/plugins/terminal/attach.ts";

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
  return { ...connection, cwd };
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
