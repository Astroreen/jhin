// The toggle, the commands and their shortcuts follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/chat/PanelLayoutControls.tsx (the header's right panel toggle),
// packages/shared/src/keybindings.ts (preview.toggle, preview.refresh, preview.focusUrl),
// apps/web/src/lib/previewFocus.ts and components/preview/useAgentOpenedPreviews.ts.
import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  SETTINGS_CAPABILITY,
  THREADS_CAPABILITY,
  targetKey,
  type ChatHeaderActionProps,
  type ChatThreadOverlayProps,
  type Connections,
  type DeviceSettings,
  type Keybindings,
  type Navigation,
  type NodeTarget,
  type ThreadsCatalog,
} from "@jhin/client-api";
import type { PreviewTab } from "@jhin/preview-api";
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
import type { BrowserPanelProps, PanelServices } from "./panel.tsx";
import type { MiniPlayerProps } from "./mini-player.tsx";
import { createMiniPlayers, type MiniPlayerState } from "./mini-player-store.ts";

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
      const feeds = context.subscriptions.add(createTabFeeds(connections));
      // T3's browser profiles, kept on this device (D953).
      context.config.define(PREVIEW_BROWSER_SECTION, PreviewBrowserSettings);
      const deviceSettings = context.services.tryGet<DeviceSettings>(SETTINGS_CAPABILITY);
      const profiles: ProfilesServices = {
        settings: deviceSettings,
        connections,
        dialogs: context.services.tryGet<Dialogs>(UI_DIALOGS_CAPABILITY),
        toasts: context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY),
        read: () => readSection(context, PREVIEW_BROWSER_SECTION, PreviewBrowserSettings),
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

      /** T3's download toast: "Downloaded <file>", and Save fetches it from the node (D1331). */
      const offerDownload = (
        client: RpcClient,
        tab: { threadId: string; tabId: string },
        download: { id: string; fileName: string },
      ) => {
        const id = toasts?.show({
          type: "info",
          title: `Downloaded ${download.fileName}`,
          action: {
            label: "Save",
            onClick: () => {
              if (id !== undefined) toasts?.close(id);
              void client
                .call<{ fileName: string; data: string }>("preview.tab.download", {
                  ...tab,
                  id: download.id,
                })
                .then(({ fileName, data }) => {
                  const binary = atob(data);
                  const bytes = new Uint8Array(binary.length);
                  for (let index = 0; index < binary.length; index += 1) {
                    bytes[index] = binary.charCodeAt(index);
                  }
                  const url = URL.createObjectURL(new Blob([bytes]));
                  const anchor = document.createElement("a");
                  anchor.href = url;
                  anchor.download = fileName;
                  anchor.click();
                  setTimeout(() => URL.revokeObjectURL(url), 0);
                })
                .catch((error: unknown) => onError("Couldn't save the download", error));
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
          navigation.navigate({ ...withoutPanel(route), panel: BROWSER_PANEL });
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
        if (thread === undefined) return null;
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
        if (route.panel !== BROWSER_PANEL && route.thread === threadId) {
          const { section: _section, ...rest } = route;
          navigation.navigate({ ...rest, panel: BROWSER_PANEL });
        }
      };

      function Panel() {
        const route = useExternal(navigation, navigation.current);
        if (
          route.panel !== BROWSER_PANEL ||
          route.node === undefined ||
          route.thread === undefined
        ) {
          return null;
        }
        if (route.remote !== undefined) return null;
        return <PanelFor target={{ node: route.node }} threadId={route.thread} />;
      }

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
        const services: PanelServices = {
          viewer,
          activeTab: (panelKey) => active.get(panelKey),
          setActiveTab,
          focusUrlRequests,
          call: (method, params) => threads.call(props.target, method, params),
          shortcut,
          onError,
          useFloatingTab: (panelKey) => useExternal(players, () => players.get(panelKey)?.tabId),
          float: (panelKey, tabId) => {
            if (tabId === undefined) players.close(panelKey);
            else float(panelKey, tabId);
          },
          useProfiles: () => resolveBrowserProfiles(profiles.use()),
          offerDownload,
        };
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
      function Floating({ target, thread, composerHeight }: ChatThreadOverlayProps) {
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
          if (state !== undefined && loaded && tab === undefined) players.close(key);
        }, [state, loaded, tab, key]);
        if (state === undefined || tab === undefined || connection === undefined) return null;
        // The right panel shows this tab: it does not float as well (T3's shouldRenderPreviewMiniPlayer).
        if (route.panel === BROWSER_PANEL && shownTab(key, tabs) === tab.tabId) return null;
        return (
          <MiniPlayer
            client={connection.client}
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
              if (current.panel !== BROWSER_PANEL) {
                const { section: _section, ...rest } = current;
                navigation.navigate({ ...rest, panel: BROWSER_PANEL });
              }
            }}
            players={players}
            state={state}
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
