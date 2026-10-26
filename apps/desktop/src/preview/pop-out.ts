// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): `openPictureInPicture`,
// `buildPreviewPictureInPictureDataUrl`, `fitPictureInPictureContentSize` and the frame capture
// of apps/desktop/src/preview/Manager.ts (docs/plans/desktop.md, D1493).
import * as Crypto from "node:crypto";

import { BrowserWindow, webContents, type WebContents } from "electron";

import { POP_OUT_FRAME_CHANNEL } from "@jhin/desktop-api/channels";
/** T3's ~12 frames a second. */
const FRAME_INTERVAL_MS = Math.ceil(1000 / 12);
const JPEG_QUALITY = 80;

/** T3's page: one image, nothing it may load but data. */
function popOutPageUrl(): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>html,body{margin:0;height:100%;background:#111111;overflow:hidden}img{display:block;width:100%;height:100%;object-fit:contain}</style></head><body><img alt="Live browser preview"></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** T3's `fitPictureInPictureContentSize`: the window's width kept, its height the page's aspect. */
function fitContentSize(
  window: { width: number; height: number },
  frame: { width: number; height: number },
): { width: number; height: number } {
  if (frame.width <= 0 || frame.height <= 0) return window;
  const width = Math.max(240, window.width);
  return { width, height: Math.max(160, Math.round((width * frame.height) / frame.width)) };
}

interface PopOut {
  readonly window: BrowserWindow;
  readonly guest: WebContents;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastFrame: string | undefined;
  aspect: number | undefined;
}

export interface PopOutOptions {
  /** The pop-out window's preload (`preview-pop-out-preload.cjs`). */
  readonly preload: string;
  readonly platform: NodeJS.Platform;
  /** A pop-out window closed, by the user or with its guest. */
  readonly closed: (webContentsId: number) => void;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

/** T3's separate always-on-top window of a webview's page, fed with its captured frames. */
export function createPopOuts(options: PopOutOptions) {
  const open = new Map<number, PopOut>();

  const close = (webContentsId: number) => {
    const popOut = open.get(webContentsId);
    if (popOut === undefined) return;
    open.delete(webContentsId);
    if (popOut.timer !== undefined) clearTimeout(popOut.timer);
    if (!popOut.guest.isDestroyed()) popOut.guest.setBackgroundThrottling(true);
    if (!popOut.window.isDestroyed()) popOut.window.destroy();
    options.closed(webContentsId);
  };

  const capture = (webContentsId: number) => {
    const popOut = open.get(webContentsId);
    if (popOut === undefined) return;
    const { guest, window } = popOut;
    if (guest.isDestroyed() || window.isDestroyed()) {
      close(webContentsId);
      return;
    }
    void guest
      .capturePage()
      .then((image) => {
        if (open.get(webContentsId) !== popOut || window.isDestroyed() || image.isEmpty()) return;
        const jpeg = image.toJPEG(JPEG_QUALITY);
        // Unchanged frames are not sent again (T3's fingerprint).
        const fingerprint = Crypto.createHash("sha1").update(jpeg).digest("hex");
        if (fingerprint === popOut.lastFrame) return;
        popOut.lastFrame = fingerprint;
        const size = image.getSize();
        const aspect = size.width / size.height;
        if (popOut.aspect === undefined || Math.abs(popOut.aspect - aspect) > 0.01) {
          popOut.aspect = aspect;
          const [width = 480, height = 320] = window.getContentSize();
          const fitted = fitContentSize({ width, height }, size);
          window.setContentSize(fitted.width, fitted.height);
          window.setAspectRatio(aspect);
        }
        window.webContents.send(
          POP_OUT_FRAME_CHANNEL,
          `data:image/jpeg;base64,${jpeg.toString("base64")}`,
        );
      })
      .catch((error: unknown) =>
        options.log("pop-out frame not captured", { error: String(error) }),
      )
      .finally(() => {
        if (open.get(webContentsId) === popOut) {
          popOut.timer = setTimeout(() => capture(webContentsId), FRAME_INTERVAL_MS);
        }
      });
  };

  return {
    /** Opens the guest's pop-out, or shows the one already open (D1493). */
    open(host: WebContents, webContentsId: number, title: string): void {
      const guest = webContents.fromId(webContentsId);
      if (guest === undefined || guest.isDestroyed() || guest.getType() !== "webview") {
        throw new Error("No webview of the app has this id.");
      }
      if (guest.hostWebContents !== host) throw new Error("The webview is not this page's.");
      const existing = open.get(webContentsId);
      if (existing !== undefined) {
        existing.window.showInactive();
        return;
      }
      const window = new BrowserWindow({
        width: 480,
        height: 320,
        minWidth: 240,
        minHeight: 160,
        title: title.trim() === "" ? "Browser preview" : `Preview · ${title}`,
        show: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        backgroundColor: "#111111",
        ...(options.platform === "darwin" ? { type: "panel" } : {}),
        webPreferences: {
          preload: options.preload,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      window.setAlwaysOnTop(true, options.platform === "darwin" ? "floating" : "normal");
      window.setVisibleOnAllWorkspaces(true);
      // Nothing in it may navigate or open a window.
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.on("page-title-updated", (event) => event.preventDefault());
      const popOut: PopOut = {
        window,
        guest,
        timer: undefined,
        lastFrame: undefined,
        aspect: undefined,
      };
      open.set(webContentsId, popOut);
      const guestGone = () => close(webContentsId);
      window.once("closed", () => {
        if (!guest.isDestroyed()) guest.off("destroyed", guestGone);
        close(webContentsId);
      });
      guest.once("destroyed", guestGone);
      // A guest kept behind the app still paints (D1493).
      guest.setBackgroundThrottling(false);
      window
        .loadURL(popOutPageUrl())
        .then(() => {
          if (window.isDestroyed()) return;
          window.showInactive();
          capture(webContentsId);
        })
        .catch((error: unknown) => {
          options.log("pop-out window not loaded", { error: String(error) });
          close(webContentsId);
        });
    },
    close,
    /** Whether a guest's pop-out is open. */
    isOpen: (webContentsId: number) => open.has(webContentsId),
    dispose(): void {
      for (const id of open.keys()) close(id);
    },
  };
}
