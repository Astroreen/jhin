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
type Handlers = {
  request?:
    | ((contents: unknown, permission: string, callback: (granted: boolean) => void) => void)
    | undefined;
  check?: ((contents: unknown, permission: string) => boolean) | undefined;
};
const sessions = new Map<string, EventEmitter & { handlers: Handlers }>();
vi.mock("electron", () => ({
  webContents: { fromId: (id: number) => guests.get(id) },
  session: {
    fromPartition: (partition: string) => {
      const known =
        sessions.get(partition) ?? Object.assign(new EventEmitter(), { handlers: {} as Handlers });
      sessions.set(
        partition,
        Object.assign(known, {
          setPermissionRequestHandler: (handler: Handlers["request"]) => {
            known.handlers.request = handler;
          },
          setPermissionCheckHandler: (handler: Handlers["check"]) => {
            known.handlers.check = handler;
          },
        }),
      );
      return known;
    },
  },
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

  it("places a download the node asked for under its name, and lets no other open a dialog", async () => {
    const webviews = host();
    const partition = "persist:jhin-preview-ZGVmYXVsdA";
    webviews.willAttach({ preventDefault() {} } as never, {}, { partition, src: "about:blank" });
    const webview = guest(10);
    const { endpoint } = await webviews.attach(page as never, 10);
    const node = await connect(endpoint);
    // The node's Playwright gives its download folder (relayed to the guest's debugger).
    const answered = new Promise<void>((resolve) => node.once("message", () => resolve()));
    node.send(
      JSON.stringify({
        id: 1,
        method: "Browser.setDownloadBehavior",
        params: { behavior: "allowAndName", downloadPath: "/downloads" },
      }),
    );
    await answered;
    const item = (url: string) => {
      const placed = { path: undefined as string | undefined, cancelled: false };
      return {
        placed,
        getURL: () => url,
        setSavePath: (path: string) => {
          placed.path = path;
        },
        cancel: () => {
          placed.cancelled = true;
        },
      };
    };
    const session = sessions.get(partition)!;
    // CDP names two downloads; Electron places only the second (the first was cancelled).
    webview.debugger.emit(
      "message",
      {},
      "Browser.downloadWillBegin",
      { guid: "g1", url: "http://x/a" },
      "",
    );
    webview.debugger.emit(
      "message",
      {},
      "Browser.downloadWillBegin",
      { guid: "g2", url: "http://x/b" },
      "",
    );
    const second = item("http://x/b");
    session.emit("will-download", {}, second, webview);
    expect(second.placed).toEqual({ path: "/downloads/g2", cancelled: false });
    // A download the node never heard of is cancelled, not left to a Save dialog.
    const stray = item("http://x/c");
    session.emit("will-download", {}, stray, webview);
    expect(stray.placed).toEqual({ path: undefined, cancelled: true });
  });

  it("leaves no listener on a guest it attached again", async () => {
    const webviews = host();
    const webview = guest(11);
    await webviews.attach(page as never, 11);
    await webviews.attach(page as never, 11);
    expect(webview.listenerCount("destroyed")).toBe(1);
    expect(webview.debugger.listenerCount("detach")).toBe(1);
  });

  it("keeps a working relay when the relay to replace it cannot start, and says so", async () => {
    const webviews = host();
    const webview = guest(12);
    const first = await webviews.attach(page as never, 12);
    const node = await connect(first.endpoint);
    // The guest's debugger refuses once its relay has gone: the attach fails, and says why.
    const attach = webview.debugger.attach;
    webview.debugger.attach = () => {
      throw new Error("the debugger refused");
    };
    await expect(webviews.attach(page as never, 12)).rejects.toThrow("the debugger refused");
    // A guest with no relay of ours: the node's connection ended with the handover, and
    // nothing is left listening.
    await closed(node);
    expect(await refused(first.endpoint)).toBe("refused");
    webview.debugger.attach = attach;
    const again = await webviews.attach(page as never, 12);
    await connect(again.endpoint);
  });

  it("grants a preview page T3's permissions but reading the clipboard (D1323)", () => {
    const webviews = host();
    const partition = "persist:jhin-preview-cGVybWlzc2lvbnM";
    webviews.willAttach({ preventDefault() {} } as never, {}, { partition, src: "about:blank" });
    const { handlers } = sessions.get(partition)!;
    const granted = (permission: string) => {
      let answer: boolean | undefined;
      handlers.request!({}, permission, (value) => {
        answer = value;
      });
      expect(handlers.check!({}, permission)).toBe(answer);
      return answer;
    };
    expect(granted("clipboard-sanitized-write")).toBe(true);
    expect(granted("fullscreen")).toBe(true);
    expect(granted("clipboard-read")).toBe(false);
    expect(granted("local-fonts")).toBe(false);
  });
});
