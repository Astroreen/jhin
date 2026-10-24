// The commands, shortcuts, terminalFocus key and the card indicator follow T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): packages/shared/src/keybindings.ts, apps/web/src/lib/terminalFocus.ts,
// apps/web/src/lib/terminalCloseConfirm.ts and ThreadTerminalStatusButton in
// apps/web/src/components/ThreadStatusIndicators.tsx.
import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  RIGHT_PANEL_CAPABILITY,
  THREADS_CAPABILITY,
  targetKey,
  type ChatDrawerProps,
  type ChatHeaderActionProps,
  type Connections,
  type Keybindings,
  type Navigation,
  type NodeTarget,
  type RightPanel,
  type RightPanelSurfaceProps,
  type ThreadIndicatorProps,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin, z, type Disposable } from "@jhin/sdk";
import type { TerminalSummary } from "@jhin/terminal-api";
import {
  Toggle,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  UI_DIALOGS_CAPABILITY,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  cn,
  type Dialogs,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import { PanelRightIcon, TerminalIcon, TerminalSquareIcon } from "lucide-react";

import { builtin } from "../../lib/builtin.ts";
import { useCatalog, useConfig, useExternal, useShortcutLabels } from "../../lib/hooks.ts";
import {
  closeThreadTerminal,
  createTerminalUiStore,
  newThreadTerminal,
  nextTerminalId,
  revealThreadTerminal,
  setThreadActiveTerminal,
  setThreadTerminalHeight,
  setThreadTerminalOpen,
  splitThreadTerminal,
  terminalSessionLabel,
  type ThreadTerminalUiState,
} from "../../lib/terminal-state.ts";
import { terminalChannel } from "./channel.ts";
import { addToChatCall, type TerminalContextSelection } from "./context.ts";
import { ChunkFailed, lazyChunk } from "../../lib/lazy-chunk.tsx";
import { createNodeTerminals } from "./sessions.ts";

// The drawer and its terminals are a chunk of their own, loaded when a terminal first shows (D440).
const TerminalDrawer = lazyChunk(
  () => import("./drawer.tsx").then((module) => module.TerminalDrawer),
  {
    loading: () => null,
    failed: (_props, retry) => <ChunkFailed retry={retry}>Couldn't load the terminal.</ChunkFailed>,
  },
);

/** The route's panel while a thread's terminals show right of the chat (D474). */
const TERMINAL_PANEL = "terminal";

/** The terminal's client settings (D472), as T3's appearance settings have them. */
const SETTINGS_SECTION = "jhin.terminal-drawer";
const TerminalSettings = z
  .object({
    fontFamily: z
      .string()
      .default("")
      .meta({
        title: "Terminal font",
        description:
          "Font families for terminals, before the default monospace stack; empty for the default.",
        examples: ["JetBrains Mono"],
      }),
    fontSize: z.number().int().min(8).max(20).default(12).meta({
      title: "Terminal font size",
      description: "In pixels, 8 to 20.",
    }),
  })
  .meta({ title: "Terminal", description: "How terminals look in this client." });
type TerminalSettings = z.output<typeof TerminalSettings>;

/** Where a thread's drawer layout is kept on this device. */
const terminalThreadKey = (target: NodeTarget, threadId: string): string =>
  `${targetKey(target)}|${threadId}`;

/** Where a right-panel terminal surface keeps its layout (D1425): its thread's key and its id. */
const terminalSurfaceKey = (threadKey: string, resource: string): string =>
  `${threadKey}#${resource}`;

/** Focus is in a terminal of the right panel (T3's `terminalFocusOwner === "right-panel"`). */
function panelTerminalFocused(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement && active.closest('[data-terminal-owner="right-panel"]') !== null
  );
}

/** Focus is in a terminal (T3's `terminalFocus`): on or in an element of `[data-terminal-owner]`. */
function isTerminalFocused(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !active.isConnected) return false;
  return active.closest("[data-terminal-owner]") !== null;
}

function terminalProcessLabel(count: number): string {
  return count === 1
    ? "1 terminal process running. Open terminal"
    : `${count} terminal processes running. Open terminal`;
}

/**
 * `jhin.terminal-drawer`: T3's terminal under the chat. The drawer is the
 * `chat.drawer` slot's `jhin.terminal.drawer`; a card's terminal indicator is
 * the `sidebar.thread.indicators` slot's `jhin.terminal.indicator`. The
 * terminals themselves run on the thread's node (`terminals.*`, D140).
 */
