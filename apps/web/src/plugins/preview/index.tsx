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
  type Connections,
  type DeviceSettings,
  type Keybindings,
  type Navigation,
  type NodeTarget,
  type ThreadsCatalog,
} from "@jhin/client-api";
import type { PreviewTab } from "@jhin/preview-api";
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

      /** Opens or closes the right panel of the thread on screen. */
      const toggle = () => {
        const route = navigation.current();
        if (route.node === undefined || route.thread === undefined) return false;
        if (route.remote !== undefined) {
          toasts?.show({
            type: "info",
            title: "Browser unavailable",
            description:
              "The browser opens on nodes this client connects to; this thread is on another node of the mesh.",
          });
          return false;
        }
        const { panel, section: _section, ...rest } = route;
        navigation.navigate(panel === BROWSER_PANEL ? rest : { ...rest, panel: BROWSER_PANEL });
        return true;
      };

      context.commands.register({
        name: "preview.toggle",
        title: "Toggle browser preview",
        description: "Opens or closes the right panel with the thread's browser tabs",
        input: z.object({}),
        output: z.object({ toggled: z.boolean() }),
        handler: () => ({ toggled: toggle() }),
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
          useProfiles: () => resolveBrowserProfiles(profiles.use()),
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
      context.subscriptions.add(
        slots.contribute("app.panel", { id: "jhin.preview.panel", component: Panel }),
      );
    },
  }),
);

const NO_TABS: readonly PreviewTab[] = Object.freeze([]);
const emptyFeed = { subscribe: () => ({ dispose() {} }) };
