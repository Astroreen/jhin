// The commands, shortcuts, terminalFocus key and the card indicator follow T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): packages/shared/src/keybindings.ts, apps/web/src/lib/terminalFocus.ts,
// apps/web/src/lib/terminalCloseConfirm.ts and ThreadTerminalStatusButton in
// apps/web/src/components/ThreadStatusIndicators.tsx.
import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  THREADS_CAPABILITY,
  targetKey,
  type ChatDrawerProps,
  type ChatHeaderActionProps,
  type Connections,
  type Keybindings,
  type Navigation,
  type NodeTarget,
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
import { PanelRightIcon, TerminalIcon } from "lucide-react";

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

      /** Drops the tab of a terminal the node closed already. */
      const dropTab = (target: NodeTarget, threadId: string, terminalId: string) =>
        ui.update(terminalThreadKey(target, threadId), (state) =>
          closeThreadTerminal(state, terminalId),
        );
      /** Stops the terminal on its node and drops its tab. */
      const closeTerminal = (target: NodeTarget, threadId: string, terminalId: string) => {
        dropTab(target, threadId, terminalId);
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
      ) => {
        const confirmed =
          dialogs === undefined ||
          (await dialogs.confirm({
            title: `Close terminal "${label}"?`,
            description: "This stops the running process and clears its history.",
            confirmLabel: "Close",
            variant: "destructive",
          }));
        if (confirmed) closeTerminal(target, threadId, terminalId);
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
          // Shown in the right panel: the toggle hides the panel.
          const route = navigation.current();
          if (route.panel === TERMINAL_PANEL) {
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
      const split = (direction: "horizontal" | "vertical") => () => {
        const place = openThread();
        if (place === undefined) return;
        change(place.key, (state) =>
          splitThreadTerminal(state, nextTerminalId(state.terminalIds), direction),
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
      register("terminal.new", "New terminal", "Opens another terminal in its own group", () => {
        const place = openThread();
        if (place === undefined) return;
        change(place.key, (state) => newThreadTerminal(state, nextTerminalId(state.terminalIds)));
      });
      register("terminal.close", "Close terminal", "Closes the active terminal", () => {
        const place = openThread();
        if (place === undefined) return;
        const state = ui.get(place.key);
        if (!state.terminalOpen || state.activeTerminalId === "") return;
        return confirmClose(
          place.target,
          place.threadId,
          state.activeTerminalId,
          labelIn(place.target, place.threadId)(state.activeTerminalId),
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
        visible: boolean;
      }) {
        const { target, threadId } = props;
        const key = terminalThreadKey(target, threadId);
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
              void confirmClose(target, threadId, terminalId, labelOf(terminalId))
            }
            onClosed={(terminalId, reason) =>
              // A closed session is gone on the node already: closing it again
              // could end a terminal another client opened since under that id.
              reason === "exited"
                ? closeTerminal(target, threadId, terminalId)
                : dropTab(target, threadId, terminalId)
            }
            onHeightChange={(height) =>
              ui.update(key, (current) => setThreadTerminalHeight(current, height))
            }
            onNew={() =>
              change(key, (current) =>
                newThreadTerminal(current, nextTerminalId(current.terminalIds)),
              )
            }
            onSplit={() =>
              change(key, (current) =>
                splitThreadTerminal(current, nextTerminalId(current.terminalIds), "horizontal"),
              )
            }
            onSplitVertical={() =>
              change(key, (current) =>
                splitThreadTerminal(current, nextTerminalId(current.terminalIds), "vertical"),
              )
            }
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
        if (route.panel === TERMINAL_PANEL) return null;
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

      /** Right of the chat (`app.panel`), while the route's panel is `terminal` (D474). */
      function Panel() {
        const route = useExternal(navigation, navigation.current);
        const target: NodeTarget | undefined =
          route.node === undefined || route.panel !== TERMINAL_PANEL
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
        if (thread === undefined) return null;
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
