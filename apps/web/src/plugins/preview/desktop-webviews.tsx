// The app's webviews follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/browser/ElectronBrowserHost.tsx (one webview per tab of the app's own
// environment, mounted for the tab's life, links opened as tabs),
// HostedBrowserWebview.tsx (registering the guest, `allowpopups`, the scaled preset)
// and hostedBrowserWebviewStyle.ts (a hidden guest parked outside the window).
import type { Connections, NodeConnection } from "@jhin/client-api";
import type { DesktopShell } from "@jhin/desktop-api";
import {
  PREVIEW_DESKTOP_STREAM,
  PreviewDesktopTab,
  PreviewEvents,
  previewFramesStream,
  type PreviewDesktopTab as DesktopTab,
} from "@jhin/preview-api";
import type { RpcClient } from "@jhin/rpc";
import { z } from "@jhin/sdk";
import { MousePointer2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useExternal } from "../../lib/hooks.ts";
import type { NativeSurfaces } from "./native-surfaces.ts";

/** T3's `HIDDEN_BROWSER_WEBVIEW_OFFSET`: a tab nobody shows waits outside the window. */
const HIDDEN_OFFSET = -100_000;
const HIDDEN_SIZE = { width: 1280, height: 800 };

interface ElectronWebview extends HTMLElement {
  getWebContentsId(): number;
  setZoomFactor(factor: number): void;
}

/** The connection to the node this page was loaded from: the app's own node (D1321). */
function ownConnection(connections: Connections): NodeConnection | undefined {
  return connections.list().find((connection) => {
    if (!URL.canParse(connection.url)) return false;
    const url = new URL(connection.url);
    const origin = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
    return origin === location.origin;
  });
}

const desktopKey = (tab: DesktopTab) => `${tab.threadId}\u0000${tab.tabId}`;

const DesktopTabs = z.object({ tabs: z.array(PreviewDesktopTab) });

/** The tabs the node asks this page to host, from `preview-desktop`. */
function useDesktopTabs(client: RpcClient): readonly DesktopTab[] {
  const [tabs, setTabs] = useState<readonly DesktopTab[]>([]);
  useEffect(() => {
    setTabs([]);
    const subscription = client.subscribe(
      PREVIEW_DESKTOP_STREAM,
      // A node without the stream, or a token without `preview.control`: nothing to host. A
      // dropped connection is no error: the client subscribes again once it reconnects.
      { after: 0, onError: () => setTabs([]) },
      (event) => {
        if (event.type !== PreviewEvents.desktopTabs) return;
        const parsed = DesktopTabs.safeParse(event.payload);
        if (parsed.success) setTabs(parsed.data.tabs);
      },
    );
    return () => subscription.dispose();
  }, [client]);
  return tabs;
}

export interface DesktopWebviewsProps {
  readonly connections: Connections;
  readonly shell: () => DesktopShell | undefined;
  readonly surfaces: NativeSurfaces;
  readonly onError: (title: string, error: unknown) => void;
}

/**
 * `jhin.preview.desktop-host`: in the desktop app, one webview per tab of the
 * app's own node, laid over the surface that shows it (D1324).
 */
export function DesktopWebviews(props: DesktopWebviewsProps) {
  const preview = props.shell()?.preview;
  // Kept while the connection reconnects, so a dropped connection does not unmount the
  // webviews (and end the node's tabs with their relays).
  const connection = useExternal(props.connections, () => {
    const own = ownConnection(props.connections);
    return own === undefined || own.state === "closed" ? undefined : own.client;
  });
  if (preview === undefined || connection === undefined) return null;
  return <Host client={connection} preview={preview} {...props} />;
}

