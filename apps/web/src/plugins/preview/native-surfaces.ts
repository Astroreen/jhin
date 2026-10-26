// Placing a tab's webview where a surface shows it follows T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): apps/web/src/browser/browserSurfaceStore.ts and
// hostedBrowserWebviewStyle.ts.
import type { RpcClient } from "@jhin/rpc";
import { toDisposable, type Disposable } from "@jhin/sdk";

/** Where a surface shows a desktop tab's page, in the window's CSS pixels (D1324). */
export interface NativePlacement {
  readonly left: number;
  readonly top: number;
  /** The page's own size: the webview's, before `scale`. */
  readonly width: number;
  readonly height: number;
  /** Below 1 when a preset is shrunk to fit (T3's `viewportScale`). */
  readonly scale: number;
  readonly zoomFactor: number;
  /** The agent holds the tab and this viewer does not: the page takes no input. */
  readonly blocked: boolean;
  readonly zIndex: number;
}

const keyOf = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;

/**
 * The desktop tabs the app's page hosts (D1324): which node's tabs it hosts,
 * and where each surface shows one. One per page, shared by the panel, the
 * mini player and the host.
 */
export function createNativeSurfaces() {
  let hostClient: RpcClient | undefined;
  /** Per tab, every surface's placement in the order they came; the newest surface wins. */
  const placements = new Map<string, Map<symbol, NativePlacement>>();
  /** Each hosted tab's guest, for its DevTools (D1489). */
  const guests = new Map<string, number>();
  let devTools: ((webContentsId: number) => Promise<void>) | undefined;
  const listeners = new Set<() => void>();
  let version = 0;
  const changed = () => {
    version += 1;
    for (const listener of Array.from(listeners)) listener();
  };

  return {
    /** The client of the node whose tabs this page hosts, while it hosts them. */
    host(client: RpcClient): Disposable {
      hostClient = client;
      changed();
      return toDisposable(() => {
        if (hostClient !== client) return;
        hostClient = undefined;
        changed();
      });
    },
    /** Whether `client`'s desktop tabs are shown by this page's webviews. */
    hosts(client: RpcClient): boolean {
      return hostClient === client;
    },
    /** A surface shows the tab here, until disposed or placed again. */
    place(threadId: string, tabId: string, owner: symbol, placement: NativePlacement | null) {
      const key = keyOf(threadId, tabId);
      const forTab = placements.get(key) ?? new Map<symbol, NativePlacement>();
      const previous = forTab.get(owner);
      if (placement === null) {
        if (previous === undefined) return;
        forTab.delete(owner);
      } else {
        if (
          previous !== undefined &&
          (Object.keys(placement) as (keyof NativePlacement)[]).every(
            (field) => previous[field] === placement[field],
          )
        ) {
          return;
        }
        // A Map keeps its first order: the surface that came last is the one shown.
        forTab.set(owner, placement);
      }
      if (forTab.size === 0) placements.delete(key);
      else placements.set(key, forTab);
      changed();
    },
    /** Where the tab's page shows now, if any surface shows it. */
    placement(threadId: string, tabId: string): NativePlacement | undefined {
      const forTab = placements.get(keyOf(threadId, tabId));
      return forTab === undefined ? undefined : [...forTab.values()].at(-1);
    },
    /** The host's tab has this guest now (undefined: none). */
    guest(threadId: string, tabId: string, webContentsId: number | undefined) {
      const key = keyOf(threadId, tabId);
      if (guests.get(key) === webContentsId) return;
      if (webContentsId === undefined) guests.delete(key);
      else guests.set(key, webContentsId);
      changed();
    },
    /** The app's DevTools of a guest, while the host has them (D1489). */
    devTools(open: ((webContentsId: number) => Promise<void>) | undefined): Disposable {
      devTools = open;
      changed();
      return toDisposable(() => {
        if (devTools !== open) return;
        devTools = undefined;
        changed();
      });
    },
    /** Whether "Open DevTools" can open the tab's (D1489). */
    canOpenDevTools(threadId: string, tabId: string): boolean {
      return devTools !== undefined && guests.has(keyOf(threadId, tabId));
    },
    openDevTools(threadId: string, tabId: string): Promise<void> {
      const id = guests.get(keyOf(threadId, tabId));
      if (devTools === undefined || id === undefined) {
        return Promise.reject(new Error("This tab's page is not shown in the app."));
      }
      return devTools(id);
    },
    version: () => version,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type NativeSurfaces = ReturnType<typeof createNativeSurfaces>;
