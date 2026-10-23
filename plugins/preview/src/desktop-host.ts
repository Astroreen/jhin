// Waiting for the desktop app's webview follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/preview/DesktopBrowserChannel.ts (`awaitAttached`) and the desktop parts of
// apps/server/src/preview/ServerBrowser.ts (`desktopRenders`, DESKTOP_ATTACH_TIMEOUT).
import {
  PREVIEW_DESKTOP_STREAM,
  PreviewError,
  PreviewEvents,
  type PreviewDesktopTab,
} from "@jhin/preview-api";
import type { MemoryStreams, StreamSource } from "@jhin/rpc";
import type { BrowserContext, Page } from "playwright-core";
import { toDisposable } from "@jhin/sdk";
import type { Json } from "@jhin/storage-api";

/** T3's DESKTOP_ATTACH_TIMEOUT: how long a new tab waits for the app's webview. */
const DESKTOP_ATTACH_TIMEOUT_MS = 10_000;

/** A page of the desktop app's webview the node drives over CDP (D1321). */
export interface DesktopPage {
  readonly page: Page;
  readonly context: BrowserContext;
  /** Disconnects: the webview's page is the app's to close. */
  close(): Promise<void>;
}

const keyOf = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;

interface Entry {
  readonly tab: PreviewDesktopTab;
  /** Settles a pending request: the endpoint, or null when it gave up. */
  readonly settle?: (endpoint: string | null) => void;
}

/**
 * The desktop app that hosts the node's tabs in webviews (D1321): present
 * while its page subscribes to `preview-desktop`, which lists the tabs it
 * should host.
 */
export function createDesktopHost(streams: MemoryStreams) {
  const entries = new Map<string, Entry>();
  let hosts = 0;

  const publish = () => {
    streams.clear(PREVIEW_DESKTOP_STREAM);
    const tabs = [...entries.values()].map((entry) => entry.tab) as unknown as Json[];
    streams.append(PREVIEW_DESKTOP_STREAM, PreviewEvents.desktopTabs, { tabs });
  };
  publish();

  const source: StreamSource = {
    head: (stream) => streams.head(stream),
    read: (stream, options) => streams.read(stream, options),
    subscribe(stream, listener) {
      const subscription = streams.subscribe(stream, listener);
      hosts += 1;
      let open = true;
      return toDisposable(() => {
        subscription.dispose();
        if (!open) return;
        open = false;
        hosts -= 1;
        // The last page that hosted went: nothing attaches what it was asked for, and the
        // webviews it attached went with it, so the next page is told of none of them.
        if (hosts === 0) {
          for (const entry of entries.values()) entry.settle?.(null);
          entries.clear();
          publish();
        }
      });
    },
  };

  return {
    source,

    /** Whether a desktop app's page hosts tabs now. */
    active: () => hosts > 0,

    /**
     * Announces a tab to the app and waits for its webview's endpoint; null
     * when none attaches within `timeoutMs` or the app goes. Whatever the
     * outcome, the caller `forget`s or `confirm`s the tab.
     */
    request(
      tab: Omit<PreviewDesktopTab, "attached">,
      timeoutMs = DESKTOP_ATTACH_TIMEOUT_MS,
    ): Promise<string | null> {
      if (hosts === 0) return Promise.resolve(null);
      const key = keyOf(tab.threadId, tab.tabId);
      // A tab asked for again: the earlier wait gives up first.
      entries.get(key)?.settle?.(null);
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(null), timeoutMs);
        const settle = (endpoint: string | null) => {
          clearTimeout(timer);
          const entry = entries.get(key);
          // Settled once: later attaches find the tab no longer waiting.
          if (entry?.settle === settle) entries.set(key, { tab: entry.tab });
          resolve(endpoint);
        };
        entries.set(key, { tab: { ...tab, attached: false }, settle });
        publish();
      });
    },

    /** The app's webview of a tab is ready at `endpoint` (`preview.desktop.attach`). */
    attach(input: { threadId: string; tabId: string; endpoint: string }): void {
      const entry = entries.get(keyOf(input.threadId, input.tabId));
      if (entry?.settle === undefined) {
        throw new PreviewError(
          "PREVIEW_TAB_NOT_FOUND",
          `No tab ${input.tabId} is waiting for the desktop app.`,
        );
      }
      entry.settle(input.endpoint);
    },

    /** The node connected to the tab's webview: the app keeps it. */
    confirm(threadId: string, tabId: string): void {
      const key = keyOf(threadId, tabId);
      const entry = entries.get(key);
      if (entry === undefined) return;
      entries.set(key, { tab: { ...entry.tab, attached: true } });
      publish();
    },

    /** The tab is gone, or it opens elsewhere: the app drops its webview. */
    forget(threadId: string, tabId: string): void {
      const key = keyOf(threadId, tabId);
      const entry = entries.get(key);
      if (entry === undefined) return;
      entries.delete(key);
      entry.settle?.(null);
      publish();
    },

    dispose(): void {
      for (const entry of entries.values()) entry.settle?.(null);
      entries.clear();
      streams.delete(PREVIEW_DESKTOP_STREAM);
    },
  };
}

export type DesktopHost = ReturnType<typeof createDesktopHost>;
