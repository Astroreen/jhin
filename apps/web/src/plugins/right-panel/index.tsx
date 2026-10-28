// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md) at eb7b35ac: apps/web/src/rightPanelStore.ts
// (a thread's panel kept per thread, `openProactive` and the user's revision), the right panel's
// handlers of apps/web/src/components/ChatView.tsx (toggling it, closing it on a surface, its
// shortcuts), apps/web/src/components/chat/PanelLayoutControls.tsx ("Toggle right panel") and
// packages/shared/src/keybindings.ts (rightPanel.toggle, rightPanel.new, rightPanel.close,
// view.reopenClosed), and apps/web/src/components/ReopenClosedViewShortcut.tsx (reopening the
// newest closed view one at a time, "Could not reopen view").
//
// `jhin.right-panel`: one panel right of the chat whose tabs are other plugins' surfaces
// (t3-parity.md D1421–D1424). The route says what shows; this plugin keeps each place's tabs.
import {
  KEYBINDINGS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  RIGHT_PANEL_CAPABILITY,
  RIGHT_PANEL_EMPTY,
  THREADS_CAPABILITY,
  rightPanelPlaceKey,
  type ChatHeaderActionProps,
  type Keybindings,
  type Navigation,
  type RightPanel,
  type RightPanelPlace,
  type RightPanelState,
  type RightPanelSurface,
  type RightPanelSurfaceKind,
  type Route,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin, toDisposable, z, type Disposable } from "@jhin/sdk";
import {
  Toggle,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  UI_SLOTS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type SlotRegistry,
  type Toasts,
} from "@jhin/ui";
import { PanelRightIcon } from "lucide-react";

import { builtin } from "../../lib/builtin.ts";
import { useExternal, useShortcutLabels } from "../../lib/hooks.ts";
import { ChunkFailed, lazyChunk } from "../../lib/lazy-chunk.tsx";
import {
  CLOSED_VIEWS_KEY,
  defer,
  planNextReopen,
  readClosedViews,
  remember,
  writeClosedViews,
  type ClosedView,
} from "./closed-views.ts";
import type { RightPanelViewProps } from "./panel.tsx";
import {
  EMPTY_STATE,
  STORAGE_KEY,
  closeAll,
  closeOthers,
  closeSurface,
  closeToRight,
  isEmpty,
  move,
  readStored,
  reconcile,
  surfaceOf,
  upsert,
  writeStored,
} from "./store.ts";

/** Places kept on the device, the least recently changed going first (D1421). */
const MAX_PLACES = 200;

