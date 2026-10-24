// The toggle, the commands and their shortcuts follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/PanelLayoutControls.tsx (the header's right panel toggle),
// packages/shared/src/keybindings.ts (preview.toggle, preview.refresh, preview.focusUrl),
// apps/web/src/lib/previewFocus.ts and components/preview/useAgentOpenedPreviews.ts.
import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  RIGHT_PANEL_CAPABILITY,
  SETTINGS_CAPABILITY,
  THREADS_CAPABILITY,
  rightPanelSurfaceId,
  targetKey,
  type ChatHeaderActionProps,
  type ChatThreadOverlayProps,
  type Connections,
  type DeviceSettings,
  type Keybindings,
  type Navigation,
  type NodeTarget,
  type RightPanel,
  type RightPanelPlace,
  type RightPanelSurfaceProps,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { DESKTOP_SHELL_CAPABILITY, type DesktopShell } from "@jhin/desktop-api";
import { previewProfilePartition, type PreviewTab } from "@jhin/preview-api";
import type { RpcClient } from "@jhin/rpc";
import { definePlugin, z, type Disposable } from "@jhin/sdk";
import {
  Toggle,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  UI_DIALOGS_CAPABILITY,
  UI_SETTINGS_CAPABILITY,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type Dialogs,
  type SettingsPages,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import { Globe2Icon, PanelRightIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { builtin } from "../../lib/builtin.ts";
import { useExternal, useShortcutLabels } from "../../lib/hooks.ts";
import { createTabFeeds } from "./feed.ts";
import { readSection, useSection } from "../../lib/settings.ts";
import {
  BrowserProfilesSection,
  PREVIEW_BROWSER_SECTION,
  PreviewBrowserSettings,
  resolveBrowserProfiles,
  type ProfilesServices,
} from "./profiles.tsx";
import { ChunkFailed, lazyChunk } from "../../lib/lazy-chunk.tsx";
import type { BrowserPanelProps, BrowserSurfaceViewProps, PanelServices } from "./panel.tsx";
import { NEW_TAB, tabTitle } from "./tab-title.ts";
import type { MiniPlayerProps } from "./mini-player.tsx";
import { createMiniPlayers, type MiniPlayerState } from "./mini-player-store.ts";
import { DesktopWebviews } from "./desktop-webviews.tsx";
import { createNativeSurfaces } from "./native-surfaces.ts";
import {
  createPictureInPicture,
  pictureInPictureKey,
  supportsPictureInPicture,
} from "./picture-in-picture.ts";

/**
 * Base64 decoded a megabyte at a time (D1331): no `data:` URL for the page's CSP to refuse, and
 * no second copy of the whole file as a binary string.
 */
function decodeBase64(data: string): Uint8Array<ArrayBuffer>[] {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  // A multiple of 4 characters decodes on its own.
  const step = 4 * 256 * 1024;
  for (let start = 0; start < data.length; start += step) {
    const binary = atob(data.slice(start, start + step));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    chunks.push(bytes);
  }
  return chunks;
}

/** Saved files whose object URLs are kept for the browser to read (D1331). */
const SAVED_URLS_KEPT = 4;

/** A placeholder of the panel's size while its chunk loads or the node connects. */
function PanelPlaceholder(props: { children?: ReactNode }) {
  return (
    <aside
      aria-label="Right panel"
      className="flex h-full w-[540px] max-w-[70vw] shrink-0 flex-col border-l border-border bg-background"
    >
      {props.children}
    </aside>
  );
}

// A chunk of its own, loaded when the panel first opens (D440).
const BrowserPanel = lazyChunk<BrowserPanelProps>(
  () => import("./panel.tsx").then((module) => module.BrowserPanel),
  {
    loading: () => <PanelPlaceholder />,
    failed: (_props, retry) => (
      <PanelPlaceholder>
        <ChunkFailed retry={retry}>Couldn't load the browser.</ChunkFailed>
      </PanelPlaceholder>
    ),
  },
);

// A browser surface of the right panel: the same chunk (D440).
const BrowserSurfaceView = lazyChunk<BrowserSurfaceViewProps>(
  () => import("./panel.tsx").then((module) => module.BrowserSurfaceView),
  {
    loading: () => null,
    failed: (_props, retry) => <ChunkFailed retry={retry}>Couldn't load the browser.</ChunkFailed>,
  },
);

// T3's floating preview, a chunk of its own too: loaded when a tab first floats (D1202).
const MiniPlayer = lazyChunk<MiniPlayerProps>(
  () => import("./mini-player.tsx").then((module) => module.MiniPlayer),
  { loading: () => null, failed: () => null },
);

/** The route's `panel` while the right panel shows the browser. */
const BROWSER_PANEL = "browser";

/** Focus is in the right panel (T3's `previewFocus`). */
function isPreviewFocused(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.closest("[data-preview-panel-mode]") !== null;
}

/**
 * `jhin.preview-panel`: T3's right panel with the node's browser tabs
 * (docs/plans/preview.md, D403). The panel is the `app.panel` slot's
 * `jhin.preview.panel`; its toggle is the chat header's `jhin.preview.toggle`.
 */
export const previewPanelPlugin = builtin(
  "jhin.preview-panel",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
    },
    optional: {
      [SETTINGS_CAPABILITY]: "^1",
      [KEYBINDINGS_CAPABILITY]: "^1",
      [UI_TOASTS_CAPABILITY]: "^1",
      [UI_DIALOGS_CAPABILITY]: "^1",
      [UI_SETTINGS_CAPABILITY]: "^1",
      // The desktop app's webviews (D1324).
      [DESKTOP_SHELL_CAPABILITY]: "^1.1",
      // Each browser tab as a surface of the right panel (t3-parity.md D1424).
      [RIGHT_PANEL_CAPABILITY]: "^1",
    },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      const rightPanel = context.services.tryGet<RightPanel>(RIGHT_PANEL_CAPABILITY);
      const feeds = context.subscriptions.add(createTabFeeds(connections));
      const desktopShell = () => context.services.tryGet<DesktopShell>(DESKTOP_SHELL_CAPABILITY);
      // Where the panel and the mini player show the desktop app's webviews (D1324).
      const surfaces = createNativeSurfaces();
      // The one tab popped out into the browser's picture-in-picture window (D1327).
      const pictureInPicture = createPictureInPicture();
      context.subscriptions.add({ dispose: () => pictureInPicture.dispose() });
      // T3's browser profiles, kept on this device (D953).
      context.config.define(PREVIEW_BROWSER_SECTION, PreviewBrowserSettings);
      const deviceSettings = context.services.tryGet<DeviceSettings>(SETTINGS_CAPABILITY);
      const profiles: ProfilesServices = {
        settings: deviceSettings,
        connections,
        dialogs: context.services.tryGet<Dialogs>(UI_DIALOGS_CAPABILITY),
        toasts: context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY),
        read: () => readSection(context, PREVIEW_BROWSER_SECTION, PreviewBrowserSettings),
        // A profile removed also leaves the app's partition (D1323).
        clearInApp: async (profileId) =>
          desktopShell()?.preview?.clearPartition(previewProfilePartition(profileId)),
        use: () => useSection(context, PREVIEW_BROWSER_SECTION, PreviewBrowserSettings),
      };
      const pages = context.services.tryGet<SettingsPages>(UI_SETTINGS_CAPABILITY);
      if (pages !== undefined && deviceSettings !== undefined) {
        context.subscriptions.add(
          pages.addSection({
            id: "browser",
            label: "Browser",
            icon: Globe2Icon,
            order: 50,
            component: () => <BrowserProfilesSection services={profiles} />,
          }),
        );
      }
      /** This client's name as a viewer of tabs. */
      // Kept for the browser tab's session, so a reload is the same viewer and may let go of
      // the control it held (the node releases it too once nobody watches).
      const viewer = (() => {
        const key = "jhin:preview-viewer";
        try {
          const known = sessionStorage.getItem(key);
          if (known !== null) return known;
          const created = `viewer-${crypto.randomUUID()}`;
          sessionStorage.setItem(key, created);
          return created;
        } catch {
          return `viewer-${crypto.randomUUID()}`;
        }
      })();

      // The tab shown per thread, and its listeners.
      // Kept in the plugin's state, so a reload of the plugin keeps the tab shown per thread.
      const active = context.state.get<Map<string, string>>("active") ?? new Map<string, string>();
      context.state.set("active", active);
      const activeListeners = new Set<() => void>();
      const activeStore = {
        subscribe(listener: () => void): Disposable {
          activeListeners.add(listener);
          return { dispose: () => activeListeners.delete(listener) };
        },
      };
      const setActiveTab = (key: string, tabId: string | undefined) => {
        if (tabId === undefined) active.delete(key);
        else active.set(key, tabId);
        for (const listener of Array.from(activeListeners)) listener();
      };

      // The tab that floats over each thread's chat (T3's mini player, D1202); kept across a
      // reload of the plugin, in memory only, as T3 keeps it.
      const floatingByThread =
        context.state.get<Map<string, MiniPlayerState>>("floating") ??
        new Map<string, MiniPlayerState>();
      context.state.set("floating", floatingByThread);
      const players = createMiniPlayers(floatingByThread);
      /** The thread on screen, keyed as the panel keys it, when its browser is reachable. */
      const threadOnScreen = () => {
        const route = navigation.current();
        if (route.node === undefined || route.thread === undefined || route.remote !== undefined)
          return undefined;
        return {
          route,
          key: `${targetKey({ node: route.node })}|${route.thread}`,
          feed: feeds.of(route.node, route.thread),
        };
      };
      /** The tab the right panel shows for a thread. */
      const shownTab = (key: string, tabs: readonly PreviewTab[]) => {
        const chosen = active.get(key);
        return (tabs.find((tab) => tab.tabId === chosen) ?? tabs.at(-1))?.tabId;
      };
      /**
       * Whether the right panel shows this tab, which then does not float as well (T3's
       * `shouldRenderPreviewMiniPlayer`): one rule for the player and `preview.pop-out`.
       */
      const panelShows = (
        route: ReturnType<Navigation["current"]>,
        key: string,
        tabs: readonly PreviewTab[],
        tabId: string,
      ) =>
        route.panel === BROWSER_PANEL &&
        // Beside the right panel the route names the tab it shows (t3-parity.md D1424).
        (rightPanel === undefined ? shownTab(key, tabs) : route.section) === tabId;
      /** The route without the right panel (and the section it showed). */
      const withoutPanel = (route: ReturnType<Navigation["current"]>) => {
        const { panel: _panel, section: _section, ...rest } = route;
        return rest;
      };
      const closePanel = () => {
        const route = navigation.current();
        if (route.panel === BROWSER_PANEL) navigation.navigate(withoutPanel(route));
      };
      /** Feeds followed while their thread has a floating tab, so a tab closed off screen goes too. */
      const following = new Map<string, Disposable>();
      context.subscriptions.add({
        dispose: () => {
          for (const subscription of following.values()) subscription.dispose();
          following.clear();
        },
      });
      const follow = (key: string, node: string, threadId: string) => {
        if (following.has(key)) return;
        const feed = feeds.of(node, threadId);
        const check = () => {
          const state = players.get(key);
          if (state === undefined) {
            following.get(key)?.dispose();
            following.delete(key);
          } else if (feed.loaded() && !feed.tabs().some((tab) => tab.tabId === state.tabId)) {
            // The floating tab closed, on screen or not (T3's ChatView closes the player).
            players.close(key);
          }
        };
        const onFeed = feed.subscribe(check);
        const onPlayers = players.subscribe(check);
        following.set(key, {
          dispose: () => {
            onFeed.dispose();
            onPlayers.dispose();
          },
        });
      };
      /** Floats a tab of the thread on screen (by its key) and follows its feed. */
      const floatTab = (key: string, tabId: string) => {
        players.open(key, tabId);
        const [node, threadId] = [
          key.slice(0, key.lastIndexOf("|")),
          key.slice(key.lastIndexOf("|") + 1),
        ];
        const route = navigation.current();
        if (route.node !== undefined && targetKey({ node: route.node }) === node) {
          follow(key, route.node, threadId);
        }
      };
      /** T3's "Float preview over chat": the tab floats and the right panel closes. */
      const float = (key: string, tabId: string) => {
        floatTab(key, tabId);
        closePanel();
      };

      const focusListeners = new Set<() => void>();
      const focusUrlRequests = {
        current: 0,
        subscribe(listener: () => void) {
          focusListeners.add(listener);
          return () => {
            focusListeners.delete(listener);
          };
        },
      };
      const refreshListeners = new Set<() => void>();

      const onError = (title: string, error: unknown) =>
        toasts?.show({
          type: "error",
          title,
          description: error instanceof Error ? error.message : String(error),
        });

      // The saved files' URLs, newest last. The browser reads one whenever it starts the
      // download, so a URL lives until a few later saves (or the plugin goes), not one.
      const savedUrls: string[] = [];
      context.subscriptions.add({
        dispose: () => {
          for (const url of savedUrls.splice(0)) URL.revokeObjectURL(url);
        },
      });
      /** T3's download toast: "Downloaded <file>", and Save fetches it from the node (D1331). */
      const offerDownload = (
        client: RpcClient,
        tab: { threadId: string; tabId: string },
        download: { id: string; fileName: string },
      ) => {
        // One Save at a time: a second click while the file comes adds no second download.
        let saving = false;
        const id = toasts?.show({
          type: "info",
          title: `Downloaded ${download.fileName}`,
          action: {
            label: "Save",
            onClick: () => {
              if (saving) return;
              saving = true;
              void client
                .call<{ fileName: string; data: string }>("preview.tab.download", {
                  ...tab,
                  id: download.id,
                })
                .then(async ({ fileName, data }) => {
                  const blob = new Blob(decodeBase64(data), {
                    type: "application/octet-stream",
                  });
                  const url = URL.createObjectURL(blob);
                  savedUrls.push(url);
                  if (savedUrls.length > SAVED_URLS_KEPT) URL.revokeObjectURL(savedUrls.shift()!);
                  const anchor = document.createElement("a");
                  anchor.href = url;
                  anchor.download = fileName;
                  anchor.hidden = true;
                  document.body.append(anchor);
                  anchor.click();
                  anchor.remove();
                  // Saved: the offer is done. A failed Save keeps it, so Save can be tried again.
                  if (id !== undefined) toasts?.close(id);
                })
                .catch((error: unknown) => onError("Couldn't save the download", error))
                .finally(() => {
                  saving = false;
                });
            },
          },
        });
      };

      /** Opens or closes the right panel of the thread on screen. */
      /** Opens or closes the right panel; closing it floats the tab it showed (its id). */
      const toggle = (): { toggled: boolean; floated: string | null } => {
        const route = navigation.current();
        if (route.node === undefined || route.thread === undefined)
          return { toggled: false, floated: null };
        if (route.remote !== undefined) {
          toasts?.show({
            type: "info",
            title: "Browser unavailable",
            description:
              "The browser opens on nodes this client connects to; this thread is on another node of the mesh.",
          });
          return { toggled: false, floated: null };
        }
        if (route.panel !== BROWSER_PANEL) {
          // T3's togglePreviewPanel: the tab shown last, else a new tab.
          const key = `${targetKey({ node: route.node })}|${route.thread}`;
          const tabId = shownTab(key, feeds.of(route.node, route.thread).tabs());
          navigation.navigate({
            ...withoutPanel(route),
            panel: BROWSER_PANEL,
            ...(rightPanel === undefined ? {} : { section: tabId ?? NEW_TAB }),
          });
          return { toggled: true, floated: null };
        }
        // Closing the panel floats the tab it showed, as T3's closePreviewPanel does (D1202).
        const shown = threadOnScreen();
        const tabId = shown === undefined ? undefined : shownTab(shown.key, shown.feed.tabs());
        if (shown !== undefined && tabId !== undefined) floatTab(shown.key, tabId);
        navigation.navigate(withoutPanel(route));
        return { toggled: true, floated: tabId ?? null };
      };

      context.commands.register({
        name: "preview.toggle",
        title: "Toggle browser preview",
        description:
          "Opens or closes the right panel with the thread's browser tabs; closing it floats the tab it showed over the chat, as T3 does",
        input: z.object({}),
        output: z.object({
          toggled: z.boolean(),
          /** The tab that closing the panel floated over the chat (D1202). */
          floated: z.string().nullable(),
        }),
        handler: () => toggle(),
      });
      context.commands.register({
        name: "preview.float",
        title: "Float preview over chat",
        description:
          "Floats a browser tab of the thread on screen over its chat and closes the right panel",
        input: z.object({
          /** The tab to float; the one the right panel shows when left out. */
          tabId: z.string().min(1).optional(),
        }),
        output: z.object({ tabId: z.string().nullable() }),
        handler: ({ tabId }) => {
          const shown = threadOnScreen();
          if (shown === undefined) return { tabId: null };
          const tabs = shown.feed.tabs();
          const floated =
            tabId === undefined
              ? shownTab(shown.key, tabs)
              : tabs.find((tab) => tab.tabId === tabId)?.tabId;
          if (floated === undefined) return { tabId: null };
          float(shown.key, floated);
          return { tabId: floated };
        },
      });
      context.commands.register({
        name: "preview.float.close",
        title: "Close floating preview",
        description: "Closes the browser tab that floats over the chat of the thread on screen",
        input: z.object({}),
        output: z.object({ closed: z.boolean() }),
        handler: () => {
          const shown = threadOnScreen();
          if (shown === undefined || players.get(shown.key) === undefined) return { closed: false };
          players.close(shown.key);
          return { closed: true };
        },
      });
      // T3's "Pop into separate window" as commands too (D1327): the browser opens the window
      // only during a user's gesture, so they work from the palette or a keybinding, not RPC.
      /** What the thread on screen floats, or why nothing can pop out. */
      const floatingOnScreen = () => {
        const shown = threadOnScreen();
        const state = shown === undefined ? undefined : players.get(shown.key);
        if (shown === undefined || state === undefined) return "nothing-floats" as const;
        const connection = connections.get(shown.route.node!);
        if (connection === undefined) return "nothing-floats" as const;
        // As the player's button: a tab the app hosts in a webview has no frames to float
        // (Deferred), and a browser without picture-in-picture has no window.
        // The right panel shows this tab: nothing floats (T3's shouldRenderPreviewMiniPlayer).
        const tabs = shown.feed.tabs();
        if (panelShows(shown.route, shown.key, tabs, state.tabId)) return "in-panel" as const;
        const tab = tabs.find((each) => each.tabId === state.tabId);
        if (tab?.desktop === true && surfaces.hosts(connection.client)) return "app-tab" as const;
        if (!supportsPictureInPicture()) return "unsupported" as const;
        return { shown, state, client: connection.client };
      };
      context.commands.register({
        name: "preview.pop-out",
        title: "Pop into separate window",
        description:
          "Pops the browser tab that floats over the chat of the thread on screen into the browser's picture-in-picture window; needs a user's gesture (the palette, a keybinding)",
        input: z.object({}),
        output: z.object({
          poppedOut: z.boolean(),
          /**
           * Why nothing popped out: no user's gesture to open a window with (RPC, the CLI,
           * MCP), no player floats on screen, the right panel shows its tab, the app hosts the
           * tab in a webview, the browser has no picture-in-picture, or it closed while it
           * opened (`superseded`: the user closed it, another open replaced it, or its tab went).
           */
          reason: z
            .enum([
              "needs-gesture",
              "nothing-floats",
              "in-panel",
              "app-tab",
              "unsupported",
              "superseded",
            ])
            .optional(),
        }),
        handler: async () => {
          // Only a user's gesture opens the window: over RPC, the CLI or MCP it says so, as an
          // answer rather than the browser's own error.
          if (navigator.userActivation?.isActive === false) {
            return { poppedOut: false, reason: "needs-gesture" as const };
          }
          const floating = floatingOnScreen();
          if (typeof floating === "string") return { poppedOut: false, reason: floating };
          const { shown, state, client } = floating;
          const threadId = shown.route.thread!;
          await pictureInPicture.open({
            client,
            threadId,
            tabId: state.tabId,
            seed: document.querySelector<HTMLCanvasElement>(
              `[data-preview-mini-player="${CSS.escape(state.tabId)}"] [data-preview-canvas]`,
            ),
            tabs: shown.feed,
            onStreamError: (error) => onError("Unable to pop out preview", error),
          });
          const poppedOut = pictureInPicture.key() === pictureInPictureKey(threadId, state.tabId);
          return poppedOut ? { poppedOut } : { poppedOut, reason: "superseded" as const };
        },
      });
      context.commands.register({
        name: "preview.pop-out.close",
        title: "Close separate window",
        description: "Closes the browser's picture-in-picture window of a preview tab",
        input: z.object({}),
        output: z.object({ closed: z.boolean() }),
        handler: () => {
          const open = pictureInPicture.key() !== null;
          pictureInPicture.close();
          return { closed: open };
        },
      });
      context.commands.register({
        name: "preview.refresh",
        title: "Refresh browser preview",
        description: "Reloads the browser tab on screen",
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          for (const listener of Array.from(refreshListeners)) listener();
          return {};
        },
      });
      context.commands.register({
        name: "preview.focus.url",
        title: "Focus the address bar",
        description: "Moves the focus to the browser's address bar",
        input: z.object({}),
        output: z.object({}),
        handler: () => {
          focusUrlRequests.current += 1;
          for (const listener of Array.from(focusListeners)) listener();
          return {};
        },
      });
      if (keybindings !== undefined) {
        context.subscriptions.add(
          keybindings.addDefaults([
            { key: "mod+shift+j", command: "preview.toggle" },
            { key: "mod+r", command: "preview.refresh", when: "previewFocus" },
            { key: "mod+l", command: "preview.focus.url", when: "previewFocus" },
          ]),
        );
        let focused: Disposable | undefined;
        const sync = () => {
          const now = isPreviewFocused();
          if (now && focused === undefined) focused = keybindings.setContext("previewFocus", true);
          else if (!now && focused !== undefined) {
            focused.dispose();
            focused = undefined;
          }
        };
        window.addEventListener("focusin", sync, true);
        window.addEventListener("focusout", sync, true);
        context.subscriptions.add({
          dispose() {
            window.removeEventListener("focusin", sync, true);
            window.removeEventListener("focusout", sync, true);
            focused?.dispose();
          },
        });
      }

      function PanelToggle({ target, thread }: ChatHeaderActionProps) {
        const route = useExternal(navigation, navigation.current);
        const shortcut = useShortcutLabels(keybindings)("preview.toggle");
        // Beside the right panel, its own "Toggle right panel" takes this place (D1424).
        if (thread === undefined || rightPanel !== undefined) return null;
        const available = target.remote === undefined;
        return (
          <Tooltip>
            <TooltipTrigger render={<span className="flex shrink-0" />}>
              <Toggle
                aria-label="Toggle right panel"
                className="shrink-0"
                data-right-panel-toggle=""
                disabled={!available}
                onPressedChange={() => toggle()}
                pressed={route.panel === BROWSER_PANEL}
                size="sm"
                variant="ghost"
              >
                <PanelRightIcon className="size-4" />
              </Toggle>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {available
                ? `Toggle right panel${shortcut ? ` (${shortcut})` : ""}`
                : "Right panel is unavailable"}
            </TooltipPopup>
          </Tooltip>
        );
      }

      /** A tab an agent opens to show the user brings up the panel of its thread. */
      function Reveal({ target, thread }: ChatHeaderActionProps) {
        const feed =
          thread === undefined || target.remote !== undefined
            ? undefined
            : feeds.of(target.node, thread.id);
        const tabs = useExternal(feed ?? emptyFeed, () => feed?.tabs() ?? NO_TABS);
        const key = thread === undefined ? "" : `${targetKey(target)}|${thread.id}`;
        // What the thread had when it came on screen is not news: `preview.list` says.
        useEffect(() => {
          if (thread === undefined || feed === undefined || revealed.has(key)) return;
          let current = true;
          void threads
            .call<{ tabs: PreviewTab[] }>(target, "preview.list", { threadId: thread.id })
            .then(
              (listed) => {
                if (!current || revealed.has(key)) return;
                revealed.set(key, new Set(listed.tabs.map((tab) => tab.tabId)));
                reveal(key, thread.id, feed.tabs());
              },
              // A node without the browser plugin has nothing to reveal.
              () => undefined,
            );
          return () => {
            current = false;
          };
        }, [key]);
        useEffect(() => {
          if (thread !== undefined) reveal(key, thread.id, tabs);
        }, [tabs]);
        return null;
      }
      /** By thread: the tabs already known, so only new ones an agent shows bring the panel up. */
      const revealed =
        context.state.get<Map<string, Set<string>>>("revealed") ?? new Map<string, Set<string>>();
      // Survives a reload, so a tab already shown does not bring the panel up again.
      context.state.set("revealed", revealed);
      const reveal = (key: string, threadId: string, tabs: readonly PreviewTab[]) => {
        const seen = revealed.get(key);
        if (seen === undefined) return;
        const fresh = tabs.find(
          (tab) => tab.reveal && tab.owner === "agent" && !seen.has(tab.tabId),
        );
        for (const tab of tabs) seen.add(tab.tabId);
        if (fresh === undefined) return;
        setActiveTab(key, fresh.tabId);
        const route = navigation.current();
        if (rightPanel !== undefined) {
          // T3's useAgentOpenedPreviews: the right panel shows the agent's tab.
          if (route.thread === threadId) {
            navigation.navigate({
              ...withoutPanel(route),
              panel: BROWSER_PANEL,
              section: fresh.tabId,
            });
          }
          return;
        }
        if (route.panel !== BROWSER_PANEL && route.thread === threadId) {
          const { section: _section, ...rest } = route;
          navigation.navigate({ ...rest, panel: BROWSER_PANEL });
        }
      };

      function Panel() {
        const route = useExternal(navigation, navigation.current);
        if (
          rightPanel !== undefined ||
          route.panel !== BROWSER_PANEL ||
          route.node === undefined ||
          route.thread === undefined
        ) {
          return null;
        }
        if (route.remote !== undefined) return null;
        return <PanelFor target={{ node: route.node }} threadId={route.thread} />;
      }

      /** What the panel's chunk asks of the plugin, for a thread on `target`. */
      const servicesFor = (
        target: NodeTarget,
        shortcut: (command: string) => string | undefined,
      ): PanelServices => ({
        viewer,
        activeTab: (panelKey) => active.get(panelKey),
        setActiveTab,
        focusUrlRequests,
        call: (method, params) => threads.call(target, method, params),
        shortcut,
        onError,
        useFloatingTab: (panelKey) => useExternal(players, () => players.get(panelKey)?.tabId),
        float: (panelKey, tabId) => {
          if (tabId === undefined) players.close(panelKey);
          else float(panelKey, tabId);
        },
        useProfiles: () => resolveBrowserProfiles(profiles.use()),
        offerDownload,
        surfaces,
      });

      function PanelFor(props: { target: NodeTarget; threadId: string }) {
        const feed = feeds.of(props.target.node, props.threadId);
        const tabs = useExternal(feed, feed.tabs);
        const connection = useExternal(connections, () => connections.get(props.target.node));
        useExternal(activeStore, () => active.get(`${targetKey(props.target)}|${props.threadId}`));
        const shortcut = useShortcutLabels(keybindings);
        const key = `${targetKey(props.target)}|${props.threadId}`;
        useEffect(() => {
          const refresh = () => {
            const tabId = active.get(key) ?? feed.tabs().at(-1)?.tabId;
            if (tabId === undefined) return;
            void threads
              .call(props.target, "preview.tab.navigate", {
                threadId: props.threadId,
                tabId,
                viewer,
                reload: {},
              })
              .catch((error: unknown) => onError("Unable to change the browser tab", error));
          };
          refreshListeners.add(refresh);
          return () => {
            refreshListeners.delete(refresh);
          };
        }, [key]);
        if (connection === undefined) {
          return (
            <PanelPlaceholder>
              <p className="p-4 text-xs text-muted-foreground">Connecting…</p>
            </PanelPlaceholder>
          );
        }
        const services = servicesFor(props.target, shortcut);
        return (
          <BrowserPanel
            client={connection.client}
            panelKey={key}
            services={services}
            tabs={tabs}
            target={props.target}
            threadId={props.threadId}
          />
        );
      }

      context.subscriptions.add(
        slots.contribute<ChatHeaderActionProps>("chat.header.actions", {
          id: "jhin.preview.toggle",
          component: PanelToggle,
        }),
      );
      context.subscriptions.add(
        slots.contribute<ChatHeaderActionProps>("chat.header.actions", {
          id: "jhin.preview.reveal",
          component: Reveal,
        }),
      );
      /** T3's floating preview over the chat of its thread (D1202). */
      function Floating({ target, thread, composerHeight, canvas }: ChatThreadOverlayProps) {
        const route = useExternal(navigation, navigation.current);
        const key = `${targetKey(target)}|${thread.id}`;
        const state = useExternal(players, () => players.get(key));
        const feed = target.remote === undefined ? feeds.of(target.node, thread.id) : undefined;
        const tabs = useExternal(feed ?? emptyFeed, () => feed?.tabs() ?? NO_TABS);
        useExternal(activeStore, () => active.get(key));
        const connection = useExternal(connections, () => connections.get(target.node));
        const tab =
          state === undefined ? undefined : tabs.find((entry) => entry.tabId === state.tabId);
        // Part of what the view reads: a feed that (re)loads without a new list re-renders too.
        const loaded = useExternal(feed ?? emptyFeed, () => feed?.loaded() ?? false);
        // A floating tab that closed takes its player with it (T3's ChatView).
        useEffect(() => {
          if (state !== undefined && loaded && tab === undefined) {
            players.close(key);
            pictureInPicture.forget(thread.id, state.tabId);
          }
        }, [state, loaded, tab, key]);
        if (state === undefined || tab === undefined || connection === undefined) return null;
        // The right panel shows this tab: it does not float as well (T3's shouldRenderPreviewMiniPlayer).
        if (panelShows(route, key, tabs, tab.tabId)) return null;
        return (
          <MiniPlayer
            canvas={canvas}
            client={connection.client}
            onPopOutError={(error) => onError("Unable to pop out preview", error)}
            pictureInPicture={pictureInPicture}
            tabs={feed}
            composerHeight={composerHeight}
            key={tab.tabId}
            onDownload={(download) =>
              offerDownload(connection.client, { threadId: thread.id, tabId: tab.tabId }, download)
            }
            onError={(error) => onError("Unable to change the browser tab", error)}
            onOpenInPanel={() => {
              players.close(key);
              setActiveTab(key, tab.tabId);
              const current = navigation.current();
              if (rightPanel !== undefined) {
                navigation.navigate({
                  ...withoutPanel(current),
                  panel: BROWSER_PANEL,
                  section: tab.tabId,
                });
              } else if (current.panel !== BROWSER_PANEL) {
                const { section: _section, ...rest } = current;
                navigation.navigate({ ...rest, panel: BROWSER_PANEL });
              }
            }}
            players={players}
            state={state}
            surfaces={surfaces}
            tab={tab}
            threadId={thread.id}
            threadKey={key}
            viewer={viewer}
          />
        );
      }

      context.subscriptions.add(
        slots.contribute("app.panel", { id: "jhin.preview.panel", component: Panel }),
      );
      if (rightPanel !== undefined) registerSurfaces(rightPanel);

      /**
       * Each of a thread's tabs as a surface `browser:<tabId>` of the right panel, and T3's new
       * tab `browser:new` (t3-parity.md D1424).
       */
      function registerSurfaces(panel: RightPanel) {
        const keyOf = (place: RightPanelPlace) => `${targetKey(place.target)}|${place.threadId}`;
        /** The profile each place's new tab opens in, when the user picked one. */
        const draftProfiles = new Map<string, string>();
        const dialogs = context.services.tryGet<Dialogs>(UI_DIALOGS_CAPABILITY);

        // The route names the tab on screen: the plugin's own choice follows it.
        const followRoute = () => {
          const route = navigation.current();
          if (
            route.panel !== BROWSER_PANEL ||
            route.node === undefined ||
            route.thread === undefined ||
            route.remote !== undefined
          ) {
            return;
          }
          const key = `${targetKey({ node: route.node })}|${route.thread}`;
          if (route.section === undefined) {
            // A route naming the browser alone (an older link): the tab shown last, else a new one.
            const tabId = shownTab(key, feeds.of(route.node, route.thread).tabs()) ?? NEW_TAB;
            navigation.navigate({ ...route, section: tabId }, { replace: true });
            const place = { target: { node: route.node }, threadId: route.thread };
            const lone = panel
              .state(place)
              .surfaces.some((surface) => surface.id === BROWSER_PANEL);
            if (lone) void panel.close(place, BROWSER_PANEL);
            return;
          }
          if (route.section !== NEW_TAB && active.get(key) !== route.section) {
            setActiveTab(key, route.section);
          }
        };
        context.subscriptions.add(navigation.subscribe(followRoute));
        followRoute();

        // The thread on screen's tabs become its surfaces, as T3's reconcileBrowserSurfaces: a
        // new one is added unless its agent keeps it hidden (`reveal` false), a closed one goes.
        let watched: { key: string; stop: Disposable } | undefined;
        const watch = () => {
          const shown = threadOnScreen();
          if (watched?.key === shown?.key) return;
          watched?.stop.dispose();
          watched = undefined;
          if (shown === undefined) return;
          const place: RightPanelPlace = {
            target: { node: shown.route.node! },
            threadId: shown.route.thread!,
          };
          const apply = () => {
            if (!shown.feed.loaded()) return;
            const present = new Set(
              panel
                .state(place)
                .surfaces.filter((surface) => surface.kind === BROWSER_PANEL)
                .map((surface) => surface.resource),
            );
            const resources = shown.feed
              .tabs()
              // T3 hides a server tab the agent did not reveal; the app's own tabs always show.
              .filter((tab) => tab.reveal || tab.desktop === true || present.has(tab.tabId))
              .map((tab) => tab.tabId);
            if (present.has(NEW_TAB)) resources.push(NEW_TAB);
            panel.reconcile(place, BROWSER_PANEL, resources);
          };
          watched = { key: shown.key, stop: shown.feed.subscribe(apply) };
          apply();
        };
        context.subscriptions.add(navigation.subscribe(watch));
        context.subscriptions.add({ dispose: () => watched?.stop.dispose() });
        watch();

        function BrowserSurface({ place, surface }: RightPanelSurfaceProps) {
          const shortcut = useShortcutLabels(keybindings);
          const node = place.target.node;
          const threadId = place.threadId ?? "";
          const feed = feeds.of(node, threadId);
          const tabs = useExternal(feed, feed.tabs);
          const connection = useExternal(connections, () => connections.get(node));
          const key = keyOf(place);
          const resource = surface.resource;
          useEffect(() => {
            if (resource === undefined || resource === NEW_TAB) return;
            const refresh = () =>
              void threads
                .call(place.target, "preview.tab.navigate", {
                  threadId,
                  tabId: resource,
                  viewer,
                  reload: {},
                })
                .catch((error: unknown) => onError("Unable to change the browser tab", error));
            refreshListeners.add(refresh);
            return () => {
              refreshListeners.delete(refresh);
            };
          }, [key, resource]);
          if (place.threadId === undefined || place.target.remote !== undefined) return null;
          if (resource === undefined) return null;
          if (connection === undefined) {
            return <p className="p-4 text-xs text-muted-foreground">Connecting…</p>;
          }
          return (
            <BrowserSurfaceView
              client={connection.client}
              onOpened={(tabId) => {
                draftProfiles.delete(key);
                panel.open(place, { kind: BROWSER_PANEL, resource: tabId });
                // The new tab's start goes, as T3's openBrowser drops `browser:new`.
                void panel.close(place, rightPanelSurfaceId(BROWSER_PANEL, NEW_TAB));
              }}
              panelKey={key}
              profileId={draftProfiles.get(key)}
              resource={resource}
              services={servicesFor(place.target, shortcut)}
              tabs={tabs}
              threadId={place.threadId}
            />
          );
        }

        context.subscriptions.add(
          panel.register({
            id: BROWSER_PANEL,
            title: "Browser",
            icon: Globe2Icon,
            offer: {
              label: "Browser",
              shortcut: "B",
              order: 10,
              useAvailability: (place) =>
                place.threadId === undefined
                  ? {
                      available: false,
                      reason: "Browser previews are only available from a thread.",
                      hint: "Available from a thread.",
                    }
                  : place.target.remote !== undefined
                    ? {
                        available: false,
                        reason:
                          "The browser opens on nodes this client connects to; this thread is on another node of the mesh.",
                      }
                    : { available: true },
              // T3's browser profiles, a submenu of "Browser".
              useOptions: () =>
                resolveBrowserProfiles(profiles.use()).profiles.map((profile) => ({
                  id: profile.id,
                  label: profile.name,
                })),
              optionsLabel: "Open browser in a profile",
              add: (place, option) => {
                const key = keyOf(place);
                if (option === undefined) draftProfiles.delete(key);
                else draftProfiles.set(key, option);
                panel.open(place, { kind: BROWSER_PANEL, resource: NEW_TAB });
              },
            },
            useTab: ({ place, surface }) => {
              const feed =
                place.threadId === undefined || place.target.remote !== undefined
                  ? undefined
                  : feeds.of(place.target.node, place.threadId);
              const tabs = useExternal(feed ?? emptyFeed, () => feed?.tabs() ?? NO_TABS);
              return { title: tabTitle(tabs.find((tab) => tab.tabId === surface.resource)) };
            },
            // T3's closePreviewPanel: the tab on screen floats over the chat (D1202).
            onPanelClose: ({ place, surface }) => {
              if (surface.resource === undefined || surface.resource === NEW_TAB) return;
              if (place.threadId === undefined || place.target.remote !== undefined) return;
              floatTab(keyOf(place), surface.resource);
            },
            // T3's useRightPanelSurfaceClose: a closed surface closes its tab, after asking while
            // an agent drives it (`agentControlledBrowserCloseConfirmation`).
            release: async (place, closing) => {
              if (place.threadId === undefined || place.target.remote !== undefined) return true;
              const tabs = feeds.of(place.target.node, place.threadId).tabs();
              const closed = closing
                .map((surface) => tabs.find((tab) => tab.tabId === surface.resource))
                .filter((tab) => tab !== undefined);
              const driven = closed.filter(
                (tab) => tab.owner === "agent" && tab.controller === null,
              ).length;
              if (driven > 0 && dialogs !== undefined) {
                const confirmed = await dialogs.confirm(
                  driven === 1
                    ? {
                        title: "Close browser while the agent is using it?",
                        description:
                          "The agent is actively controlling this browser. Closing it may interrupt the current browser action.",
                        confirmLabel: "Close",
                        variant: "destructive",
                      }
                    : {
                        title: `Close ${driven} browsers while the agent is using them?`,
                        description:
                          "The agent is actively controlling these browsers. Closing them may interrupt the current browser actions.",
                        confirmLabel: "Close",
                        variant: "destructive",
                      },
                );
                if (!confirmed) return false;
              }
              for (const tab of closed) {
                void threads
                  .call(place.target, "preview.tab.close", {
                    threadId: place.threadId,
                    tabId: tab.tabId,
                  })
                  .catch((error: unknown) => onError("Unable to change the browser tab", error));
              }
              return true;
            },
            component: BrowserSurface,
          }),
        );
      }
      // In the desktop app: its own node's tabs in webviews (D1321, D1324).
      context.subscriptions.add(
        slots.contribute("app.global", {
          id: "jhin.preview.desktop-host",
          component: () => (
            <DesktopWebviews
              connections={connections}
              onError={onError}
              shell={desktopShell}
              surfaces={surfaces}
            />
          ),
        }),
      );
      context.subscriptions.add(
        slots.contribute<ChatThreadOverlayProps>("chat.thread.overlay", {
          id: "jhin.preview.mini-player",
          component: Floating,
        }),
      );
    },
  }),
);

const NO_TABS: readonly PreviewTab[] = Object.freeze([]);
const emptyFeed = { subscribe: () => ({ dispose() {} }) };
