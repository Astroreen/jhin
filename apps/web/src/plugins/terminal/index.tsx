// The commands, shortcuts, terminalFocus key and the card indicator follow T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): packages/shared/src/keybindings.ts, apps/web/src/lib/terminalFocus.ts,
// apps/web/src/lib/terminalCloseConfirm.ts and ThreadTerminalStatusButton in
// apps/web/src/components/ThreadStatusIndicators.tsx.
import {
  CONNECTIONS_CAPABILITY,
  KEYBINDINGS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  targetKey,
  type ChatDrawerProps,
  type Connections,
  type Keybindings,
  type Navigation,
  type NodeTarget,
  type ThreadIndicatorProps,
} from "@jhin/client-api";
import { definePlugin, z, type Disposable } from "@jhin/sdk";
import type { TerminalSummary } from "@jhin/terminal-api";
import {
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
import { TerminalIcon } from "lucide-react";

import { builtin } from "../../lib/builtin.ts";
import { useExternal, useShortcutLabels } from "../../lib/hooks.ts";
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
import { TerminalDrawer } from "./drawer.tsx";
import { createNodeTerminals } from "./sessions.ts";

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

      /** The open thread, when its node is a connection of this client. */
      const openThread = (): { key: string; target: NodeTarget; threadId: string } | undefined => {
        const route = navigation.current();
        if (route.node === undefined || route.thread === undefined) return undefined;
        if (route.remote !== undefined) {
          toasts?.show({
            type: "info",
            title: "Terminal unavailable",
            description:
              "Terminals open on nodes this client connects to; this thread is on another node of the mesh.",
          });
          return undefined;
        }
        const target = { node: route.node };
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
        void client
          ?.call("terminals.close", { threadId, terminalId })
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
            .of(target.node)
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
          change(place.key, (state) => setThreadTerminalOpen(state, !state.terminalOpen));
        },
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

      // --- The drawer ------------------------------------------------------------
      function Drawer({ target, thread, project }: ChatDrawerProps) {
        const key = terminalThreadKey(target, thread.id);
        const state = useExternal(ui, () => ui.get(key));
        const connection = useExternal(connections, () => connections.get(target.node));
        const feed = terminals.of(target.node);
        const sessions = useExternal(feed, feed.sessions);
        const focusRequestId = useExternal(focusStore, () => focusRequest);
        const shortcut = useShortcutLabels(keybindings);
        if (target.remote !== undefined || connection === undefined || !state.terminalOpen) {
          return null;
        }
        const labelOf = (terminalId: string) =>
          terminalSessionLabel(
            terminalId,
            sessions.find((item) => item.threadId === thread.id && item.terminalId === terminalId),
          );
        return (
          <TerminalDrawer
            client={connection.client}
            cwd={project.path}
            focusRequestId={focusRequestId}
            key={key}
            labelOf={labelOf}
            onActiveChange={(terminalId) =>
              ui.update(key, (current) => setThreadActiveTerminal(current, terminalId))
            }
            onCloseRequest={(terminalId) =>
              void confirmClose(target, thread.id, terminalId, labelOf(terminalId))
            }
            onClosed={(terminalId, reason) =>
              // A closed session is gone on the node already: closing it again
              // could end a terminal another client opened since under that id.
              reason === "exited"
                ? closeTerminal(target, thread.id, terminalId)
                : dropTab(target, thread.id, terminalId)
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
            shortcuts={{
              split: shortcut("terminal.split"),
              splitVertical: shortcut("terminal.split-vertical"),
              new: shortcut("terminal.new"),
              close: shortcut("terminal.close"),
            }}
            state={state}
            threadId={thread.id}
          />
        );
      }

      // --- A card's indicator ------------------------------------------------------
      /** T3's ThreadTerminalStatusButton: a program runs in one of the thread's terminals. */
      function Indicator({ target, thread }: ThreadIndicatorProps) {
        const feed = terminals.of(target.node);
        const sessions = useExternal(feed, feed.sessions);
        if (target.remote !== undefined) return null;
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
                    navigation.navigate({ node: target.node, thread: thread.id });
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