/** The panel's place while its chunk loads, so the chat does not jump. */
function PanelPlaceholder(props: { children?: React.ReactNode }) {
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
const RightPanelView = lazyChunk<RightPanelViewProps>(
  () => import("./panel.tsx").then((module) => module.RightPanelView),
  {
    loading: () => <PanelPlaceholder />,
    failed: (_props, retry) => (
      <PanelPlaceholder>
        <ChunkFailed retry={retry}>Couldn't load the right panel.</ChunkFailed>
      </PanelPlaceholder>
    ),
  },
);

/** The place a route is in: its thread, or the draft of its project, on its node. */
function placeOf(route: Route): RightPanelPlace | undefined {
  if (route.node === undefined) return undefined;
  const target = {
    node: route.node,
    ...(route.remote === undefined ? {} : { remote: route.remote }),
  };
  if (route.thread !== undefined) return { target, threadId: route.thread };
  if (route.project !== undefined) return { target, projectId: route.project };
  return undefined;
}

/** The route without the right panel's part. */
function withoutPanel(route: Route): Route {
  const { panel: _panel, section: _section, ...rest } = route;
  return rest;
}

/**
 * `jhin.right-panel`: provides `ui.right-panel@1` and contributes the panel (`app.panel`
 * `jhin.right-panel.panel`) and T3's "Toggle right panel" (`chat.header.actions`
 * `jhin.right-panel.toggle`).
 */
export const rightPanelPlugin = builtin(
  "jhin.right-panel",
  {
    provides: { [RIGHT_PANEL_CAPABILITY]: "1.1.0" },
    requires: { [UI_SLOTS_CAPABILITY]: "^1", [NAVIGATION_CAPABILITY]: "^1.1" },
    optional: {
      [KEYBINDINGS_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
      [UI_TOASTS_CAPABILITY]: "^1",
    },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const keybindings = context.services.tryGet<Keybindings>(KEYBINDINGS_CAPABILITY);
      const threads = context.services.tryGet<ThreadsCatalog>(THREADS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);

      // --- Each place's panel, kept on this device (D1421) ---------------------------------
      const places = (() => {
        try {
          return readStored(localStorage.getItem(STORAGE_KEY));
        } catch {
          return new Map<string, RightPanelState>();
        }
      })();
      /** By place: bumped by each change the user makes (T3's `userActionRevisionByThreadKey`). */
      const revisions = new Map<string, number>();
      const listeners = new Set<() => void>();
      const changed = () => {
        for (const listener of Array.from(listeners)) listener();
      };
      const save = () => {
        try {
          localStorage.setItem(STORAGE_KEY, writeStored(places));
        } catch {
          // A full or blocked storage only costs keeping the tabs.
        }
      };
      const stateOf = (key: string) => places.get(key) ?? EMPTY_STATE;
      /** Changes a place's panel; a change by the user bumps its revision. */
      const update = (
        key: string,
        change: (state: RightPanelState) => RightPanelState,
        user: boolean,
      ) => {
        const current = stateOf(key);
        const next = change(current);
        if (next === current) return;
        // The latest change last, so the oldest places go first past the cap.
        places.delete(key);
        if (!isEmpty(next)) places.set(key, next);
        for (const old of places.keys()) {
          if (places.size <= MAX_PLACES) break;
          if (old !== key) places.delete(old);
        }
        if (user) revisions.set(key, (revisions.get(key) ?? 0) + 1);
        save();
        changed();
      };

      // --- Surface kinds ------------------------------------------------------------------
      const kinds = new Map<string, { kind: RightPanelSurfaceKind; key: string }>();
      let registrations = 0;
      let sorted: readonly RightPanelSurfaceKind[] = [];
      const resort = () => {
        sorted = [...kinds.values()]
          .map((entry) => entry.kind)
          .toSorted(
            (a, b) => (a.offer?.order ?? 0) - (b.offer?.order ?? 0) || a.id.localeCompare(b.id),
          );
      };

      // --- Closed views, for "Reopen Closed Tab" (D1641) ----------------------------------
      let closedViews: readonly ClosedView[] = (() => {
        try {
          return readClosedViews(localStorage.getItem(CLOSED_VIEWS_KEY));
        } catch {
          return [];
        }
      })();
      const closedListeners = new Set<() => void>();
      const setClosedViews = (next: readonly ClosedView[]) => {
        if (next === closedViews) return;
        closedViews = next;
        for (const listener of Array.from(closedListeners)) listener();
        try {
          localStorage.setItem(CLOSED_VIEWS_KEY, writeClosedViews(next));
        } catch {
          // A full or blocked storage only costs reopening them.
        }
      };
      /** Keeps surfaces the user closed, the active one last so it comes back first (T3's order). */
      const rememberClosed = (
        place: RightPanelPlace,
        closed: readonly RightPanelSurface[],
        activeId: string | null,
      ) => {
        const ordered = [
          ...closed.filter((surface) => surface.id !== activeId),
          ...closed.filter((surface) => surface.id === activeId),
        ];
        let next = closedViews;
        for (const surface of ordered) {
          const kept = kinds.get(surface.kind)?.kind.remember?.({ place, surface });
          if (kept === null) continue;
          next = remember(
            next,
            { place, surface, ...(kept === undefined ? {} : { kept }) },
            crypto.randomUUID(),
          );
        }
        setClosedViews(next);
      };

      // --- The route and the panel follow each other --------------------------------------
      /** The route that shows `surface` of `place` (none: the panel's "Open a surface"). */
      const routeFor = (place: RightPanelPlace, surface: RightPanelSurface | null): Route => {
        const current = navigation.current();
        const here = placeOf(current);
        const base: Route =
          here !== undefined && rightPanelPlaceKey(here) === rightPanelPlaceKey(place)
            ? withoutPanel(current)
            : {
                node: place.target.node,
                ...(place.target.remote === undefined ? {} : { remote: place.target.remote }),
                ...(place.threadId !== undefined
                  ? { thread: place.threadId }
                  : place.projectId !== undefined
                    ? { project: place.projectId }
                    : {}),
              };
        if (surface === null) return { ...base, panel: RIGHT_PANEL_EMPTY };
        return {
          ...base,
          panel: surface.kind,
          ...(surface.resource === undefined ? {} : { section: surface.resource }),
        };
      };
      /** The place on screen and its key. */
      const onScreen = () => {
        const place = placeOf(navigation.current());
        return place === undefined ? undefined : { place, key: rightPanelPlaceKey(place) };
      };
      /** Whether the route shows the right panel (one of its surfaces, or none). */
      const routeShowsPanel = (route: Route) =>
        route.panel === RIGHT_PANEL_EMPTY || (route.panel !== undefined && kinds.has(route.panel));

      /** While set, what the route does to the panel is not the user's doing. */
      let automatic = false;
      const navigateAutomatically = (route: Route, replace: boolean) => {
        automatic = true;
        try {
          navigation.navigate(route, { replace });
        } finally {
          automatic = false;
        }
      };
      /** After a change that was not the route's: the route of the place on screen follows it. */
      const followState = (key: string) => {
        const shown = onScreen();
        if (shown === undefined || shown.key !== key) return;
        const route = navigation.current();
        // Another view (settings) or a panel still closed: the route is not the panel's.
        if (!routeShowsPanel(route)) return;
        const state = stateOf(key);
        if (!state.open) {
          navigateAutomatically(withoutPanel(route), true);
          return;
        }
        const active = state.surfaces.find((surface) => surface.id === state.activeId) ?? null;
        const wanted = routeFor(shown.place, active);
        if (wanted.panel !== route.panel || wanted.section !== route.section) {
          navigateAutomatically(wanted, true);
        }
      };

      let lastPlace: string | undefined;
      const sync = () => {
        const route = navigation.current();
        const place = placeOf(route);
        const key = place === undefined ? undefined : rightPanelPlaceKey(place);
        const entered = key !== lastPlace;
        lastPlace = key;
        if (key === undefined) return;
        const user = !automatic;
        if (route.panel === RIGHT_PANEL_EMPTY) {
          update(
            key,
            (state) =>
              state.open && state.activeId === null
                ? state
                : { ...state, open: true, activeId: null },
            user,
          );
          return;
        }
        if (route.panel !== undefined && kinds.has(route.panel)) {
          const surface = surfaceOf(route.panel, route.section);
          update(
            key,
            (state) =>
              state.open && state.activeId === surface.id ? state : upsert(state, surface),
            user,
          );
          return;
        }
        if (route.panel !== undefined) return; // Another view (settings): the panel waits.
        const state = stateOf(key);
        if (!state.open) return;
        if (entered) {
          // Back at a place whose panel was open: it shows as it was (T3's per-thread panel).
          // A surface whose kind has not registered yet (the page is starting) shows when it does.
          const active = state.surfaces.find((surface) => surface.id === state.activeId) ?? null;
          if (active === null || kinds.has(active.kind)) {
            navigateAutomatically(routeFor(place!, active), true);
          }
          return;
        }
        update(key, (current) => ({ ...current, open: false, maximized: false }), user);
      };
      context.subscriptions.add(navigation.subscribe(sync));
      sync();

      const register = (kind: RightPanelSurfaceKind): Disposable => {
        if (kinds.has(kind.id)) throw new Error(`The right panel already has a kind ${kind.id}`);
        registrations += 1;
        const entry = { kind, key: `${kind.id}#${registrations}` };
        kinds.set(kind.id, entry);
        resort();
        changed();
        // A route that named this kind before it came shows it now, and so does a place whose
        // panel was open on it when the page started (`sync` left it open for this).
        const route = navigation.current();
        const shown = onScreen();
        const state = shown === undefined ? EMPTY_STATE : stateOf(shown.key);
        const active = state.surfaces.find((surface) => surface.id === state.activeId);
        if (
          shown !== undefined &&
          route.panel === undefined &&
          state.open &&
          active?.kind === kind.id
        ) {
          navigateAutomatically(routeFor(shown.place, active), true);
        } else if (route.panel === kind.id) {
          lastPlace = undefined;
          automatic = true;
          try {
            sync();
          } finally {
            automatic = false;
          }
        }
        return toDisposable(() => {
          if (kinds.get(kind.id) !== entry) return;
          kinds.delete(kind.id);
          resort();
          changed();
        });
      };

      const open: RightPanel["open"] = (place, { kind, resource }) => {
        navigation.navigate(routeFor(place, surfaceOf(kind, resource)));
      };
      const toggle = (place: RightPanelPlace) => {
        const key = rightPanelPlaceKey(place);
        const shown = onScreen();
        const state = stateOf(key);
        const showing = shown?.key === key && routeShowsPanel(navigation.current());
        if (showing) {
          // T3's closePreviewPanel: the surface on screen may float (a browser tab) first.
          const active = state.surfaces.find((surface) => surface.id === state.activeId);
          const kind = active === undefined ? undefined : kinds.get(active.kind)?.kind;
          if (active !== undefined) kind?.onPanelClose?.({ place, surface: active });
          update(key, (current) => ({ ...current, open: false, maximized: false }), true);
          navigation.navigate(withoutPanel(navigation.current()));
          return;
        }
        const active = state.surfaces.find((surface) => surface.id === state.activeId) ?? null;
        navigation.navigate(
          routeFor(place, active !== null && kinds.has(active.kind) ? active : null),
        );
      };
      /** Moves a surface to another place of its strip (T3's `moveSurface`), clamped to the strip. */
      const moveSurface = (key: string, id: string, index: number) =>
        update(
          key,
          (state) => move(state, id, Math.max(0, Math.min(index, state.surfaces.length - 1))),
          false,
        );
      /** T3's `setMaximized`, not a choice it counts against opening a panel by itself. */
      const toggleMaximized = (key: string) =>
        update(key, (state) => ({ ...state, maximized: !state.maximized }), false);
      /** A user's change of a place's panel, the route following it. */
      const change = (
        place: RightPanelPlace,
        edit: (state: RightPanelState) => RightPanelState,
      ) => {
        const key = rightPanelPlaceKey(place);
        const before = stateOf(key);
        update(key, edit, true);
        if (stateOf(key) !== before) followState(key);
      };
      /**
       * A user's change that closes surfaces: each kind releases its own first (a browser tab
       * closes, maybe after asking), and nothing closes if one refuses. Whether it changed.
       */
      const closing = async (
        place: RightPanelPlace,
        edit: (state: RightPanelState) => RightPanelState,
      ): Promise<boolean> => {
        const key = rightPanelPlaceKey(place);
        const before = stateOf(key);
        const after = edit(before);
        if (after === before) return false;
        const removed = before.surfaces.filter(
          (surface) => !after.surfaces.some((entry) => entry.id === surface.id),
        );
        const byKind = new Map<string, RightPanelSurface[]>();
        for (const surface of removed) {
          byKind.set(surface.kind, [...(byKind.get(surface.kind) ?? []), surface]);
        }
        const answers = await Promise.all(
          [...byKind].map(async ([id, surfaces]) => {
            const release = kinds.get(id)?.kind.release;
            return release === undefined ? true : await release(place, surfaces);
          }),
        );
        if (!answers.every(Boolean)) return false;
        // Only what was released goes: a surface added while a kind asked (a tab an agent
        // opened meanwhile) stays, as its kind was never asked about it.
        const current = stateOf(key);
        const closed = removed.filter((surface) =>
          current.surfaces.some((entry) => entry.id === surface.id),
        );
        change(place, (state) => {
          let next = state;
          for (const surface of removed) next = closeSurface(next, surface.id);
          const wanted = after.activeId;
          if (
            wanted !== null &&
            next.activeId !== wanted &&
            next.surfaces.some((surface) => surface.id === wanted)
          ) {
            next = { ...next, activeId: wanted };
          }
          // A close that empties the strip closes the panel, also when the kind's own update
          // (a tab gone from the node) removed the surfaces while it was asked.
          return !after.open && next.open ? { ...next, open: false } : next;
        });
        rememberClosed(place, closed, before.activeId);
        return stateOf(key) !== current;
      };

      /** Whether a closed view's place is still there, as its node's threads say. */
      const ownerOf = (entry: ClosedView) => {
        if (threads === undefined) return "unknown" as const;
        const catalog = threads.catalog(entry.place.target);
        if (catalog.status !== "ready") return "unknown" as const;
        const present =
          entry.place.threadId !== undefined
            ? catalog.threads.some((thread) => thread.id === entry.place.threadId)
            : catalog.projects.some((project) => project.id === entry.place.projectId);
        return present ? ("present" as const) : ("gone" as const);
      };
      /** T3's `reopenNext`: the newest closed view that can reopen does, its place on screen. */
      const reopenClosed = async (): Promise<boolean> => {
        const { drop, restore } = planNextReopen(closedViews, ownerOf, (entry) => {
          const state = stateOf(rightPanelPlaceKey(entry.place));
          return state.open && state.surfaces.some((surface) => surface.id === entry.surface.id);
        });
        if (drop.length > 0) {
          setClosedViews(closedViews.filter((entry) => !drop.includes(entry.id)));
        }
        if (restore === undefined) return false;
        const kind = kinds.get(restore.surface.kind)?.kind;
        // Its kind is not here now (its plugin is off): it waits last, as T3's `defer`.
        let reopened: boolean;
        try {
          reopened =
            kind === undefined
              ? false
              : kind.reopen === undefined
                ? (open(restore.place, restore.surface), true)
                : await kind.reopen(restore.place, restore.surface, restore.kept);
        } catch (error) {
          // A reopen that failed waits last, so the others stay reachable.
          setClosedViews(defer(closedViews, restore.id));
          throw error;
        }
        if (!reopened) {
          setClosedViews(defer(closedViews, restore.id));
          return false;
        }
        setClosedViews(closedViews.filter((entry) => entry.id !== restore.id));
        return true;
      };
      /** One reopen at a time, in the order asked (T3's `enqueueReopen`). */
      let reopening: Promise<unknown> = Promise.resolve();
      const enqueueReopen = () => {
        const next = reopening.then(reopenClosed).catch((error: unknown) => {
          toasts?.show({
            type: "error",
            title: "Could not reopen view",
            description: error instanceof Error ? error.message : String(error),
          });
          return false;
        });
        reopening = next;
        return next;
      };

      const service: RightPanel = {
        register,
        kinds: () => sorted,
        state: (place) => stateOf(rightPanelPlaceKey(place)),
        current: () => onScreen()?.place,
        open,
        openProactive(place, { kind, resource }, revision) {
          const key = rightPanelPlaceKey(place);
          if ((revisions.get(key) ?? 0) !== revision) return false;
          const surface = surfaceOf(kind, resource);
          if (onScreen()?.key === key) {
            navigateAutomatically(routeFor(place, surface), false);
          } else {
            update(key, (state) => upsert(state, surface), false);
          }
          return true;
        },
        revision: (place) => revisions.get(rightPanelPlaceKey(place)) ?? 0,
        reconcile(place, kind, resources) {
          const key = rightPanelPlaceKey(place);
          const before = stateOf(key);
          update(key, (state) => reconcile(state, kind, resources), false);
          if (stateOf(key) !== before) followState(key);
        },
        close: (place, surfaceId) => closing(place, (state) => closeSurface(state, surfaceId)),
        toggle,
        subscribe(listener) {
          listeners.add(listener);
          return toDisposable(() => listeners.delete(listener));
        },
      };
      context.services.provide(RIGHT_PANEL_CAPABILITY, service);

      // --- Commands (D1423) ----------------------------------------------------------------
      /** Bumped to open "Add panel surface" (⌘/Ctrl+T). */
      const newSurfaceRequests = { current: 0, listeners: new Set<() => void>() };
      const SurfaceList = z.object({
        open: z.boolean(),
        maximized: z.boolean(),
        activeId: z.string().nullable(),
        surfaces: z.array(
          z.object({ id: z.string(), kind: z.string(), resource: z.string().optional() }),
        ),
      });
      const Changed = z.object({ changed: z.boolean() });
      /** A user's closing of surfaces of the panel on screen, and whether it changed anything. */
      const onCurrent = async (edit: (state: RightPanelState) => RightPanelState) => {
        const shown = onScreen();
        if (shown === undefined) return { changed: false };
        return { changed: await closing(shown.place, edit) };
      };
      context.commands.register({
        name: "right-panel.toggle",
        title: "Toggle right panel",
        description: "Opens the right panel of the thread on screen on its surface, or closes it",
        input: z.object({}),
        output: z.object({ open: z.boolean() }),
        handler: () => {
          const shown = onScreen();
          if (shown === undefined) return { open: false };
          toggle(shown.place);
          return { open: routeShowsPanel(navigation.current()) };
        },
      });
      context.commands.register({
        name: "right-panel.new",
        title: "Add panel surface",
        description: "Opens the right panel's menu of surfaces to add, while the panel shows",
        input: z.object({}),
        output: z.object({ opened: z.boolean() }),
        handler: () => {
          if (onScreen() === undefined || !routeShowsPanel(navigation.current())) {
            return { opened: false };
          }
          newSurfaceRequests.current += 1;
          for (const listener of Array.from(newSurfaceRequests.listeners)) listener();
          return { opened: true };
        },
      });
      context.commands.register({
        name: "right-panel.close",
        title: "Close active panel surface",
        description: "Closes the surface the right panel shows (T3's rightPanel.close)",
        input: z.object({}),
        output: Changed,
        handler: () => {
          if (!routeShowsPanel(navigation.current())) return { changed: false };
          return onCurrent((state) =>
            state.activeId === null ? state : closeSurface(state, state.activeId),
          );
        },
      });
      context.commands.register({
        name: "right-panel.maximize.toggle",
        title: "Maximize panel",
        description: "Lets the right panel cover the chat, or gives the chat its place back",
        input: z.object({}),
        output: z.object({ maximized: z.boolean() }),
        handler: () => {
          if (!routeShowsPanel(navigation.current())) return { maximized: false };
          const shown = onScreen();
          if (shown === undefined) return { maximized: false };
          toggleMaximized(shown.key);
          return { maximized: stateOf(shown.key).maximized };
        },
      });
      context.commands.register({
        name: "right-panel.reopen-closed",
        title: "Reopen Closed Tab",
        description:
          "Reopens the right panel's surface closed last, its thread on screen (T3's view.reopenClosed)",
        input: z.object({}),
        output: z.object({ reopened: z.boolean() }),
        handler: async () => ({ reopened: await enqueueReopen() }),
      });
      context.commands.register({
        name: "right-panel.surfaces.list",
        title: "List panel surfaces",
        description: "The surfaces of the right panel of the thread on screen, in order",
        input: z.object({}),
        output: SurfaceList,
        handler: () => {
          const shown = onScreen();
          const state = shown === undefined ? EMPTY_STATE : stateOf(shown.key);
          return {
            open: shown !== undefined && routeShowsPanel(navigation.current()),
            maximized: state.maximized,
            activeId: state.activeId,
            surfaces: state.surfaces.map((surface) => ({ ...surface })),
          };
        },
      });
      context.commands.register({
        name: "right-panel.surface.open",
        title: "Open panel surface",
        description:
          "Shows a surface in the right panel of the thread on screen, added when it is new (kinds: browser, diff, file, terminal, devices, pull-requests, …)",
        input: z.object({ kind: z.string().min(1), resource: z.string().min(1).optional() }),
        output: z.object({ opened: z.boolean() }),
        handler: ({ kind, resource }) => {
          const shown = onScreen();
          if (shown === undefined || !kinds.has(kind)) return { opened: false };
          open(shown.place, { kind, ...(resource === undefined ? {} : { resource }) });
          return { opened: true };
        },
      });
      const SurfaceId = z.object({ id: z.string().min(1) });
      context.commands.register({
        name: "right-panel.surface.activate",
        title: "Show panel surface",
        description: "Shows one of the right panel's surfaces by its id",
        input: SurfaceId,
        output: Changed,
        handler: ({ id }) => {
          const shown = onScreen();
          const surface = shown && stateOf(shown.key).surfaces.find((entry) => entry.id === id);
          if (shown === undefined || surface === undefined || !kinds.has(surface.kind)) {
            return { changed: false };
          }
          const before = stateOf(shown.key);
          open(shown.place, surface);
          const after = stateOf(shown.key);
          return { changed: after.activeId !== before.activeId || after.open !== before.open };
        },
      });
      context.commands.register({
        name: "right-panel.surface.close",
        title: "Close panel surface",
        description: "Closes one of the right panel's surfaces by its id",
        input: SurfaceId,
        output: Changed,
        handler: ({ id }) => onCurrent((state) => closeSurface(state, id)),
      });
      context.commands.register({
        name: "right-panel.surface.close-others",
        title: "Close other panel surfaces",
        description: "Closes every surface of the right panel but this one",
        input: SurfaceId,
        output: Changed,
        handler: ({ id }) => onCurrent((state) => closeOthers(state, id)),
      });
      context.commands.register({
        name: "right-panel.surface.close-to-right",
        title: "Close panel surfaces to the right",
        description: "Closes the right panel's surfaces right of this one",
        input: SurfaceId,
        output: Changed,
        handler: ({ id }) => onCurrent((state) => closeToRight(state, id)),
      });
      context.commands.register({
        name: "right-panel.surfaces.close-all",
        title: "Close all panel surfaces",
        description: "Closes every surface of the right panel, and the panel",
        input: z.object({}),
        output: Changed,
        handler: () => onCurrent(closeAll),
      });
      context.commands.register({
        name: "right-panel.surface.move",
        title: "Move panel surface",
        description: "Moves a surface of the right panel to another place in its strip",
        input: z.object({ id: z.string().min(1), index: z.number().int().min(0) }),
        output: Changed,
        handler: ({ id, index }) => {
          const shown = onScreen();
          if (shown === undefined) return { changed: false };
          const before = stateOf(shown.key);
          moveSurface(shown.key, id, index);
          return { changed: stateOf(shown.key) !== before };
        },
      });

      if (keybindings !== undefined) {
        context.subscriptions.add(
          keybindings.addDefaults([
            { key: "mod+alt+b", command: "right-panel.toggle" },
            // Only while something is kept, so the browser's own ⌘⇧T works otherwise, as T3's.
            {
              key: "mod+shift+t",
              command: "right-panel.reopen-closed",
              when: "hasClosedViews && !terminalFocus",
            },
            { key: "mod+t", command: "right-panel.new", when: "rightPanelOpen && !terminalFocus" },
            {
              key: "mod+w",
              command: "right-panel.close",
              when: "rightPanelOpen && !terminalFocus",
            },
          ]),
        );
        // `rightPanelOpen` while the route shows the panel.
        let openKey: Disposable | undefined;
        const follow = () => {
          const now = onScreen() !== undefined && routeShowsPanel(navigation.current());
          if (now && openKey === undefined)
            openKey = keybindings.setContext("rightPanelOpen", true);
          else if (!now && openKey !== undefined) {
            openKey.dispose();
            openKey = undefined;
          }
        };
        context.subscriptions.add(navigation.subscribe(follow));
        context.subscriptions.add(service.subscribe(follow));
        context.subscriptions.add({ dispose: () => openKey?.dispose() });
        follow();
        // `hasClosedViews` while "Reopen Closed Tab" has something to reopen (D1641).
        let closedKey: Disposable | undefined;
        const followClosed = () => {
          if (closedViews.length > 0 && closedKey === undefined) {
            closedKey = keybindings.setContext("hasClosedViews", true);
          } else if (closedViews.length === 0 && closedKey !== undefined) {
            closedKey.dispose();
            closedKey = undefined;
          }
        };
        closedListeners.add(followClosed);
        context.subscriptions.add({
          dispose: () => {
            closedListeners.delete(followClosed);
            closedKey?.dispose();
          },
        });
        followClosed();
      }

      // --- The UI ------------------------------------------------------------------------
      const snapshot = () => {
        const shown = onScreen();
        return shown === undefined ? undefined : stateOf(shown.key);
      };
      const source = {
        subscribe(listener: () => void): Disposable {
          const fromRoute = navigation.subscribe(listener);
          const fromState = service.subscribe(listener);
          return toDisposable(() => {
            fromRoute.dispose();
            fromState.dispose();
          });
        },
      };

      /** What the panel follows of `right-panel.new`: one object, so it subscribes once. */
      const newSurfaceSource = {
        current: () => newSurfaceRequests.current,
        subscribe(listener: () => void) {
          newSurfaceRequests.listeners.add(listener);
          return () => {
            newSurfaceRequests.listeners.delete(listener);
          };
        },
      };

      function Panel() {
        const route = useExternal(navigation, navigation.current);
        const state = useExternal(source, snapshot);
        const kindList = useExternal(service, () => sorted);
        const place = placeOf(route);
        if (place === undefined || state === undefined || !routeShowsPanel(route)) return null;
        const key = rightPanelPlaceKey(place);
        return (
          <RightPanelView
            key={key}
            kinds={kindList}
            kindKey={(id) => kinds.get(id)?.key}
            newSurfaceRequests={newSurfaceSource}
            onActivate={(surface) => open(place, surface)}
            onAdd={(kind, option) => {
              if (kind.offer?.add !== undefined) kind.offer.add(place, option);
              else open(place, { kind: kind.id });
            }}
            onClose={(id) => void closing(place, (current) => closeSurface(current, id))}
            onCloseAll={() => void closing(place, closeAll)}
            onCloseOthers={(id) => void closing(place, (current) => closeOthers(current, id))}
            onCloseToRight={(id) => void closing(place, (current) => closeToRight(current, id))}
            onError={(id, error) =>
              context.log.error("surface failed to render", { kind: id, error: String(error) })
            }
            onMove={(id, index) => moveSurface(key, id, index)}
            onClosePanel={() => toggle(place)}
            onToggleMaximized={() => toggleMaximized(key)}
            place={place}
            state={state}
          />
        );
      }

      /** T3's "Toggle right panel" in the chat header. */
      function PanelToggle({ target, thread, project }: ChatHeaderActionProps) {
        const route = useExternal(navigation, navigation.current);
        const shortcut = useShortcutLabels(keybindings)("right-panel.toggle");
        const place: RightPanelPlace | undefined =
          thread !== undefined
            ? { target, threadId: thread.id }
            : project !== undefined
              ? { target, projectId: project.id }
              : undefined;
        const here = placeOf(route);
        const pressed =
          place !== undefined &&
          here !== undefined &&
          rightPanelPlaceKey(here) === rightPanelPlaceKey(place) &&
          routeShowsPanel(route);
        return (
          <Tooltip>
            <TooltipTrigger render={<span className="flex shrink-0" />}>
              <Toggle
                aria-label="Toggle right panel"
                className="shrink-0"
                data-right-panel-toggle=""
                disabled={place === undefined}
                onPressedChange={() => {
                  if (place !== undefined) toggle(place);
                }}
                pressed={pressed}
                size="sm"
                variant="ghost"
              >
                <PanelRightIcon className="size-4" />
              </Toggle>
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {place === undefined
                ? "Right panel is unavailable"
                : `Toggle right panel${shortcut ? ` (${shortcut})` : ""}`}
            </TooltipPopup>
          </Tooltip>
        );
      }

      context.subscriptions.add(
        slots.contribute("app.panel", { id: "jhin.right-panel.panel", component: Panel }),
      );
      context.subscriptions.add(
        slots.contribute<ChatHeaderActionProps>("chat.header.actions", {
          id: "jhin.right-panel.toggle",
          // After the other actions, as T3's right panel toggle ends the header.
          order: 100,
          component: PanelToggle,
        }),
      );
    },
  }),
);
