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
import { LIVE_STREAMS_CAPABILITY, createLiveStreams, type RpcClient } from "@jhin/rpc";
import type { StoredEvent } from "@jhin/storage-api";
import {
  connectInMemory,
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
} from "@jhin/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import preview from "../src/index.ts";

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
};

let server: Http.Server;
let origin = "";
beforeAll(async () => {
  server = Http.createServer((request, response) => {
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

async function node(options: { executablePath?: string } = {}) {
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
  const stop = async () => {
    client.close();
    await kernel.stop();
  };
  stops.push(stop);
  return { kernel, client, storage, stop };
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

const thread = "thread-1";

// Every test starts a real Chromium, several at once on a loaded CI runner: the limit is a
// ceiling for the browser's start, not a wait; each test waits for page events or results.
describe("jhin.preview", { timeout: 30_000 }, () => {
  it("opens a tab, reads its accessibility tree and acts on refs", async () => {
    const { client } = await node();
    const opened = await client.call<PreviewStatus>("preview.open", {
      threadId: thread,
      url: `${origin}/`,
    });
    expect(opened.tabId).toMatch(/^tab_1_/);
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
});
