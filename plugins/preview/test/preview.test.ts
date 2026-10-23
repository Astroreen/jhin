import * as Fs from "node:fs";
import * as Http from "node:http";
import type { AddressInfo } from "node:net";
import * as Os from "node:os";
import * as Path from "node:path";

import { THREADS_STREAM, ThreadEvents } from "@jhin/agent-api";
import {
  PreviewEvents,
  previewFramesStream,
  previewTabsStream,
  type PreviewSnapshot,
  type PreviewStatus,
  type PreviewTab,
} from "@jhin/preview-api";
import {
  LIVE_STREAMS_CAPABILITY,
  createLiveStreams,
  createMemoryStreams,
  type RpcClient,
} from "@jhin/rpc";
import type { Logger } from "@jhin/sdk";
import type { StoredEvent } from "@jhin/storage-api";
import {
  connectInMemory,
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
} from "@jhin/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { Chromium } from "../src/chromium.ts";
import preview from "../src/index.ts";
import { createTabs } from "../src/tabs.ts";

const manifest = JSON.parse(
  Fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).jhin;

// --- Pages the browser opens --------------------------------------------------

const PAGES: Record<string, string> = {
  "/": `<!doctype html><title>Home</title>
    <h1>Preview home</h1>
    <button onclick="document.title = 'Clicked'">Press me</button>
    <label>Name <input id="name"></label>
    <label>Password <input type="password" id="secret" value="hunter2-secret"></label>
    <select aria-label="Size"><option value="s">Small</option><option value="l">Large</option></select>
    <button onclick="alert('Hello from the page')">Alert</button>
    <a href="/second">Second page</a>
    <script>setTimeout(() => console.log("page ready"), 0)</script>`,
  "/second": `<!doctype html><title>Second</title><p>Second page text</p>`,
  "/download": `<!doctype html><title>Download</title><a href="/report.txt" download>Get report</a>`,
  "/popup": `<!doctype html><title>Opener</title><a href="/second" target="_blank">Open popup</a>`,
  "/upload": `<!doctype html><title>Upload</title><input type="file" aria-label="File" id="file">`,
  "/pick": `<!doctype html><title>Pick</title>
    <style>body{margin:0} input{display:block;box-sizing:border-box;width:400px;height:100px}</style>
    <input type="file" id="file" multiple onchange="out.textContent = 'got ' + [...this.files].map((f) => f.name + ':' + f.size).join(',')">
    <input aria-label="Text" id="text">
    <p id="out"></p>`,
  "/pick-one": `<!doctype html><title>Pick one</title>
    <style>body{margin:0} input{display:block;box-sizing:border-box;width:400px;height:100px}</style>
    <input type="file" id="file">
    <button id="drop" style="display:block;width:400px;height:50px" onclick="file.remove()">Drop</button>`,
  "/drag": `<!doctype html><title>Drag</title>
    <div draggable="true" id="source" style="width:80px;height:40px">Drag me</div>
    <div id="target" style="width:160px;height:80px;margin-top:40px">Drop here</div>
    <script>
      target.addEventListener("dragover", (event) => event.preventDefault());
      target.addEventListener("drop", (event) => { event.preventDefault(); document.title = "Dropped"; });
    </script>`,
};

/** Requests to /hold wait until the test lets them go. */
let holding: (() => void)[] = [];
let held: () => void = () => {};
let heldArrived = new Promise<void>((resolve) => (held = resolve));

let server: Http.Server;
let origin = "";
beforeAll(async () => {
  server = Http.createServer((request, response) => {
    if (request.url === "/report.txt") {
      response
        .writeHead(200, {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="report.txt"',
        })
        .end("the report");
      return;
    }
    if (request.url === "/hold") {
      holding.push(() => response.writeHead(200).end("released"));
      held();
      return;
    }
    const page = PAGES[request.url ?? "/"];
    if (page === undefined) {
      response.writeHead(404).end("missing");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// --- A node with the plugin ------------------------------------------------------

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function startNode(options: { executablePath?: string } = {}) {
  const storage = memoryStoragePlugin();
  const live = createLiveStreams();
  const kernel = await createTestKernel({
    plugins: [
      storage,
      mockCapability(LIVE_STREAMS_CAPABILITY, live),
      { manifest, definition: preview },
    ],
    config: {
      node: {
        "jhin.preview":
          options.executablePath === undefined ? {} : { executablePath: options.executablePath },
      },
    },
  });
  const { client } = connectInMemory(kernel, { log: storage.storage.log, streams: live });
  const other = (id: string, permissions: string[] = ["*"]) =>
    connectInMemory(kernel, {
      log: storage.storage.log,
      streams: live,
      caller: { id, permissions },
    }).client;
  const stop = async () => {
    client.close();
    await kernel.stop();
  };
  return { kernel, client, storage, live, other, stop };
}

// One node for the file: its browser starts once and stays up while a tab of another
// thread keeps it open, and each test works in a thread of its own.
let shared: Awaited<ReturnType<typeof startNode>>;
beforeAll(async () => {
  shared = await startNode();
  await shared.client.call("preview.open", { threadId: "keeper", open: false });
});
afterAll(async () => {
  await shared.stop();
});

let threads = 0;
let thread = "";
beforeEach(() => {
  threads += 1;
  thread = `thread-${threads}`;
});

async function node(options: { executablePath?: string } = {}) {
  if (options.executablePath === undefined) return shared;
  const started = await startNode(options);
  stops.push(started.stop);
  return started;
}

/** Follows a stream; resolves waits on events seen or still to come. */
function watch(client: RpcClient, stream: string) {
  const events: StoredEvent[] = [];
  const waiters: { test: () => boolean; resolve: () => void }[] = [];
  const subscription = client.subscribe(stream, { after: 0 }, (event) => {
    events.push(event);
    for (const waiter of waiters.filter((item) => item.test())) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  });
  const until = (test: () => boolean) =>
    test() ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ test, resolve }));
  return { events, subscription, until };
}

const lastTabs = (events: StoredEvent[]) =>
  (
    events.findLast((event) => event.type === PreviewEvents.tabs)?.payload as
      | { tabs: PreviewTab[] }
      | undefined
  )?.tabs ?? [];

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details: Record<string, unknown> };
  }
  throw new Error("expected the call to fail");
}

