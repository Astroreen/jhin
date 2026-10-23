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
 * T3's preview permissions: the clipboard, notifications, location and full
 * screen (kept inside the webview). Nothing else, such as local fonts.
 */
export const ALLOWED_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-read",
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
): boolean {
  const partition = params["partition"];
  if (typeof partition !== "string" || !PREVIEW_PARTITION.test(partition)) return false;
  const src = params["src"] ?? "";
  if (src !== "" && src !== "about:blank" && !/^https?:/i.test(src)) return false;
  delete preferences.preload;
  preferences.sandbox = true;
  preferences.nodeIntegration = false;
  preferences.nodeIntegrationInSubFrames = false;
  preferences.contextIsolation = true;
  preferences.webSecurity = true;
  preferences.disableHtmlFullscreenWindowResize = true;
  return true;
}

/** What a page that opens a window gets: an http(s) URL opens as a tab, the rest is dropped. */
export function openLinkUrl(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
}