export const terminalPlugin = builtin(
  "jhin.terminal-drawer",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
    },
    optional: {
      [KEYBINDINGS_CAPABILITY]: "^1",
      [UI_DIALOGS_CAPABILITY]: "^1",
      [UI_TOASTS_CAPABILITY]: "^1",
      // The thread's terminals as a surface of the right panel (t3-parity.md D1424).
      [RIGHT_PANEL_CAPABILITY]: "^1",
    },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      const dialogs = context.services.tryGet<Dialogs>(UI_DIALOGS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const rightPanel = context.services.tryGet<RightPanel>(RIGHT_PANEL_CAPABILITY);
      context.config.define(SETTINGS_SECTION, TerminalSettings);
      /** Without the chat plugin there is no composer: the menus leave the item out. */
      const hasCommand = (name: string) =>
        context.commands.list().some((command) => command.name === name);
      /**
       * "Add to chat" (D473): the selection into the open thread's composer, as T3's inline
       * terminal chip with its record (D1009); as T3's legacy text where the chat takes no records.
       */
      const addToChat = (selection: TerminalContextSelection) => {
        const { command, input } = addToChatCall(selection, hasCommand);
        void context.commands
          .execute(command, input)
          .then((result) => {
            const answer = result as { inserted?: boolean; reason?: string };
            if (answer.inserted === true) return;
            toasts?.show({
              type: "info",
              title:
                answer.reason === "full"
                  ? "The message holds as much context as it can"
                  : answer.reason === "not-now"
                    ? "The message box takes no context now"
                    : "No message box to add the selection to",
            });
          })
          .catch((error: unknown) => {
            context.log.warn("terminal selection not added to chat", { error: String(error) });
            toasts?.show({
              type: "error",
              title: "Could not add the selection to the chat",
              description: (error as Error).message,
            });
          });
      };
      const canAddToChat = () =>
        hasCommand("chat.composer.insert-context") || hasCommand("chat.composer.insert");
      const ui = context.subscriptions.add(createTerminalUiStore());
      const terminals = context.subscriptions.add(createNodeTerminals(connections));
      /** Bumped to put the focus back in the active terminal. */
      let focusRequest = 0;
      const focusRequests = new Set<() => void>();
      const requestFocus = () => {
        focusRequest += 1;
        for (const listener of Array.from(focusRequests)) listener();
      };
      const focusStore = {
        subscribe(listener: () => void): Disposable {
          focusRequests.add(listener);
          return { dispose: () => focusRequests.delete(listener) };
        },
      };

      /** The open thread, on a connection of this client or on a member of its mesh (D504). */
      const openThread = (): { key: string; target: NodeTarget; threadId: string } | undefined => {
        const route = navigation.current();
        if (route.node === undefined || route.thread === undefined) return undefined;
        const target: NodeTarget = {
          node: route.node,
          ...(route.remote === undefined ? {} : { remote: route.remote }),
        };
        return { key: terminalThreadKey(target, route.thread), target, threadId: route.thread };
      };
      const change = (
        key: string,
        update: (state: ThreadTerminalUiState) => ThreadTerminalUiState,
      ) => {
        ui.update(key, update);
        requestFocus();
      };

      /**
       * The terminal surfaces of a thread's right panel, by their id (D1425); none without the
       * right panel.
       */
      const surfaceResources = (target: NodeTarget, threadId: string): string[] =>
        rightPanel === undefined
          ? []
          : rightPanel
              .state({ target, threadId })
              .surfaces.filter((surface) => surface.kind === TERMINAL_PANEL)
              .flatMap((surface) => (surface.resource === undefined ? [] : [surface.resource]));
      /** The panel surface holding a terminal of the thread, if one does. */
      const surfaceOfTerminal = (target: NodeTarget, threadId: string, terminalId: string) => {
        const key = terminalThreadKey(target, threadId);
        return surfaceResources(target, threadId).find((resource) =>
          ui.get(terminalSurfaceKey(key, resource)).terminalIds.includes(terminalId),
        );
      };
      /** A new terminal's id, unique across the drawer, the panel's surfaces and the node. */
      const nextId = (target: NodeTarget, threadId: string): string => {
        const key = terminalThreadKey(target, threadId);
        return nextTerminalId([
          ...ui.get(key).terminalIds,
          ...surfaceResources(target, threadId).flatMap((resource) => [
            resource,
            ...ui.get(terminalSurfaceKey(key, resource)).terminalIds,
          ]),
          ...terminals
            .of(target)
            .sessions()
            .filter((item) => item.threadId === threadId)
            .map((item) => item.terminalId),
        ]);
      };
      /** T3's addTerminalSurface: a new terminal in a right-panel surface of its own (D1425). */
      const addTerminalSurface = (target: NodeTarget, threadId: string) => {
        if (rightPanel === undefined) return;
        const id = nextId(target, threadId);
        ui.update(terminalSurfaceKey(terminalThreadKey(target, threadId), id), (state) =>
          newThreadTerminal(state, id),
        );
        rightPanel.open({ target, threadId }, { kind: TERMINAL_PANEL, resource: id });
        requestFocus();
      };
      /** A surface whose last terminal went closes with it, as T3's closeTerminal does. */
      const closeEmptySurface = (target: NodeTarget, threadId: string, stateKey: string) => {
        if (rightPanel === undefined) return;
        const threadKey = terminalThreadKey(target, threadId);
        if (stateKey === threadKey || ui.get(stateKey).terminalIds.length > 0) return;
        void rightPanel.close(
          { target, threadId },
          `${TERMINAL_PANEL}:${stateKey.slice(threadKey.length + 1)}`,
        );
      };

      /** Drops the tab of a terminal the node closed already. */
      const dropTab = (
        target: NodeTarget,
        threadId: string,
        terminalId: string,
        stateKey = terminalThreadKey(target, threadId),
      ) => {
        ui.update(stateKey, (state) => closeThreadTerminal(state, terminalId));
        closeEmptySurface(target, threadId, stateKey);
      };
      /** Stops the terminal on its node and drops its tab. */
      const closeTerminal = (
        target: NodeTarget,
        threadId: string,
        terminalId: string,
        stateKey = terminalThreadKey(target, threadId),
      ) => {
        dropTab(target, threadId, terminalId, stateKey);
        const client = connections.get(target.node)?.client;
        if (client === undefined) return;
        void terminalChannel(client, target.remote)
          .call("terminals.close", { threadId, terminalId })
          .catch((error: unknown) =>
            context.log.warn("terminal not closed", { terminalId, error: String(error) }),
          );
      };
      /** T3 asks before closing: the process stops and its history goes. */
      const confirmClose = async (
        target: NodeTarget,
        threadId: string,
        terminalId: string,
        label: string,
        stateKey = terminalThreadKey(target, threadId),
      ) => {
        const confirmed =
          dialogs === undefined ||
          (await dialogs.confirm({
            title: `Close terminal "${label}"?`,
            description: "This stops the running process and clears its history.",
            confirmLabel: "Close",
            variant: "destructive",
          }));
        if (confirmed) closeTerminal(target, threadId, terminalId, stateKey);
      };
      const labelIn = (target: NodeTarget, threadId: string) => (terminalId: string) =>
        terminalSessionLabel(
          terminalId,
          terminals
            .of(target)
            .sessions()
            .find((item) => item.threadId === threadId && item.terminalId === terminalId),
        );

      // --- Commands ------------------------------------------------------------
      const register = (name: string, title: string, description: string, run: () => unknown) =>
        context.commands.register({
          name,
          title,
          description,
          input: z.object({}),
          output: z.object({}),
          handler: async () => {
            await run();
            return {};
          },
        });
      register(
        "terminal.toggle",
        "Toggle terminal",
        "Opens the open thread's terminal drawer, or hides it; its terminals keep running",
        () => {
          const place = openThread();
          if (place === undefined) return;
          // Shown in the right panel (D474, without the tabbed panel): the toggle hides it.
          const route = navigation.current();
          if (rightPanel === undefined && route.panel === TERMINAL_PANEL) {
            const { panel: _panel, section: _section, ...rest } = route;
            navigation.navigate(rest);
            return;
          }
          change(place.key, (state) => setThreadTerminalOpen(state, !state.terminalOpen));
        },
      );
      /** Shows the thread's terminals right of the chat, or back under it (D474). */
      const togglePanel = () => {
        const place = openThread();
        if (place === undefined) return;
        const route = navigation.current();
        const { panel, section: _section, ...rest } = route;
        if (panel === TERMINAL_PANEL) {
          navigation.navigate(rest);
          return;
        }
        if (rightPanel !== undefined) {
          // The thread's first terminal surface, else a new one (D1425).
          const first = surfaceResources(place.target, place.threadId)[0];
          if (first === undefined) addTerminalSurface(place.target, place.threadId);
          else {
            rightPanel.open(
              { target: place.target, threadId: place.threadId },
              { kind: TERMINAL_PANEL, resource: first },
            );
            requestFocus();
          }
          return;
        }
        ui.update(place.key, (state) =>
          state.terminalIds.length === 0
            ? newThreadTerminal(state, nextTerminalId(state.terminalIds))
            : state,
        );
        navigation.navigate({ ...rest, panel: TERMINAL_PANEL });
        requestFocus();
      };
      register(
        "terminal.panel.toggle",
        "Toggle terminal panel",
        "Shows the open thread's terminals in the panel right of the chat, or hides the panel",
        togglePanel,
      );
      /** The right-panel terminal surface on screen while focus is in it (D1425). */
      const focusedSurface = () => {
        const place = openThread();
        const route = navigation.current();
        if (
          place === undefined ||
          rightPanel === undefined ||
          route.panel !== TERMINAL_PANEL ||
          route.section === undefined ||
          !panelTerminalFocused()
        ) {
          return undefined;
        }
        return { ...place, stateKey: terminalSurfaceKey(place.key, route.section) };
      };
      const split = (direction: "horizontal" | "vertical") => () => {
        const place = openThread();
        if (place === undefined) return;
        const key = focusedSurface()?.stateKey ?? place.key;
        change(key, (state) =>
          splitThreadTerminal(state, nextId(place.target, place.threadId), direction),
        );
      };
      register(
        "terminal.split",
        "Split terminal",
        "Opens another terminal next to the active one",
        split("horizontal"),
      );
      register(
        "terminal.split-vertical",
        "Split terminal vertically",
        "Opens another terminal below the active one",
        split("vertical"),
      );
      // Another plugin shows a thread's terminal it started (a worktree's setup script, D1125).
      context.commands.register({
        name: "terminal.reveal",
        title: "Show terminal",
        description:
          "Shows a terminal of a thread in its drawer, opening the drawer and adding the terminal's tab when it has none",
        input: z.object({
          node: z.string(),
          remote: z.string().optional(),
          threadId: z.string(),
          terminalId: z.string(),
        }),
        output: z.object({}),
        handler: async ({ node, remote, threadId, terminalId }) => {
          const target: NodeTarget = { node, ...(remote === undefined ? {} : { remote }) };
          change(terminalThreadKey(target, threadId), (state) =>
            revealThreadTerminal(state, terminalId),
          );
          return {};
        },
      });
      register("terminal.new", "New terminal", "Opens another terminal in its own group", () => {
        const place = openThread();
        if (place === undefined) return;
        // In the right panel: a surface of its own, as T3's onNewTerminal (D1425).
        if (focusedSurface() !== undefined) {
          addTerminalSurface(place.target, place.threadId);
          return;
        }
        change(place.key, (state) =>
          newThreadTerminal(state, nextId(place.target, place.threadId)),
        );
      });
      register("terminal.close", "Close terminal", "Closes the active terminal", () => {
        const place = openThread();
        if (place === undefined) return;
        const surface = focusedSurface();
        const key = surface?.stateKey ?? place.key;
        const state = ui.get(key);
        if ((surface === undefined && !state.terminalOpen) || state.activeTerminalId === "") return;
        return confirmClose(
          place.target,
          place.threadId,
          state.activeTerminalId,
          labelIn(place.target, place.threadId)(state.activeTerminalId),
          key,
        );
      });

      if (keybindings !== undefined) {
        context.subscriptions.add(
          keybindings.addDefaults([
            { key: "mod+j", command: "terminal.toggle" },
            { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
            { key: "mod+shift+d", command: "terminal.split-vertical", when: "terminalFocus" },
            { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
            { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
          ]),
        );
        // D61: `terminalFocus` while the focus is in a terminal.
        let focused: Disposable | undefined;
        const sync = () => {
          const now = isTerminalFocused();
          if (now && focused === undefined) focused = keybindings.setContext("terminalFocus", true);
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

      // --- The drawer and the right panel ------------------------------------------
      /** T3's drawer (or right-panel terminal) of one thread: its tabs, splits and terminals. */
      function Terminals(props: {
        target: NodeTarget;
        threadId: string;
        cwd: string;
        placement: "drawer" | "panel";
        embedded?: boolean;
        /** A right-panel surface's id: its own terminals and layout (D1425). */
        surface?: string;
        visible: boolean;
      }) {
        const { target, threadId, surface } = props;
        const threadKey = terminalThreadKey(target, threadId);
        const key = surface === undefined ? threadKey : terminalSurfaceKey(threadKey, surface);
        const state = useExternal(ui, () => ui.get(key));
        const connection = useExternal(connections, () => connections.get(target.node));
        const feed = terminals.of(target);
        const sessions = useExternal(feed, feed.sessions);
        const focusRequestId = useExternal(focusStore, () => focusRequest);
        const shortcut = useShortcutLabels(keybindings);
        const settings = useConfig<TerminalSettings>(context, SETTINGS_SECTION);
        if (connection === undefined) return null;
        // Never shown yet: nothing to keep mounted.
        if (!props.visible && state.terminalIds.length === 0) return null;
        const labelOf = (terminalId: string) =>
          terminalSessionLabel(
            terminalId,
            sessions.find((item) => item.threadId === threadId && item.terminalId === terminalId),
          );
        return (
          <TerminalDrawer
            client={terminalChannel(connection.client, target.remote)}
            cwd={props.cwd}
            focusRequestId={focusRequestId}
            fontFamily={settings.fontFamily}
            fontSize={settings.fontSize}
            key={`${key}|${props.placement}`}
            labelOf={labelOf}
            onActiveChange={(terminalId) =>
              ui.update(key, (current) => setThreadActiveTerminal(current, terminalId))
            }
            onAddToChat={canAddToChat() ? addToChat : undefined}
            onOpenPath={
              // T3's openInPreferredEditor, kept by source control (D965).
              hasCommand("files.open-in-editor")
                ? (path) =>
                    context.commands.execute("files.open-in-editor", {
                      ...target,
                      threadId,
                      ...path,
                    })
                : undefined
            }
            onCloseRequest={(terminalId) =>
              void confirmClose(target, threadId, terminalId, labelOf(terminalId), key)
            }
            onClosed={(terminalId, reason) =>
              // A closed session is gone on the node already: closing it again
              // could end a terminal another client opened since under that id.
              reason === "exited"
                ? closeTerminal(target, threadId, terminalId, key)
                : dropTab(target, threadId, terminalId, key)
            }
            onHeightChange={(height) =>
              ui.update(key, (current) => setThreadTerminalHeight(current, height))
            }
            onNew={() => {
              // In the right panel another surface, as T3's; an empty surface starts its own.
              if (surface !== undefined && state.terminalIds.length > 0) {
                addTerminalSurface(target, threadId);
                return;
              }
              change(key, (current) => newThreadTerminal(current, nextId(target, threadId)));
            }}
            onSplit={() =>
              change(key, (current) =>
                splitThreadTerminal(current, nextId(target, threadId), "horizontal"),
              )
            }
            onSplitVertical={() =>
              change(key, (current) =>
                splitThreadTerminal(current, nextId(target, threadId), "vertical"),
              )
            }
            embedded={props.embedded === true}
            placement={props.placement}
            shortcuts={{
              split: shortcut("terminal.split"),
              splitVertical: shortcut("terminal.split-vertical"),
              new: shortcut("terminal.new"),
              close: shortcut("terminal.close"),
            }}
            state={state}
            threadId={threadId}
            visible={props.visible}
          />
        );
      }

      /**
       * Under the chat. A hidden drawer keeps its terminals mounted (T3's
       * persistent terminals, D474); while they show in the right panel the
       * drawer gives them up.
       */
      function Drawer({ target, thread, project }: ChatDrawerProps) {
        const route = useExternal(navigation, navigation.current);
        const state = useExternal(ui, () => ui.get(terminalThreadKey(target, thread.id)));
        // D474 without the tabbed panel: the drawer gives its terminals up to the panel. With
        // it, the panel's terminals are its own (D1425).
        if (rightPanel === undefined && route.panel === TERMINAL_PANEL) return null;
        return (
          <Terminals
            cwd={project.path}
            placement="drawer"
            target={target}
            threadId={thread.id}
            visible={state.terminalOpen}
          />
        );
      }

      /** The right panel's `terminal` surface (t3-parity.md D1424). */
      function TerminalSurface({ place, surface }: RightPanelSurfaceProps) {
        const catalog = useCatalog(threads, place.target);
        if (place.threadId === undefined || surface.resource === undefined) return null;
        const thread = catalog?.threads.find((item) => item.id === place.threadId);
        const project = catalog?.projects.find((item) => item.id === thread?.projectId);
        if (project === undefined) return null;
        return (
          <Terminals
            cwd={project.path}
            embedded
            key={surface.resource}
            placement="panel"
            surface={surface.resource}
            target={place.target}
            threadId={place.threadId}
            visible
          />
        );
      }

      /** Right of the chat (`app.panel`), while the route's panel is `terminal` (D474). */
      function Panel() {
        const route = useExternal(navigation, navigation.current);
        const target: NodeTarget | undefined =
          rightPanel !== undefined || route.node === undefined || route.panel !== TERMINAL_PANEL
            ? undefined
            : { node: route.node, ...(route.remote === undefined ? {} : { remote: route.remote }) };
        const catalog = useCatalog(threads, target);
        if (target === undefined || route.thread === undefined) return null;
        const thread = catalog?.threads.find((item) => item.id === route.thread);
        const project = catalog?.projects.find((item) => item.id === thread?.projectId);
        if (project === undefined) return null;
        return (
          <Terminals
            cwd={project.path}
            placement="panel"
            target={target}
            threadId={route.thread}
            visible
          />
        );
      }

      /** The header's toggle of the right-panel terminal. */
      function PanelToggle({ thread }: ChatHeaderActionProps) {
        const route = useExternal(navigation, navigation.current);
        const shortcut = useShortcutLabels(keybindings)("terminal.panel.toggle");
        // Beside the right panel, its "Add panel surface" opens the terminals (D1424).
        if (thread === undefined || rightPanel !== undefined) return null;
        const open = route.panel === TERMINAL_PANEL;
        return (
          <Tooltip>
            <TooltipTrigger render={<span className="flex shrink-0" />}>
              <Toggle
                aria-label="Toggle terminal panel"
                className="shrink-0"
                onPressedChange={() => togglePanel()}
                pressed={open}
                size="sm"
                variant="ghost"
              >
                <PanelRightIcon className="size-4" />
              </Toggle>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {`Toggle terminal panel${shortcut ? ` (${shortcut})` : ""}`}
            </TooltipPopup>
          </Tooltip>
        );
      }

      // --- A card's indicator ------------------------------------------------------
      /** T3's ThreadTerminalStatusButton: a program runs in one of the thread's terminals. */
      function Indicator({ target, thread }: ThreadIndicatorProps) {
        const feed = terminals.of(target);
        const sessions = useExternal(feed, feed.sessions);
        const running: TerminalSummary[] = sessions.filter(
          (item) => item.threadId === thread.id && item.hasRunningSubprocess,
        );
        const first = running[0];
        if (first === undefined) return null;
        const label = terminalProcessLabel(running.length);
        return (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-label={label}
                  className={cn(
                    "pointer-events-auto inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    "text-teal-600 dark:text-teal-300/90",
                  )}
                  data-testid={`sidebar-terminal-status-${thread.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    // A terminal of the right panel shows in its surface (D1425).
                    const resource = surfaceOfTerminal(target, thread.id, first.terminalId);
                    if (rightPanel !== undefined && resource !== undefined) {
                      rightPanel.open(
                        { target, threadId: thread.id },
                        { kind: TERMINAL_PANEL, resource },
                      );
                      requestFocus();
                      return;
                    }
                    ui.update(terminalThreadKey(target, thread.id), (state) =>
                      revealThreadTerminal(state, first.terminalId),
                    );
                    requestFocus();
                    navigation.navigate({
                      node: target.node,
                      ...(target.remote === undefined ? {} : { remote: target.remote }),
                      thread: thread.id,
                    });
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  type="button"
                />
              }
            >
              <TerminalIcon className="size-3.5 motion-safe:animate-status-pulse" />
            </TooltipTrigger>
            <TooltipPopup side="top">{label}</TooltipPopup>
          </Tooltip>
        );
      }

      context.subscriptions.add(
        slots.contribute<ChatDrawerProps>("chat.drawer", {
          id: "jhin.terminal.drawer",
          component: Drawer,
        }),
      );
      context.subscriptions.add(
        slots.contribute("app.panel", { id: "jhin.terminal.panel", component: Panel }),
      );
      if (rightPanel !== undefined) {
        context.subscriptions.add(
          rightPanel.register({
            id: TERMINAL_PANEL,
            title: "Terminal",
            icon: TerminalSquareIcon,
            offer: {
              label: "Terminal",
              shortcut: "T",
              order: 20,
              // T3's `terminalAvailable`: a thread of a project.
              useAvailability: (place) =>
                place.threadId === undefined
                  ? {
                      available: false,
                      reason: "Terminal surfaces are only available from a project thread.",
                      hint: "Available when a project is open.",
                    }
                  : { available: true },
              // T3's addTerminalSurface: a new terminal in a surface of its own (D1425).
              add: (place) => {
                if (place.threadId !== undefined) addTerminalSurface(place.target, place.threadId);
              },
            },
            // T3's tab: its active terminal's name.
            useTab: ({ place, surface }) => {
              const key = terminalSurfaceKey(
                terminalThreadKey(place.target, place.threadId ?? ""),
                surface.resource ?? "",
              );
              const state = useExternal(ui, () => ui.get(key));
              const feed = terminals.of(place.target);
              const sessions = useExternal(feed, feed.sessions);
              const id = state.activeTerminalId || surface.resource || "";
              return {
                title: terminalSessionLabel(
                  id,
                  sessions.find(
                    (item) => item.threadId === place.threadId && item.terminalId === id,
                  ),
                ),
              };
            },
            // T3's useRightPanelSurfaceClose: a surface's terminals close with it, after asking.
            release: async (place, closing) => {
              if (place.threadId === undefined) return true;
              const threadId = place.threadId;
              const threadKey = terminalThreadKey(place.target, threadId);
              const groups = closing.flatMap((surface) =>
                surface.resource === undefined
                  ? []
                  : [terminalSurfaceKey(threadKey, surface.resource)],
              );
              const ids = groups.flatMap((key) =>
                ui.get(key).terminalIds.map((terminalId) => ({ key, terminalId })),
              );
              const labels = ids.map(({ terminalId }) =>
                labelIn(place.target, threadId)(terminalId),
              );
              if (labels.length > 0 && dialogs !== undefined) {
                const confirmed = await dialogs.confirm(
                  labels.length === 1
                    ? {
                        title: `Close terminal "${labels[0]}"?`,
                        description: "This stops the running process and clears its history.",
                        confirmLabel: "Close",
                        variant: "destructive",
                      }
                    : {
                        title: `Close ${labels.length} terminals?`,
                        description: `This stops their running processes and clears their histories: ${labels
                          .map((label) => `"${label}"`)
                          .join(", ")}.`,
                        confirmLabel: "Close",
                        variant: "destructive",
                      },
                );
                if (!confirmed) return false;
              }
              for (const { key, terminalId } of ids) {
                ui.update(key, (state) => closeThreadTerminal(state, terminalId));
                const client = connections.get(place.target.node)?.client;
                if (client === undefined) continue;
                void terminalChannel(client, place.target.remote)
                  .call("terminals.close", { threadId, terminalId })
                  .catch((error: unknown) =>
                    context.log.warn("terminal not closed", { terminalId, error: String(error) }),
                  );
              }
              return true;
            },
            component: TerminalSurface,
          }),
        );
      }
      context.subscriptions.add(
        slots.contribute<ChatHeaderActionProps>("chat.header.actions", {
          id: "jhin.terminal.panel-toggle",
          component: PanelToggle,
        }),
      );
      context.subscriptions.add(
        slots.contribute<ThreadIndicatorProps>("sidebar.thread.indicators", {
          id: "jhin.terminal.indicator",
          // T3's order on the card: branch (-100), a running terminal, pull request (100), diff.
          order: 0,
          component: Indicator,
        }),
      );
    },
  }),
);
