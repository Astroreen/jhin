// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/preview/DesktopBrowserHost.ts
// (the relay of each attached tab, downloads placed where the node asked),
// apps/desktop/src/preview/BrowserSession.ts (the preview's permissions) and the
// `will-attach-webview` gate of apps/desktop/src/window/DesktopWindow.ts.
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";

import { session, webContents, type WebContents, type WebPreferences } from "electron";
import { WebSocketServer, type WebSocket } from "ws";

import { GUEST_CHANNELS } from "@jhin/desktop-api/channels";
import { PreviewAnnotation, type PreviewPickResult } from "@jhin/desktop-api";
import { z } from "@jhin/sdk";

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
/** T3's `AGENT_DOWNLOAD_WINDOW_MS`: a download this soon after the agent acted is the agent's. */
const AGENT_DOWNLOAD_WINDOW_MS = 5_000;
/** CDP commands by which the node acts on a page (T3's `isAgentAction`). */
const AGENT_ACTION = /^(Input\.|Page\.navigate$|Runtime\.(evaluate|callFunctionOn)$)/;

/** What the guest's overlay sends once the user attached (D1491). */
const GuestPick = z.object({
  annotation: PreviewAnnotation,
  submission: z.enum(["attach", "send"]),
  cropRect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
});

/** T3's dedupe: `name.ext`, then `name (1).ext` and so on, at most 100 tries. */
function freeDownloadPath(folder: string, fileName: string, exists = Fs.existsSync): string {
  const { name, ext } = Path.parse(fileName);
  for (let index = 0; index < 100; index += 1) {
    const candidate = Path.join(folder, index === 0 ? fileName : `${name} (${index})${ext}`);
    if (!exists(candidate)) return candidate;
  }
  return Path.join(folder, `${name} (${Date.now()})${ext}`);
}

interface Attached {
  readonly guest: WebContents;
  readonly endpoint: string;
  downloadDirectory: string | null;
  /** When the node last acted on the page (T3's `humanStartedDownload`, D1492). */
  agentActedAt: number;
  /**
   * Downloads CDP named that Electron has not asked to place yet, oldest first; `fresh`
   * until Electron placed a download after it (one never placed was cancelled first).
   */
  readonly pendingDownloads: { readonly guid: string; readonly url: string; fresh: boolean }[];
  close(): void;
}