function Host(
  props: DesktopWebviewsProps & {
    readonly client: RpcClient;
    readonly preview: NonNullable<DesktopShell["preview"]>;
  },
) {
  const { client, preview, surfaces } = props;
  const announced = useDesktopTabs(client);
  // A tab another page (or this page before a reload) attached has its webview there: this
  // page hosts the tabs it was asked for while they waited, and keeps them.
  // Derived from each announcement while rendering (React's "state from the previous
  // render"), and pruned of the tabs no longer announced.
  const [mine, setMine] = useState<{ from: readonly DesktopTab[] | null; keys: Set<string> }>({
    from: null,
    keys: new Set(),
  });
  if (mine.from !== announced) {
    const keys = new Set(
      announced.filter((tab) => !tab.attached || mine.keys.has(desktopKey(tab))).map(desktopKey),
    );
    setMine({ from: announced, keys });
  }
  const tabs = announced.filter((tab) => mine.keys.has(desktopKey(tab)));
  /** The node no longer waits for this page's webview of a tab: it goes, with its relay. */
  const lose = useCallback((key: string) => {
    setMine((current) => {
      if (!current.keys.has(key)) return current;
      const keys = new Set(current.keys);
      keys.delete(key);
      return { from: current.from, keys };
    });
  }, []);
  useEffect(() => {
    const hosting = surfaces.host(client);
    return () => hosting.dispose();
  }, [client, surfaces]);
  // Webviews by their guest's id, for the links their pages open.
  const guests = useRef(new Map<number, DesktopTab>());
  const onError = useRef(props.onError);
  onError.current = props.onError;
  useEffect(() => {
    const links = preview.onOpenLink(({ webContentsId, url }) => {
      const source = guests.current.get(webContentsId);
      if (source === undefined) return;
      void client
        .call("preview.tab.open", {
          threadId: source.threadId,
          url,
          ...(source.profileId === undefined ? {} : { profileId: source.profileId }),
        })
        .catch((error: unknown) => onError.current("Unable to open the link", error));
    });
    return () => links.dispose();
  }, [client, preview]);
  return (
    <div className="contents" data-desktop-webviews="">
      {tabs.map((tab) => (
        <HostedWebview
          client={client}
          guests={guests.current}
          onError={onError}
          key={desktopKey(tab)}
          onLost={lose}
          preview={preview}
          surfaces={surfaces}
          tab={tab}
        />
      ))}
    </div>
  );
}

