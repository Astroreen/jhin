// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): the `will-attach-webview` gate of
// apps/desktop/src/window/DesktopWindow.ts and the preview's permissions of
// apps/desktop/src/preview/BrowserSession.ts (D1323).
import { PREVIEW_PARTITION_PATTERN } from "@jhin/preview-api";
import type { WebPreferences } from "electron";

/**
 * The preview's partitions (D1323): a profile's persistent one, or an
 * incognito or agent tab's in memory.
 */
export const PREVIEW_PARTITION = PREVIEW_PARTITION_PATTERN;

/**
 * T3's preview permissions but reading the clipboard, which waits for a
 * prompt (D1323): writing to the clipboard, notifications, location and full
 * screen (kept inside the webview). Nothing else, such as local fonts.
 */
export const ALLOWED_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "notifications",
  "geolocation",
  "fullscreen",
]);

/**
 * Hardens a webview before it attaches, as T3's window does: only the
 * preview's partitions, no preload, sandboxed, no Node. Returns false when the
 * attach must be refused.
 */
export function hardenWebview(
  preferences: WebPreferences,
  params: Record<string, string>,
  /** The app's own preload of the preview, for annotation (D1491); never the page's. */
  guestPreload?: string,
): boolean {
  const partition = params["partition"];
  if (typeof partition !== "string" || !PREVIEW_PARTITION.test(partition)) return false;
  const src = params["src"] ?? "";
  if (src !== "" && src !== "about:blank" && !/^https?:/i.test(src)) return false;
  // Electron has merged the page's own `preload`, `nodeintegration`,
  // `disablewebsecurity` and `webpreferences` params into `preferences` by now:
  // each is reset here, whatever the page asked for.
  delete preferences.preload;
  if (guestPreload !== undefined) preferences.preload = guestPreload;
  for (const param of [
    "preload",
    "nodeintegration",
    "nodeintegrationinsubframes",
    "disablewebsecurity",
    "webpreferences",
  ]) {
    delete params[param];
  }
  preferences.sandbox = true;
  preferences.nodeIntegration = false;
  preferences.nodeIntegrationInSubFrames = false;
  preferences.contextIsolation = true;
  preferences.webSecurity = true;
  preferences.disableHtmlFullscreenWindowResize = true;
  preferences.allowRunningInsecureContent = false;
  preferences.experimentalFeatures = false;
  preferences.enableBlinkFeatures = "";
  preferences.webviewTag = false;
  return true;
}

/** What a page that opens a window gets: an http(s) URL opens as a tab, the rest is dropped. */
export function openLinkUrl(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
}
