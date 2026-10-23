// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/preview/DesktopBrowserHost.ts
// (the relay of each attached tab, downloads placed where the node asked),
// apps/desktop/src/preview/BrowserSession.ts (the preview's permissions) and the
// `will-attach-webview` gate of apps/desktop/src/window/DesktopWindow.ts.
import * as Crypto from "node:crypto";
import * as Path from "node:path";

import { session, webContents, type WebContents, type WebPreferences } from "electron";
import { WebSocketServer, type WebSocket } from "ws";

import { createCdpRelayConnection, type CdpRelayConnection } from "./cdp-relay.ts";
import {
  ALLOWED_PREVIEW_PERMISSIONS,
  PREVIEW_PARTITION,
  hardenWebview,
  openLinkUrl,
} from "./webview-policy.ts";
import { sendPageCommand } from "./guest-input.ts";

/** How long a relay waits for the node: past the node's 10 s wait and its 15 s connect. */
const UNCLAIMED_RELAY_MS = 30_000;

interface Attached {
  readonly guest: WebContents;
  readonly endpoint: string;
  downloadDirectory: string | null;
  pendingDownloadGuid: string | null;
  close(): void;
}

export interface WebviewHostOptions {
  /** A guest's page opened a window at an http(s) URL. */
  readonly openLink: (link: { webContentsId: number; url: string }) => void;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

/** The webviews of the app's window the node drives (D1322). */
export function createWebviewHost(options: WebviewHostOptions) {
  const attached = new Map<number, Attached>();
  const preparedSessions = new WeakSet<Electron.Session>();

  /** Permissions and downloads of a partition, set once per session. */
  const prepareSession = (partition: string) => {
    const guestSession = session.fromPartition(partition);
    if (preparedSessions.has(guestSession)) return;
    preparedSessions.add(guestSession);
    guestSession.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(ALLOWED_PREVIEW_PERMISSIONS.has(permission)),
    );
    guestSession.setPermissionCheckHandler((_contents, permission) =>
      ALLOWED_PREVIEW_PERMISSIONS.has(permission),
    );
    // Without a path Electron would open its Save dialog over the app for a
    // file the node asked for; CDP names the download just before this runs.
    guestSession.on("will-download", (_event, item, source) => {
      const tab = source === undefined ? undefined : attached.get(source.id);
      if (tab?.downloadDirectory == null || tab.pendingDownloadGuid === null) return;
      item.setSavePath(Path.join(tab.downloadDirectory, tab.pendingDownloadGuid));
      tab.pendingDownloadGuid = null;
    });
  };

  /** A webview of the app's page is attaching: harden it, or refuse it. */
  const willAttach = (
    event: Electron.Event,
    preferences: WebPreferences,
    params: Record<string, string>,
  ) => {
    if (!hardenWebview(preferences, params)) {
      event.preventDefault();
      return;
    }
    prepareSession(params["partition"]!);
  };

  /** A webview attached: its windows become tabs of the node (T3's `onOpenLink`). */
  const didAttach = (guest: WebContents) => {
    guest.setWindowOpenHandler(({ url }) => {
      const link = openLinkUrl(url);
      if (link !== undefined) options.openLink({ webContentsId: guest.id, url: link });
      return { action: "deny" };
    });
  };

  /**
   * Attaches the debugger of a webview of `host` and serves it as a browser of
   * one page on a loopback WebSocket, for one connection (D1322).
   */
  const attach = async (
    host: WebContents,
    webContentsId: number,
  ): Promise<{ endpoint: string }> => {
    const guest = webContents.fromId(webContentsId);
    if (guest === undefined || guest.isDestroyed() || guest.getType() !== "webview") {
      throw new Error("No webview of the app has this id.");
    }
    if (guest.hostWebContents !== host) throw new Error("The webview is not this page's.");
    attached.get(webContentsId)?.close();
    if (guest.isDevToolsOpened() || guest.debugger.isAttached()) {
      throw new Error("Another debugger holds the webview.");
    }
    guest.debugger.attach("1.3");
    const secret = Crypto.randomBytes(24).toString("base64url");
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: `/${secret}` });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    } catch (error) {
      server.close();
      if (guest.debugger.isAttached()) guest.debugger.detach();
      throw error;
    }
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No relay address.");
    let connection: WebSocket | null = null;
    let relay: CdpRelayConnection | null = null;
    let closed = false;
    const onMessage = (
      _event: Electron.Event,
      method: string,
      params: unknown,
      sessionId: string,
    ) => {
      if (method === "Browser.downloadWillBegin") {
        const guid = (params as { guid?: unknown } | undefined)?.guid;
        tab.pendingDownloadGuid = typeof guid === "string" ? guid : null;
      }
      relay?.event(method, params, sessionId);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(unclaimed);
      if (attached.get(webContentsId) === tab) attached.delete(webContentsId);
      relay = null;
      connection?.terminate();
      server.close();
      if (!guest.isDestroyed()) {
        guest.debugger.off("message", onMessage);
        guest.debugger.off("detach", close);
        if (guest.debugger.isAttached()) guest.debugger.detach();
      }
    };
    const tab: Attached = {
      guest,
      endpoint: `ws://127.0.0.1:${address.port}/${secret}`,
      downloadDirectory: null,
      pendingDownloadGuid: null,
      close,
    };
    attached.set(webContentsId, tab);
    // A node that never connects (it opened the tab headless meanwhile) does not keep the
    // guest's debugger and the relay: they go once the node's own wait is long over.
    const unclaimed = setTimeout(() => {
      if (connection === null) close();
    }, UNCLAIMED_RELAY_MS);
    guest.debugger.on("message", onMessage);
    // DevTools took the debugger, or the guest went: the node's tab ends.
    guest.debugger.on("detach", close);
    guest.once("destroyed", close);
    server.on("connection", (socket) => {
      // One Playwright connection: a second would see the first's sessions.
      if (connection !== null || closed) {
        socket.close();
        return;
      }
      connection = socket;
      clearTimeout(unclaimed);
      relay = createCdpRelayConnection(
        {
          send: (method, params, sessionId) =>
            sessionId === undefined
              ? sendPageCommand(guest, guest.debugger, method, params)
              : guest.debugger.sendCommand(method, params, sessionId),
          targetId: () =>
            guest.debugger
              .sendCommand("Target.getTargetInfo")
              .then((result: { targetInfo: { targetId: string } }) => result.targetInfo.targetId),
          url: () => guest.getURL(),
          title: () => guest.getTitle(),
          userAgent: () => guest.getUserAgent(),
          setDownloadDirectory: (directory) => {
            tab.downloadDirectory = directory;
          },
        },
        (message) => {
          if (connection === socket) socket.send(message);
        },
      );
      socket.on("message", (data) => relay?.receive(String(data)));
      // The node let go: so does the app.
      socket.on("close", close);
    });
    options.log("preview webview attached", { webContentsId });
    return { endpoint: tab.endpoint };
  };

  /** Forgets a profile's cookies and storage in the app (D1323). */
  const clearPartition = async (partition: string) => {
    if (!PREVIEW_PARTITION.test(partition)) throw new Error("Not a partition of the preview.");
    const guestSession = session.fromPartition(partition);
    await guestSession.clearStorageData();
    await guestSession.clearCache();
  };

  return {
    willAttach,
    didAttach,
    attach,
    clearPartition,
    dispose() {
      // A Map may lose entries while it is iterated.
      for (const tab of attached.values()) tab.close();
    },
  };
}