function HostedWebview(props: {
  readonly client: RpcClient;
  readonly preview: NonNullable<DesktopShell["preview"]>;
  readonly surfaces: NativeSurfaces;
  readonly tab: DesktopTab;
  readonly guests: Map<number, DesktopTab>;
  readonly onError: { current: (title: string, error: unknown) => void };
  readonly onLost: (key: string) => void;
}) {
  const { client, preview, surfaces, tab, guests, onError, onLost } = props;
  const ref = useRef<ElectronWebview | null>(null);
  // Fixed for the tab's life: Electron reads the partition once, as the guest attaches.
  const [partition] = useState(tab.partition);
  const attachedOnce = useRef(tab.attached);
  useSyncExternalStore(surfaces.subscribe, surfaces.version);
  const placement = surfaces.placement(tab.threadId, tab.tabId);
  const last = useRef(HIDDEN_SIZE);
  if (placement !== undefined) last.current = { width: placement.width, height: placement.height };

  useEffect(() => {
    const webview = ref.current;
    if (webview === null) return;
    let disposed = false;
    let guestId: number | undefined;
    const register = () => {
      if (disposed || attachedOnce.current) return;
      // Electron answers the guest's id only once its first document is ready.
      let id: number;
      try {
        id = webview.getWebContentsId();
      } catch {
        return;
      }
      attachedOnce.current = true;
      guestId = id;
      guests.set(id, tab);
      void (async () => {
        const { endpoint } = await preview.attachWebview(id);
        if (disposed) return;
        await client.call("preview.desktop.attach", {
          threadId: tab.threadId,
          tabId: tab.tabId,
          endpoint,
        });
      })().catch((error: unknown) => {
        // The next document of the webview tries again; until the node's deadline it waits,
        // then opens the tab headless.
        if (disposed) return;
        attachedOnce.current = false;
        // The node no longer waits: another page attached the tab first, or it opened headless.
        // This webview goes, and its guest's relay with it, at once.
        if ((error as { code?: unknown }).code === "PREVIEW_TAB_NOT_FOUND") {
          onLost(desktopKey(tab));
          return;
        }
        onError.current("Couldn't show the browser tab in the app", error);
      });
    };
    webview.addEventListener("did-attach", register);
    webview.addEventListener("dom-ready", register);
    return () => {
      disposed = true;
      webview.removeEventListener("did-attach", register);
      webview.removeEventListener("dom-ready", register);
      if (guestId !== undefined) guests.delete(guestId);
    };
    // The tab is the same for the webview's life (its key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zoomFactor = placement?.zoomFactor ?? 1;
  useEffect(() => {
    try {
      ref.current?.setZoomFactor(zoomFactor);
    } catch {
      // Not attached yet: the next placement sets it.
    }
  }, [zoomFactor, tab.attached]);

  // A shown tab is watched: its stream brings the agent's cursor (D1324).
  const shown = placement !== undefined;
  const [agentPointer, setAgentPointer] = useState<
    { x: number; y: number; click: boolean } | undefined
  >();
  const [cursorFresh, setCursorFresh] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const subscription = client.subscribe(
      previewFramesStream(tab.threadId, tab.tabId),
      { after: 0 },
      (event) => {
        if (event.type !== PreviewEvents.pointer) return;
        const pointer = event.payload as { x: number; y: number; phase: string };
        setAgentPointer({ x: pointer.x, y: pointer.y, click: pointer.phase === "click" });
      },
    );
    return () => subscription.dispose();
  }, [client, shown, tab.threadId, tab.tabId]);
  // Bright for 700 ms after it moves, then faded (T3's).
  useEffect(() => {
    if (agentPointer === undefined) return;
    setCursorFresh(true);
    const timer = setTimeout(() => setCursorFresh(false), 700);
    return () => clearTimeout(timer);
  }, [agentPointer]);

  const size = last.current;
  const webview = (
    <webview
      {...({ allowpopups: "true" } as object)}
      aria-hidden={placement === undefined ? true : undefined}
      className="bg-white"
      data-preview-desktop-tab={tab.tabId}
      partition={partition}
      ref={(node: HTMLElement | null) => {
        ref.current = node as ElectronWebview | null;
      }}
      src="about:blank"
      style={
        placement === undefined
          ? {
              position: "fixed",
              left: HIDDEN_OFFSET,
              top: HIDDEN_OFFSET,
              width: size.width,
              height: size.height,
              pointerEvents: "none",
            }
          : {
              position: "fixed",
              left: placement.left,
              top: placement.top,
              width: placement.width,
              height: placement.height,
              zIndex: placement.zIndex,
              transform: placement.scale < 1 ? `scale(${placement.scale})` : undefined,
              transformOrigin: "top left",
              pointerEvents: placement.blocked ? "none" : "auto",
            }
      }
    />
  );
  if (placement === undefined || agentPointer === undefined) return webview;
  return (
    <>
      {webview}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none"
        data-agent-cursor=""
        style={{
          zIndex: placement.zIndex + 1,
          opacity: cursorFresh ? 1 : placement.blocked ? 0.35 : 0.18,
          transform: `translate3d(${placement.left + agentPointer.x * placement.zoomFactor * placement.scale}px, ${
            placement.top + agentPointer.y * placement.zoomFactor * placement.scale
          }px, 0)`,
        }}
      >
        {agentPointer.click && cursorFresh ? (
          <span className="absolute left-0.5 top-0.5 size-4 animate-status-ping rounded-full bg-primary/25" />
        ) : null}
        <MousePointer2Icon className="relative size-5 -translate-x-0.5 -translate-y-0.5 fill-background text-primary drop-shadow-sm" />
      </div>
    </>
  );
}