export interface WebviewHostOptions {
  /** How long a relay waits for the node before it lets go of the guest; tests give their own. */
  readonly unclaimedMs?: number;
  /** A guest's page opened a window at an http(s) URL. */
  readonly openLink: (link: { webContentsId: number; url: string }) => void;
  /** A guest's DevTools closed: its page may attach it again (D1489). */
  readonly devToolsClosed?: (webContentsId: number) => void;
  /** Where a human's download is copied, and how it is shown (T3's, D1492). */
  readonly downloads?: { folder(): string; reveal(path: string): void };
  /** The preview's own preload in every guest, for annotation (D1491). */
  readonly guestPreload?: string;
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
      if (tab === undefined) return;
      // The download CDP named for this URL. Electron's URL is the final one, so a redirected,
      // blob: or data: download is the newest one CDP named since the last placed; one CDP
      // named and Electron never placed (cancelled first) cannot lend its name.
      const pendings = tab.pendingDownloads;
      let index = pendings.findIndex((pending) => pending.url === item.getURL());
      if (index < 0) index = pendings.findLastIndex((pending) => pending.fresh);
      const pending = index < 0 ? undefined : pendings.splice(index, 1)[0];
      for (const left of pendings) left.fresh = false;
      // No folder from the node, or a download the node did not hear of: nothing to place it,
      // and no Save dialog over the app either.
      if (tab.downloadDirectory === null || pending === undefined) {
        options.log("preview download cancelled", {
          webContentsId: source?.id,
          reason: tab.downloadDirectory === null ? "no folder" : "not announced",
        });
        item.cancel();
        return;
      }
      item.setSavePath(Path.join(tab.downloadDirectory, pending.guid));
      // The user's own download also lands in their Downloads folder (T3's, D1492).
      const human = Date.now() - tab.agentActedAt > AGENT_DOWNLOAD_WINDOW_MS;
      const downloads = options.downloads;
      if (human && downloads !== undefined) {
        item.once("done", (_done, state) => {
          if (state !== "completed") return;
          try {
            const folder = downloads.folder();
            Fs.mkdirSync(folder, { recursive: true });
            const target = freeDownloadPath(
              folder,
              Path.basename(item.getFilename()) || "download",
            );
            Fs.copyFileSync(item.getSavePath(), target);
            downloads.reveal(target);
          } catch (error) {
            options.log("preview download not copied", { error: String(error) });
          }
        });
      }
    });
  };

  /** A webview of the app's page is attaching: harden it, or refuse it. */
  const willAttach = (
    event: Electron.Event,
    preferences: WebPreferences,
    params: Record<string, string>,
  ) => {
    if (!hardenWebview(preferences, params, options.guestPreload)) {
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
    // An attach refused (DevTools, a foreign debugger) or a relay that cannot start keeps the
    // node's working connection. Once both are fine, the earlier relay of the guest goes:
    // Electron allows the guest one debugger, so the new attach cannot be made beside it, and
    // a debugger attach that still fails then leaves the guest with no relay (the node's tab
    // ends, D1322).
    /** Refuses a guest DevTools or a debugger not of this host holds. */
    const refuseHeld = () => {
      if (
        guest.isDevToolsOpened() ||
        (guest.debugger.isAttached() && attached.get(webContentsId) === undefined)
      ) {
        throw new Error("Another debugger holds the webview.");
      }
    };
    refuseHeld();
    const secret = Crypto.randomBytes(24).toString("base64url");
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: `/${secret}` });
    let address: ReturnType<WebSocketServer["address"]>;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      address = server.address();
      if (address === null || typeof address === "string") throw new Error("No relay address.");
      // Read again after the wait: another attach of the guest may have taken it meanwhile (the
      // page retries on each document), and this one replaces whichever relay is there now.
      if (guest.isDestroyed()) throw new Error("No webview of the app has this id.");
      refuseHeld();
      attached.get(webContentsId)?.close();
      guest.debugger.attach("1.3");
    } catch (error) {
      // Nothing of a failed attach stays: no server (the debugger attach is the last step).
      server.close();
      throw error;
    }
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
        const { guid, url } = (params ?? {}) as { guid?: unknown; url?: unknown };
        if (typeof guid === "string" && typeof url === "string") {
          tab.pendingDownloads.push({ guid, url, fresh: true });
          // A few never placed (cancelled first) are all that can pile up.
          if (tab.pendingDownloads.length > 20) tab.pendingDownloads.shift();
        }
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
        guest.off("destroyed", close);
        guest.debugger.off("detach", close);
        if (guest.debugger.isAttached()) guest.debugger.detach();
      }
    };
    const tab: Attached = {
      guest,
      endpoint: `ws://127.0.0.1:${address.port}/${secret}`,
      downloadDirectory: null,
      agentActedAt: 0,
      pendingDownloads: [],
      close,
    };
    attached.set(webContentsId, tab);
    // A node that never connects (it opened the tab headless meanwhile) does not keep the
    // guest's debugger and the relay: they go once the node's own wait is long over.
    const unclaimed = setTimeout(() => {
      if (connection === null) close();
    }, options.unclaimedMs ?? UNCLAIMED_RELAY_MS);
    guest.debugger.on("message", onMessage);
    // DevTools took the debugger, or the guest went: the node's tab ends.
    guest.debugger.on("detach", close);
    guest.once("destroyed", close);
    // A relay that fails once it listens ends, rather than throwing in the main process.
    server.on("error", (error) => {
      options.log("preview relay failed", { webContentsId, error: String(error) });
      close();
    });
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
      socket.on("message", (data) => {
        const message = String(data);
        // Only the method is read, to tell the agent's downloads from the user's (D1492).
        const method = /"method"\s*:\s*"([^"]+)"/.exec(message)?.[1];
        if (method !== undefined && AGENT_ACTION.test(method)) tab.agentActedAt = Date.now();
        relay?.receive(message);
      });
      // The node let go: so does the app.
      socket.on("close", close);
    });
    options.log("preview webview attached", { webContentsId });
    return { endpoint: tab.endpoint };
  };

  /**
   * Opens a webview's DevTools in a window of their own, or focuses them (T3's
   * `openDevTools`, D1489). DevTools take the guest's one debugger, so its
   * relay ends first: the node's tab waits for it again (D1488) until the
   * page attaches it once they closed.
   */
  const openDevTools = (host: WebContents, webContentsId: number) => {
    const guest = webContents.fromId(webContentsId);
    if (guest === undefined || guest.isDestroyed() || guest.getType() !== "webview") {
      throw new Error("No webview of the app has this id.");
    }
    if (guest.hostWebContents !== host) throw new Error("The webview is not this page's.");
    if (guest.isDevToolsOpened()) {
      guest.devToolsWebContents?.focus();
      return;
    }
    attached.get(webContentsId)?.close();
    guest.openDevTools({ mode: "detach" });
    // Registered once they opened: a failed open leaves no listener behind.
    guest.once("devtools-closed", () => {
      if (!guest.isDestroyed()) options.devToolsClosed?.(webContentsId);
    });
  };

  /** One annotation at a time per guest; a newer one replaces it (T3's `pickElement`). */
  const picking = new Map<number, (result: PreviewPickResult) => void>();

  /**
   * T3's `pickElement` (D1491): the guest's overlay picks elements and a comment, then the main
   * process captures the picked area. Null when cancelled, navigated away or gone.
   */
  const pickElement = (host: WebContents, webContentsId: number): Promise<PreviewPickResult> => {
    const guest = webContents.fromId(webContentsId);
    if (guest === undefined || guest.isDestroyed() || guest.getType() !== "webview") {
      throw new Error("No webview of the app has this id.");
    }
    if (guest.hostWebContents !== host) throw new Error("The webview is not this page's.");
    picking.get(webContentsId)?.(null);
    return new Promise((resolve) => {
      let settled = false;
      const done = (result: PreviewPickResult) => {
        if (settled) return;
        settled = true;
        if (picking.get(webContentsId) === done) picking.delete(webContentsId);
        guest.ipc.removeListener(GUEST_CHANNELS.elementPicked, onPicked);
        guest.ipc.removeListener(GUEST_CHANNELS.pickCancelled, onCancelled);
        guest.off("did-start-navigation", onNavigation);
        guest.off("destroyed", onGone);
        resolve(result);
      };
      const onCancelled = () => done(null);
      const onGone = () => done(null);
      const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) done(null);
      };
      const onPicked = (_event: unknown, raw: unknown) => {
        const parsed = GuestPick.safeParse(raw);
        if (!parsed.success) {
          options.log("annotation refused", { error: parsed.error.message });
          if (!guest.isDestroyed()) guest.send(GUEST_CHANNELS.cancelPick);
          done(null);
          return;
        }
        const { annotation, submission, cropRect } = parsed.data;
        // T3's crop: the picked area, a little wider, inside the page.
        const pad = 8;
        const x = Math.max(0, Math.floor(cropRect.x - pad));
        const y = Math.max(0, Math.floor(cropRect.y - pad));
        const rect = {
          x,
          y,
          width: Math.max(1, Math.ceil(cropRect.width + pad * 2 - (x - (cropRect.x - pad)))),
          height: Math.max(1, Math.ceil(cropRect.height + pad * 2 - (y - (cropRect.y - pad)))),
        };
        void guest
          .capturePage(rect)
          .then((image) => {
            if (image.isEmpty()) return null;
            const size = image.getSize();
            return { dataUrl: image.toDataURL(), width: size.width, height: size.height };
          })
          .catch((error: unknown) => {
            options.log("annotation screenshot failed", { error: String(error) });
            return null;
          })
          .then((screenshot) => {
            if (!guest.isDestroyed()) guest.send(GUEST_CHANNELS.annotationCaptured);
            done({ annotation, submission, screenshot });
          });
      };
      picking.set(webContentsId, done);
      guest.ipc.on(GUEST_CHANNELS.elementPicked, onPicked);
      guest.ipc.on(GUEST_CHANNELS.pickCancelled, onCancelled);
      guest.on("did-start-navigation", onNavigation);
      guest.once("destroyed", onGone);
      guest.focus();
      guest.send(GUEST_CHANNELS.startPick, { sendEnabled: true });
    });
  };

  const cancelPick = (host: WebContents, webContentsId: number) => {
    const guest = webContents.fromId(webContentsId);
    if (guest === undefined || guest.isDestroyed() || guest.hostWebContents !== host) return;
    guest.send(GUEST_CHANNELS.cancelPick);
    picking.get(webContentsId)?.(null);
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
    openDevTools,
    pickElement,
    cancelPick,
    clearPartition,
    dispose() {
      // A Map may lose entries while it is iterated.
      for (const tab of attached.values()) tab.close();
    },
  };
}