describe("jhin.preview", () => {
  it("opens a tab, reads its accessibility tree and acts on refs", async () => {
    const { client } = await node();
    const opened = await client.call<PreviewStatus>("preview.open", {
      threadId: thread,
      url: `${origin}/`,
    });
    expect(opened.tabId).toMatch(/^tab_[0-9a-z]+_[0-9a-f]{8}$/);
    expect(opened.control).toMatchObject({ owner: "agent", ownedByCaller: true });
    await client.call("preview.wait.for", { threadId: thread, text: "Preview home" });

    const snapshot = await client.call<PreviewSnapshot>("preview.snapshot", { threadId: thread });
    expect(snapshot.title).toBe("Home");
    expect(snapshot.screenshot).toBeUndefined();
    expect(snapshot.screenshotSize?.width).toBeGreaterThan(0);
    expect(snapshot.consoleEntries?.map((entry) => entry.text)).toContain("page ready");
    // Password values never reach the agent.
    expect(snapshot.accessibilityTree).not.toContain("hunter2-secret");
    expect(snapshot.visibleText).not.toContain("hunter2-secret");
    const ref = /button "Press me" \[ref=(t3-[^\]]+)\]/.exec(snapshot.accessibilityTree!)?.[1];
    expect(ref).toBeDefined();

    await client.call("preview.click", { threadId: thread, locator: `aria-ref=${ref}` });
    const status = await client.call<PreviewStatus>("preview.status", { threadId: thread });
    expect(status.title).toBe("Clicked");
    expect(status.tabs).toHaveLength(1);

    await client.call("preview.type", {
      threadId: thread,
      locator: "role=textbox[name='Name']",
      text: "Jhin",
    });
    await client.call("preview.select", {
      threadId: thread,
      locator: "role=combobox[name='Size']",
      values: ["Large"],
    });
    const { value } = await client.call<{ value: unknown }>("preview.evaluate", {
      threadId: thread,
      expression: "[document.querySelector('#name').value, document.querySelector('select').value]",
    });
    expect(value).toEqual(["Jhin", "l"]);
  });

  it("revokes refs on navigation and reports a stale one", async () => {
    const { client } = await node();
    await client.call("preview.open", { threadId: thread, url: `${origin}/` });
    await client.call("preview.wait.for", { threadId: thread, text: "Preview home" });
    const snapshot = await client.call<PreviewSnapshot>("preview.snapshot", { threadId: thread });
    const ref = /link "Second page" \[ref=(t3-[^\]]+)\]/.exec(snapshot.accessibilityTree!)?.[1];
    await client.call("preview.navigate", { threadId: thread, url: `${origin}/second` });

    const stale = await rejection(
      client.call("preview.click", { threadId: thread, locator: `aria-ref=${ref}` }),
    );
    expect(stale.code).toBe("PREVIEW_INVALID_SELECTOR");
    expect(stale.details).toMatchObject({ staleRef: true });
  });

  it("returns from a click that opens a dialog and holds other actions until it is answered", async () => {
    const { client } = await node();
    await client.call("preview.open", { threadId: thread, url: `${origin}/` });
    await client.call("preview.wait.for", { threadId: thread, text: "Preview home" });
    await client.call("preview.click", { threadId: thread, locator: "role=button[name='Alert']" });

    const status = await client.call<PreviewStatus>("preview.status", { threadId: thread });
    expect(status.dialog).toMatchObject({ type: "alert", message: "Hello from the page" });
    const blocked = await rejection(client.call("preview.press", { threadId: thread, key: "Tab" }));
    expect(blocked.code).toBe("PREVIEW_CONTROL");
    expect(blocked.details).toMatchObject({ reason: "dialogPending" });

    const answered = await client.call<PreviewStatus>("preview.dialog", {
      threadId: thread,
      accept: true,
    });
    expect(answered.dialog).toBeNull();
    await client.call("preview.press", { threadId: thread, key: "Tab" });
  });

  it("lets another session read a tab but not act on it", async () => {
    const { client } = await node();
    const opened = await client.call<PreviewStatus>("preview.open", {
      threadId: thread,
      url: `${origin}/`,
    });
    const other = { threadId: thread, tabId: opened.tabId!, session: "subagent" };
    const read = await client.call<PreviewStatus>("preview.status", other);
    expect(read.control).toMatchObject({ owner: "agent", ownedByCaller: false });
    const refused = await rejection(client.call("preview.press", { ...other, key: "Tab" }));
    expect(refused.details).toMatchObject({ reason: "agentMismatch" });
  });

  it("streams frames to a viewer, hands control to it and back", async () => {
    const { client } = await node();
    const opened = await client.call<PreviewStatus>("preview.open", {
      threadId: thread,
      url: `${origin}/`,
    });
    const tabId = opened.tabId!;
    await client.call("preview.wait.for", { threadId: thread, text: "Preview home" });
    const tabsStream = watch(client, previewTabsStream(thread));
    await tabsStream.until(() => lastTabs(tabsStream.events).length === 1);

    // Watching the frames makes the tab visible and starts its screencast.
    const frames = watch(client, previewFramesStream(thread, tabId));
    await frames.until(() => frames.events.some((event) => event.type === PreviewEvents.frame));
    const frame = frames.events.find((event) => event.type === PreviewEvents.frame)!.payload as {
      data: string;
      width: number;
      height: number;
    };
    expect(Buffer.from(frame.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(frame).toMatchObject({ width: 1280, height: 800 });
    await tabsStream.until(() => lastTabs(tabsStream.events)[0]?.visible === true);

    // A human takes control from the agent: the agent may still read, not act.
    await client.call("preview.tab.control", { threadId: thread, tabId, viewer: "v1", take: true });
    const refused = await rejection(client.call("preview.press", { threadId: thread, key: "a" }));
    expect(refused.details).toMatchObject({ reason: "humanControl" });
    await client.call("preview.snapshot", { threadId: thread });

    // The human's typing reaches the page.
    await client.call("preview.tab.input", {
      threadId: thread,
      tabId,
      viewer: "v1",
      events: [
        { type: "mouse", action: "down", x: 0, y: 0, button: "left", buttons: 1 },
        { type: "mouse", action: "up", x: 0, y: 0, button: "left" },
      ],
    });
    // A viewer without control is refused.
    const intruder = await rejection(
      client.call("preview.tab.input", {
        threadId: thread,
        tabId,
        viewer: "v2",
        events: [{ type: "text", text: "nope" }],
      }),
    );
    expect(intruder.code).toBe("PREVIEW_CONTROL");

    // The last viewer leaving releases control.
    frames.subscription.dispose();
    await tabsStream.until(() => {
      const tab = lastTabs(tabsStream.events)[0];
      return tab?.visible === false && tab.controller === null;
    });
    await client.call("preview.press", { threadId: thread, key: "Tab" });
  });

  it("answers the page's file picker with a human's files, and probes what a tap edits (D1203)", async () => {
    const { client } = await node();
    const opened = await client.call<PreviewStatus>("preview.open", {
      threadId: thread,
      url: `${origin}/pick`,
    });
    const tabId = opened.tabId!;
    await client.call("preview.wait.for", { threadId: thread, selector: "#text" });
    const tabsStream = watch(client, previewTabsStream(thread));
    await client.call("preview.tab.control", { threadId: thread, tabId, viewer: "v1", take: true });

    // The file input is not editable text; the text input is.
    const probe = (x: number, y: number) =>
      client.call<{ editable: boolean }>("preview.tab.probe", {
        threadId: thread,
        tabId,
        viewer: "v1",
        x,
        y,
      });
    expect(await probe(50, 50)).toMatchObject({ editable: false });
    expect(await probe(50, 110)).toMatchObject({ editable: true });
    const notYours = await rejection(
      client.call("preview.tab.probe", { threadId: thread, tabId, viewer: "v2", x: 1, y: 1 }),
    );
    expect(notYours.code).toBe("PREVIEW_CONTROL");

    // Nothing to answer before the page asks.
    const early = await rejection(
      client.call("preview.tab.upload", { threadId: thread, tabId, viewer: "v1", files: [] }),
    );
    expect(early.message).toBe("The page's file picker is no longer open.");

    // The human clicks the file input: the tab reports its picker.
    const click = () =>
      client.call("preview.tab.input", {
        threadId: thread,
        tabId,
        viewer: "v1",
        events: [
          {
            type: "mouse",
            action: "down",
            x: 50,
            y: 50,
            button: "left",
            buttons: 1,
            clickCount: 1,
          },
          { type: "mouse", action: "up", x: 50, y: 50, button: "left", clickCount: 1 },
        ],
      });
    await click();
    await tabsStream.until(() => lastTabs(tabsStream.events)[0]?.fileChooser?.multiple === true);

    // Their files reach the page, and the picker is answered.
    await client.call("preview.tab.upload", {
      threadId: thread,
      tabId,
      viewer: "v1",
      files: [
        { name: "a.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") },
        { name: "b.bin", data: Buffer.from([1, 2, 3]).toString("base64") },
      ],
    });
    await client.call("preview.wait.for", { threadId: thread, text: "got a.txt:5,b.bin:3" });
    await tabsStream.until(() => lastTabs(tabsStream.events)[0]?.fileChooser === null);

    // Only the viewer holding control answers it.
    await click();
    await tabsStream.until(() => lastTabs(tabsStream.events)[0]?.fileChooser !== null);
    const stranger = await rejection(
      client.call("preview.tab.upload", { threadId: thread, tabId, viewer: "v2", files: [] }),
    );
    expect(stranger.code).toBe("PREVIEW_CONTROL");
    await client.call("preview.tab.upload", { threadId: thread, tabId, viewer: "v1", files: [] });
    await tabsStream.until(() => lastTabs(tabsStream.events)[0]?.fileChooser === null);

    // Cancelling with no files closes the next picker.
    await click();
    await tabsStream.until(() => lastTabs(tabsStream.events)[0]?.fileChooser !== null);
    await client.call("preview.tab.upload", { threadId: thread, tabId, viewer: "v1", files: [] });
    await tabsStream.until(() => lastTabs(tabsStream.events)[0]?.fileChooser === null);
    tabsStream.subscription.dispose();
    // The shared node keeps an agent session's tabs to 8.
    await client.call("preview.tab.close", { threadId: thread, tabId });
  });

  it("refuses two files for a picker of one, and keeps the picker open (D1203)", async () => {
    const { client } = await node();
    const opened = await client.call<PreviewStatus>("preview.open", {
      threadId: thread,
      url: `${origin}/pick-one`,
    });
    const tabId = opened.tabId!;
    await client.call("preview.wait.for", { threadId: thread, selector: "#file" });
    const tabsStream = watch(client, previewTabsStream(thread));
    await client.call("preview.tab.control", { threadId: thread, tabId, viewer: "v1", take: true });
    await client.call("preview.tab.input", {
      threadId: thread,
      tabId,
      viewer: "v1",
      events: [
        { type: "mouse", action: "down", x: 50, y: 50, button: "left", buttons: 1, clickCount: 1 },
        { type: "mouse", action: "up", x: 50, y: 50, button: "left", clickCount: 1 },
      ],
    });
    await tabsStream.until(() => lastTabs(tabsStream.events)[0]?.fileChooser?.multiple === false);
    const file = { name: "a.txt", data: Buffer.from("a").toString("base64") };
    const two = await rejection(
      client.call("preview.tab.upload", {
        threadId: thread,
        tabId,
        viewer: "v1",
        files: [file, file],
      }),
    );
    expect(two.message).toBe("This file picker accepts one file.");
    expect(lastTabs(tabsStream.events)[0]?.fileChooser).not.toBeNull();
    await client.call("preview.tab.upload", {
      threadId: thread,
      tabId,
      viewer: "v1",
      files: [file],
    });
    await tabsStream.until(() => lastTabs(tabsStream.events)[0]?.fileChooser === null);
    tabsStream.subscription.dispose();
    await client.call("preview.tab.close", { threadId: thread, tabId });
  });

  it("answers a probe while the page shows a dialog without running script in it (D1203)", async () => {
    const { client } = await node();
    const opened = await client.call<PreviewStatus>("preview.open", {
      threadId: thread,
      url: `${origin}/`,
    });
    const tabId = opened.tabId!;
    await client.call("preview.wait.for", { threadId: thread, text: "Preview home" });
    await client.call("preview.click", { threadId: thread, locator: "role=button[name='Alert']" });
    const tabsStream = watch(client, previewTabsStream(thread));
    await tabsStream.until(() => lastTabs(tabsStream.events)[0]?.dialog != null);
    await client.call("preview.tab.control", { threadId: thread, tabId, viewer: "v1", take: true });
    expect(
      await client.call("preview.tab.probe", { threadId: thread, tabId, viewer: "v1", x: 5, y: 5 }),
    ).toEqual({ x: 5, y: 5, editable: false });
    tabsStream.subscription.dispose();
    await client.call("preview.tab.close", { threadId: thread, tabId });
  });

  it("closes a picker its page dropped, and refuses file data that is not base64 (D1203)", async () => {
    const { client } = await node();
    const opened = await client.call<PreviewStatus>("preview.open", {
      threadId: thread,
      url: `${origin}/pick-one`,
    });
    const tabId = opened.tabId!;
    await client.call("preview.wait.for", { threadId: thread, selector: "#file" });
    const tabsStream = watch(client, previewTabsStream(thread));
    await client.call("preview.tab.control", { threadId: thread, tabId, viewer: "v1", take: true });
    const pick = async () => {
      await client.call("preview.tab.input", {
        threadId: thread,
        tabId,
        viewer: "v1",
        events: [
          {
            type: "mouse",
            action: "down",
            x: 50,
            y: 50,
            button: "left",
            buttons: 1,
            clickCount: 1,
          },
          { type: "mouse", action: "up", x: 50, y: 50, button: "left", clickCount: 1 },
        ],
      });
      await tabsStream.until(() => lastTabs(tabsStream.events)[0]?.fileChooser != null);
    };
    const file = { name: "a.txt", data: Buffer.from("a").toString("base64") };

    await pick();
    const garbled = await rejection(
      client.call("preview.tab.upload", {
        threadId: thread,
        tabId,
        viewer: "v1",
        files: [{ name: "a.txt", data: "not base64!" }],
      }),
    );
    expect(garbled.message).toBe("Invalid input for preview.tab.upload");
    expect(JSON.stringify(garbled.details)).toContain("File data must be base64.");
    expect(lastTabs(tabsStream.events)[0]?.fileChooser).not.toBeNull();

    // The input leaves the page: answering its picker still closes it (Playwright takes the
    // files for the detached input), so nothing is left waiting.
    await client.call("preview.tab.input", {
      threadId: thread,
      tabId,
      viewer: "v1",
      events: [
        { type: "mouse", action: "down", x: 50, y: 125, button: "left", buttons: 1, clickCount: 1 },
        { type: "mouse", action: "up", x: 50, y: 125, button: "left", clickCount: 1 },
      ],
    });
    await client.call("preview.tab.upload", {
      threadId: thread,
      tabId,
      viewer: "v1",
      files: [file],
    });
    await tabsStream.until(() => lastTabs(tabsStream.events)[0]?.fileChooser === null);

    // A new document has no picker the old one opened.
    await client.call("preview.tab.navigate", {
      threadId: thread,
      tabId,
      viewer: "v1",
      reload: {},
    });
    await client.call("preview.wait.for", { threadId: thread, selector: "#file" });
    await pick();
    await client.call("preview.tab.navigate", {
      threadId: thread,
      tabId,
      viewer: "v1",
      reload: {},
    });
    await tabsStream.until(() => lastTabs(tabsStream.events)[0]?.fileChooser === null);
    tabsStream.subscription.dispose();
    await client.call("preview.tab.close", { threadId: thread, tabId });
  });

  it("fills the viewer's size and resizes to a device preset", async () => {
    const { client } = await node();
    const opened = await client.call<PreviewStatus>("preview.open", {
      threadId: thread,
      url: `${origin}/second`,
    });
    const tabId = opened.tabId!;
    await client.call("preview.tab.input", {
      threadId: thread,
      tabId,
      viewer: "v1",
      events: [{ type: "resize", width: 700, height: 500 }],
    });
    let status = await client.call<PreviewStatus>("preview.status", { threadId: thread });
    expect(status.viewport).toEqual({ width: 700, height: 500 });

    const resized = await client.call<{ viewport: { width: number; height: number } }>(
      "preview.resize",
      { threadId: thread, mode: "preset", preset: "iphone-12-pro", orientation: "landscape" },
    );
    expect(resized.viewport).toEqual({ width: 844, height: 390 });
    const { value } = await client.call<{ value: unknown }>("preview.evaluate", {
      threadId: thread,
      expression: "[innerWidth, innerHeight]",
    });
    expect(value).toEqual([844, 390]);

    await client.call("preview.set.appearance", { threadId: thread, colorScheme: "dark" });
    const dark = await client.call<{ value: unknown }>("preview.evaluate", {
      threadId: thread,
      expression: "matchMedia('(prefers-color-scheme: dark)').matches",
    });
    expect(dark.value).toBe(true);
    status = await client.call<PreviewStatus>("preview.status", { threadId: thread });
    expect(status.viewportSetting).toMatchObject({ mode: "preset", presetId: "iphone-12-pro" });
  });

  it("reports a page that cannot be reached", async () => {
    const { client } = await node();
    const closed = Http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));

    await client.call("preview.open", { threadId: thread });
    const failure = await rejection(
      client.call("preview.navigate", {
        threadId: thread,
        target: { kind: "environment-port", port, path: "app" },
      }),
    );
    expect(failure.message).toBe(
      `Navigation to http://localhost:${port}/app failed: ERR_CONNECTION_REFUSED`,
    );
    const tabs = await client.call<{ tabs: PreviewTab[] }>("preview.list", { threadId: thread });
    expect(tabs.tabs[0]?.navStatus).toMatchObject({
      state: "failed",
      description: "ERR_CONNECTION_REFUSED",
    });
  });

  it("records a tab to a video file", async () => {
    const { client } = await node();
    await client.call("preview.open", { threadId: thread, url: `${origin}/` });
    await client.call("preview.wait.for", { threadId: thread, text: "Preview home" });
    const started = await client.call<{ recording: boolean }>("preview.recording.start", {
      threadId: thread,
    });
    expect(started.recording).toBe(true);
    await client.call("preview.click", {
      threadId: thread,
      locator: "role=button[name='Press me']",
    });
    const artifact = await client.call<{ path: string; mimeType: string; sizeBytes: number }>(
      "preview.recording.stop",
      { threadId: thread },
    );
    expect(artifact.mimeType).toMatch(/^video\/(mp4|webm)$/);
    expect(Fs.statSync(artifact.path).size).toBe(artifact.sizeBytes);
    Fs.rmSync(artifact.path);
  });

  it("saves a screenshot and lets the panel open and close tabs", async () => {
    const { client } = await node();
    const tab = await client.call<PreviewTab>("preview.tab.open", {
      threadId: thread,
      url: `${origin}/second`,
    });
    expect(tab.owner).toBe("unclaimed");
    await client.call("preview.wait.for", { threadId: thread, text: "Second page text" });
    // An agent may act on an unclaimed tab nobody controls.
    const saved = await client.call<PreviewSnapshot>("preview.snapshot", {
      threadId: thread,
      save: true,
    });
    expect(Object.keys(saved).toSorted()).toEqual(["screenshotPath", "url"]);
    expect(Fs.readFileSync(saved.screenshotPath!).subarray(1, 4).toString()).toBe("PNG");
    Fs.rmSync(saved.screenshotPath!);

    expect(await client.call("preview.tab.close", { threadId: thread, tabId: tab.tabId })).toEqual({
      closed: 1,
    });
    const missing = await rejection(client.call("preview.press", { threadId: thread, key: "a" }));
    expect(missing.code).toBe("PREVIEW_TAB_NOT_FOUND");
  });

  it("opens a human's tab in a profile, and clearing it closes the profile's tabs (D952)", async () => {
    const { client } = await node();
    const tabsStream = watch(client, previewTabsStream(thread));
    const plain = await client.call<PreviewTab>("preview.tab.open", { threadId: thread });
    expect(plain.profileId).toBe("default");
    const work = await client.call<PreviewTab>("preview.tab.open", {
      threadId: thread,
      profileId: "work",
    });
    expect(work.profileId).toBe("work");
    // An agent's tab has storage of its own, no profile.
    await client.call("preview.open", { threadId: thread, url: `${origin}/second` });
    await tabsStream.until(() => lastTabs(tabsStream.events).length === 3);
    expect(lastTabs(tabsStream.events).filter((tab) => tab.profileId === undefined)).toHaveLength(
      1,
    );

    await client.call("preview.profile.clear", { profileId: "work" });
    await tabsStream.until(() => lastTabs(tabsStream.events).length === 2);
    expect(lastTabs(tabsStream.events).map((tab) => tab.tabId)).not.toContain(work.tabId);
  });

  it("closes a deleted thread's tabs", async () => {
    const { client, storage } = await node();
    await client.call("preview.open", { threadId: thread, url: `${origin}/second` });
    const tabsStream = watch(client, previewTabsStream(thread));
    await tabsStream.until(() => lastTabs(tabsStream.events).length === 1);
    await storage.storage.log.append(THREADS_STREAM, [
      { type: ThreadEvents.threadDeleted, payload: { id: thread } },
    ]);
    await tabsStream.until(() => lastTabs(tabsStream.events).length === 0);
  });

  it("says how to get a browser when the node has none", async () => {
    const missing = Path.join(Os.tmpdir(), "jhin-no-such-chromium");
    const { client } = await node({ executablePath: missing });
    const failure = await rejection(client.call("preview.open", { threadId: thread }));
    expect(failure.code).toBe("PREVIEW_UNAVAILABLE");
    expect(failure.message).toContain("npx playwright install chromium");
  });
  it("asks for a tabId when a session owns several tabs and none is current", async () => {
    const { client } = await node();
    const tabs: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const opened = await client.call<PreviewStatus>("preview.open", {
        threadId: thread,
        reuseExistingTab: false,
        open: false,
      });
      tabs.push(opened.tabId!);
    }
    // Closing the current tab leaves two owned tabs and no current one.
    await client.call("preview.close", { threadId: thread, tabId: tabs[2] });
    const ambiguous = await rejection(client.call("preview.press", { threadId: thread, key: "a" }));
    expect(ambiguous.details).toMatchObject({ reason: "tabRequired" });
    await client.call("preview.press", { threadId: thread, tabId: tabs[0], key: "a" });
  });

  it("keeps an agent session to 8 tabs", async () => {
    const { client } = await node();
    const open = () =>
      client.call<PreviewStatus>("preview.open", {
        threadId: thread,
        reuseExistingTab: false,
        open: false,
      });
    for (let index = 0; index < 8; index += 1) await open();
    const refused = await rejection(open());
    expect(refused.details).toMatchObject({ reason: "tabLimit" });
    expect(refused.message).toContain("8 per agent session, 32 per server");
    // Another session of the thread has its own 8.
    await client.call("preview.open", { threadId: thread, session: "subagent", open: false });
  });

  it("tells two callers apart in one thread", async () => {
    const { client, other } = await node();
    const opened = await client.call<PreviewStatus>("preview.open", {
      threadId: thread,
      url: `${origin}/second`,
    });
    const stranger = other("another-agent");
    const refused = await rejection(
      stranger.call("preview.press", { threadId: thread, tabId: opened.tabId, key: "a" }),
    );
    expect(refused.details).toMatchObject({ reason: "agentMismatch" });
    stranger.close();
  });

  it("adopts a popup as a tab of the thread with its opener", async () => {
    const { client } = await node();
    const opened = await client.call<PreviewStatus>("preview.open", {
      threadId: thread,
      url: `${origin}/popup`,
    });
    const tabsStream = watch(client, previewTabsStream(thread));
    await client.call("preview.click", {
      threadId: thread,
      locator: "role=link[name='Open popup']",
    });
    await tabsStream.until(() => lastTabs(tabsStream.events).length === 2);
    const popup = lastTabs(tabsStream.events).find((tab) => tab.tabId !== opened.tabId)!;
    expect(popup).toMatchObject({ openerTabId: opened.tabId, owner: "agent" });
    tabsStream.subscription.dispose();
  });

  it("fails an agent's queued action when a human takes over", async () => {
    const { client } = await node();
    const opened = await client.call<PreviewStatus>("preview.open", {
      threadId: thread,
      url: `${origin}/second`,
    });
    const tabId = opened.tabId!;
    held = () => {};
    heldArrived = new Promise<void>((resolve) => (held = resolve));
    // The first action holds the queue until the page's request is answered.
    const holder = client.call("preview.evaluate", {
      threadId: thread,
      expression: "fetch('/hold').then((response) => response.text())",
    });
    await heldArrived;
    const queued = rejection(client.call("preview.press", { threadId: thread, key: "a" }));
    const taken = client.call("preview.tab.control", {
      threadId: thread,
      tabId,
      viewer: "v1",
      take: true,
    });
    for (const release of holding.splice(0)) release();
    expect(await holder).toEqual({ value: "released" });
    expect((await queued).details).toMatchObject({ reason: "interrupted" });
    await taken;
  });

  it("uploads a file to a file input and drags one element onto another", async () => {
    const { client } = await node();
    const file = Path.join(Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-upload-")), "notes.txt");
    Fs.writeFileSync(file, "hello");
    await client.call("preview.open", { threadId: thread, url: `${origin}/upload` });
    await client.call("preview.upload", { threadId: thread, locator: "#file", paths: [file] });
    const { value } = await client.call<{ value: unknown }>("preview.evaluate", {
      threadId: thread,
      expression: "document.querySelector('#file').files[0].name",
    });
    expect(value).toBe("notes.txt");
    const relative = await rejection(
      client.call("preview.upload", { threadId: thread, locator: "#file", paths: ["notes.txt"] }),
    );
    expect(relative.message).toBe("Upload paths must be absolute: notes.txt");

    await client.call("preview.navigate", { threadId: thread, url: `${origin}/drag` });
    await client.call("preview.drag", { threadId: thread, source: "#source", target: "#target" });
    const status = await client.call<PreviewStatus>("preview.status", { threadId: thread });
    expect(status.title).toBe("Dropped");
  });

  it("refuses an evaluation result over 64 000 bytes", async () => {
    const { client } = await node();
    await client.call("preview.open", { threadId: thread, url: `${origin}/second` });
    const large = await rejection(
      client.call("preview.evaluate", { threadId: thread, expression: "'x'.repeat(70000)" }),
    );
    expect(large.code).toBe("PREVIEW_RESULT_TOO_LARGE");
    expect(large.details).toMatchObject({ maximumBytes: 64_000 });
  });

  it("sweeps an agent's tabs nobody watched or used for 30 minutes", async () => {
    let time = Date.parse("2026-10-21T10:00:00Z");
    const streams = createMemoryStreams();
    const log = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;
    const tabs = createTabs({
      chromium: new Chromium(),
      streams,
      dataDir: Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-preview-")),
      log,
      now: () => new Date(time),
    });
    try {
      const idle = await tabs.open("agent", { threadId: "t", open: false });
      const watched = await tabs.open("agent", { threadId: "t", reuseExistingTab: false });
      tabs.watch("t", watched.tabId!, 1);
      time += 29 * 60_000;
      await tabs.sweep();
      expect(tabs.list("t")).toHaveLength(2);
      time += 2 * 60_000;
      await tabs.sweep();
      expect(tabs.list("t").map((tab) => tab.tabId)).toEqual([watched.tabId]);
      expect(idle.tabId).not.toBe(watched.tabId);
    } finally {
      await tabs.dispose();
    }
  });
  it("keeps the panel's commands from an agent's token", async () => {
    const { client, other } = await node();
    const opened = await client.call<PreviewStatus>("preview.open", {
      threadId: thread,
      url: `${origin}/second`,
    });
    const agent = other("agent-token", ["preview.read", "preview.write"]);
    const refused = await rejection(
      agent.call("preview.tab.control", {
        threadId: thread,
        tabId: opened.tabId,
        viewer: "v1",
        take: true,
      }),
    );
    expect(refused.code).toBe("PERMISSION_DENIED");
    agent.close();
  });

  it("keeps the machine's browsers from a token without preview.import (D1204)", async () => {
    const { client, other } = await node();
    const panel = other("panel-token", ["preview.read", "preview.write", "preview.control"]);
    for (const [name, input] of [
      ["preview.import.sources", {}],
      [
        "preview.import.cookies",
        { sourceId: "firefox", sourceProfileDirectory: "x", targetProfileId: "default" },
      ],
    ] as const) {
      expect((await rejection(panel.call(name, input))).code).toBe("PERMISSION_DENIED");
    }
    panel.close();
    // Incognito keeps nothing: it is refused before any browser of the machine is read.
    const incognito = await rejection(
      client.call("preview.import.cookies", {
        sourceId: "firefox",
        sourceProfileDirectory: "x",
        targetProfileId: "incognito",
      }),
    );
    expect(incognito).toMatchObject({
      code: "PREVIEW_IMPORT_FAILED",
      details: { reason: "sessionUnavailable" },
    });
  });

  it("lets only a session that may act stop a tab's recording", async () => {
    const { client } = await node();
    const opened = await client.call<PreviewStatus>("preview.open", {
      threadId: thread,
      url: `${origin}/second`,
    });
    await client.call("preview.recording.start", { threadId: thread });
    const refused = await rejection(
      client.call("preview.recording.stop", {
        threadId: thread,
        tabId: opened.tabId,
        session: "subagent",
      }),
    );
    expect(refused.details).toMatchObject({ reason: "agentMismatch" });
    const artifact = await client.call<{ path: string }>("preview.recording.stop", {
      threadId: thread,
    });
    Fs.rmSync(artifact.path);
  });
  it("retitles a tab when its page changes the title without navigating", async () => {
    const { client } = await node();
    await client.call("preview.open", { threadId: thread, url: `${origin}/` });
    await client.call("preview.wait.for", { threadId: thread, text: "Preview home" });
    const tabsStream = watch(client, previewTabsStream(thread));
    await client.call("preview.click", {
      threadId: thread,
      locator: "role=button[name='Press me']",
    });
    await tabsStream.until(() => {
      const status = lastTabs(tabsStream.events)[0]?.navStatus;
      return status?.state === "success" && status.title === "Clicked";
    });
    tabsStream.subscription.dispose();
  });

  it("offers a page's download to its watchers and gives the file to the client (D1331)", async () => {
    const { client } = await node();
    const opened = await client.call<PreviewStatus>("preview.open", {
      threadId: thread,
      url: `${origin}/download`,
    });
    await client.call("preview.wait.for", { threadId: thread, text: "Get report" });
    const tabId = opened.tabId!;
    const frames = watch(client, previewFramesStream(thread, tabId));
    await client.call("preview.click", {
      threadId: thread,
      locator: "role=link[name='Get report']",
    });
    await frames.until(() => frames.events.some((event) => event.type === PreviewEvents.download));
    const offered = frames.events.find((event) => event.type === PreviewEvents.download)!
      .payload as { id: string; fileName: string; sizeBytes: number };
    expect(offered).toMatchObject({ fileName: "report.txt", sizeBytes: 10 });
    frames.subscription.dispose();

    const saved = await client.call<{ fileName: string; data: string }>("preview.tab.download", {
      threadId: thread,
      tabId,
      id: offered.id,
    });
    expect(saved.fileName).toBe("report.txt");
    expect(Buffer.from(saved.data, "base64").toString()).toBe("the report");
    const missing = await rejection(
      client.call("preview.tab.download", { threadId: thread, tabId, id: "nope" }),
    );
    expect(missing.code).toBe("PREVIEW_TAB_NOT_FOUND");
  });

  it("keeps 20 downloads, offers a user's navigation to a file, and answers a file gone from the node (D1331)", async () => {
    const { client } = await node();
    const opened = await client.call<PreviewTab>("preview.tab.open", {
      threadId: thread,
      url: `${origin}/download`,
    });
    const tabId = opened.tabId;
    await client.call("preview.tab.control", { threadId: thread, tabId, viewer: "v1", take: true });
    const frames = watch(client, previewFramesStream(thread, tabId));
    const offers = () =>
      frames.events
        .filter((event) => event.type === PreviewEvents.download)
        .map((event) => event.payload as { id: string });
    // The user's own navigation to a file is no failure: the page stays, the file is offered.
    await client.call("preview.tab.navigate", {
      threadId: thread,
      tabId,
      viewer: "v1",
      url: `${origin}/report.txt`,
    });
    await frames.until(() => offers().length === 1);
    const status = await client.call<PreviewStatus>("preview.status", { threadId: thread, tabId });
    const firstPath = (status.downloads as { path: string }[])[0]!.path;
    // Twenty more: the first file goes with its entry.
    for (let count = 2; count <= 21; count += 1) {
      await client.call("preview.tab.navigate", {
        threadId: thread,
        tabId,
        viewer: "v1",
        url: `${origin}/report.txt`,
      });
      await frames.until(() => offers().length === count);
    }
    frames.subscription.dispose();
    expect(Fs.existsSync(firstPath)).toBe(false);
    const dropped = await rejection(
      client.call("preview.tab.download", { threadId: thread, tabId, id: offers()[0]!.id }),
    );
    expect(dropped.code).toBe("PREVIEW_TAB_NOT_FOUND");
    // A kept entry whose file was removed from the node answers the same.
    const kept = await client.call<PreviewStatus>("preview.status", { threadId: thread, tabId });
    Fs.rmSync((kept.downloads as { path: string }[]).at(-1)!.path);
    const removed = await rejection(
      client.call("preview.tab.download", { threadId: thread, tabId, id: offers().at(-1)!.id }),
    );
    expect(removed.code).toBe("PREVIEW_TAB_NOT_FOUND");
  });

  it("refuses to send a download over the limit, and keeps it on the node (D1331)", async () => {
    const streams = createMemoryStreams({});
    const tabs = createTabs({
      chromium: new Chromium(),
      streams,
      dataDir: Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-preview-")),
      log: { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger,
      downloadMaxBytes: 5,
    });
    try {
      const tab = await tabs.openForHuman({ threadId: "t", url: `${origin}/download` });
      await tabs.control({ threadId: "t", tabId: tab.tabId, viewer: "v1", take: true });
      const offered = new Promise<{ id: string }>((resolve) => {
        const subscription = streams.subscribe(previewFramesStream("t", tab.tabId), (event) => {
          if (event.type !== PreviewEvents.download) return;
          subscription.dispose();
          resolve(event.payload as { id: string });
        });
      });
      await tabs.navigateAsHuman({
        threadId: "t",
        tabId: tab.tabId,
        viewer: "v1",
        url: `${origin}/report.txt`,
      });
      const { id } = await offered;
      const error = await rejection(tabs.download({ threadId: "t", tabId: tab.tabId, id }));
      expect(error.code).toBe("PREVIEW_RESULT_TOO_LARGE");
      expect(error.message).toContain("stays on the node");
    } finally {
      await tabs.dispose();
    }
  });
});
