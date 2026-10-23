import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { WebSocket } from "ws";

/** A `<webview>` guest as Electron gives it: its debugger, its embedder, its lifetime. */
class FakeGuest extends EventEmitter {
  readonly id: number;
  hostWebContents: unknown;
  devTools = false;
  destroyed = false;
  readonly debugger = Object.assign(new EventEmitter(), {
    attached: false,
    attach: () => {
      this.debugger.attached = true;
    },
    detach: () => {
      if (!this.debugger.attached) return;
      this.debugger.attached = false;
      this.debugger.emit("detach");
    },
    isAttached: () => this.debugger.attached,
    sendCommand: async () => ({}),
  });
  constructor(id: number, host: unknown) {
    super();
    this.id = id;
    this.hostWebContents = host;
  }
  getType = () => "webview";
  isDestroyed = () => this.destroyed;
  isDevToolsOpened = () => this.devTools;
  getURL = () => "about:blank";
  getTitle = () => "";
  getUserAgent = () => "Electron";
  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

const guests = new Map<number, FakeGuest>();
vi.mock("electron", () => ({
  webContents: { fromId: (id: number) => guests.get(id) },
  session: { fromPartition: () => new EventEmitter() },
}));

const { createWebviewHost } = await import("../src/preview/webview-host.ts");

const page = { id: 1 };
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.terminate();
  guests.clear();
});

const host = () => createWebviewHost({ openLink: () => undefined, log: () => undefined });
const guest = (id: number, embedder: unknown = page) => {
  const created = new FakeGuest(id, embedder);
  guests.set(id, created);
  return created;
};
/** Opens a socket to an endpoint; resolves once it is open, rejects when it cannot open. */
const connect = (endpoint: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    sockets.push(socket);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
const closed = (socket: WebSocket) =>
  new Promise<void>((resolve) =>
    socket.readyState === WebSocket.CLOSED ? resolve() : socket.once("close", () => resolve()),
  );
const refused = (endpoint: string) =>
  connect(endpoint).then(
    (socket) => closed(socket).then(() => "closed"),
    () => "refused",
  );

describe("the app's webview relay (D1322)", () => {
  it("attaches only a webview of the asking page that no other debugger holds", async () => {
    const webviews = host();
    await expect(webviews.attach(page as never, 99)).rejects.toThrow("No webview");
    guest(2, { id: 7 });
    await expect(webviews.attach(page as never, 2)).rejects.toThrow("not this page's");
    const held = guest(3);
    held.devTools = true;
    await expect(webviews.attach(page as never, 3)).rejects.toThrow("Another debugger");
    const foreign = guest(4);
    foreign.debugger.attached = true;
    await expect(webviews.attach(page as never, 4)).rejects.toThrow("Another debugger");
    // Nothing was attached by the refusals.
    expect(held.debugger.isAttached()).toBe(false);
  });

  it("serves one node at a time and lets the guest go when the node does", async () => {
    const webviews = host();
    const webview = guest(5);
    const { endpoint } = await webviews.attach(page as never, 5);
    expect(endpoint).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{32}$/);
    expect(webview.debugger.isAttached()).toBe(true);
    const node = await connect(endpoint);
    // A second connection would see the first's sessions: it is closed at once.
    expect(await refused(endpoint)).toBe("closed");
    node.close();
    await new Promise<void>((resolve) => webview.debugger.once("detach", () => resolve()));
    expect(webview.debugger.isAttached()).toBe(false);
    expect(await refused(endpoint)).toBe("refused");
  });

  it("ends the relay when DevTools take the debugger or the guest goes", async () => {
    const webviews = host();
    const taken = guest(6);
    const first = await webviews.attach(page as never, 6);
    const node = await connect(first.endpoint);
    taken.debugger.detach();
    await closed(node);
    expect(await refused(first.endpoint)).toBe("refused");

    const gone = guest(7);
    const second = await webviews.attach(page as never, 7);
    const other = await connect(second.endpoint);
    gone.destroy();
    await closed(other);
    expect(await refused(second.endpoint)).toBe("refused");
  });

  it("attaches a guest again over its own earlier relay, and a refused attach keeps it", async () => {
    const webviews = host();
    const webview = guest(8);
    const first = await webviews.attach(page as never, 8);
    webview.devTools = true;
    await expect(webviews.attach(page as never, 8)).rejects.toThrow("Another debugger");
    // The refusal left the node's working relay alone.
    const node = await connect(first.endpoint);
    webview.devTools = false;
    const second = await webviews.attach(page as never, 8);
    await closed(node);
    expect(webview.debugger.isAttached()).toBe(true);
    expect(second.endpoint).not.toBe(first.endpoint);
    await connect(second.endpoint);
  });

  it("lets go of a guest whose relay no node connects to", async () => {
    const webviews = createWebviewHost({
      openLink: () => undefined,
      log: () => undefined,
      unclaimedMs: 0,
    });
    const webview = guest(9);
    const released = new Promise<void>((resolve) =>
      webview.debugger.once("detach", () => resolve()),
    );
    const { endpoint } = await webviews.attach(page as never, 9);
    await released;
    expect(webview.debugger.isAttached()).toBe(false);
    expect(await refused(endpoint)).toBe("refused");
  });
});
