// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/ThreadNotificationCoordinator.tsx,
// apps/web/src/threadNotifications.ts and components/settings/NotificationSettings.tsx.
import {
  CONNECTIONS_CAPABILITY,
  MESH_CAPABILITY,
  NAVIGATION_CAPABILITY,
  NOTIFICATIONS_CAPABILITY,
  SETTINGS_CAPABILITY,
  THREADS_CAPABILITY,
  targetKey,
  type Connections,
  type DeviceSettings,
  type MeshMembership,
  type Navigation,
  type NodeTarget,
  type ThreadNotifications,
  type ThreadRecord,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { definePlugin, toDisposable, z, type Disposable } from "@jhin/sdk";
import {
  UI_SETTINGS_CAPABILITY,
  UI_TOASTS_CAPABILITY,
  type SettingsPages,
  type Toasts,
} from "@jhin/ui";
import {
  BellIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";

import { builtin } from "../lib/builtin.ts";
import { ChunkFailed, lazyChunk } from "../lib/lazy-chunk.tsx";

/** The `jhin.notifications` settings section. */
export const NOTIFICATIONS_SECTION = "jhin.notifications";
const SECTION = NOTIFICATIONS_SECTION;
const NotificationSettings = z.object({
  /** System notifications and/or a sound when a thread needs you while this page is in the background. */
  mode: z.enum(["off", "notifications", "sound", "notifications-and-sound"]).default("off"),
  /** A toast when another thread finishes, fails or needs you while this page has focus. */
  inApp: z.boolean().default(true),
});
export type NotificationSettings = z.output<typeof NotificationSettings>;

type Kind = "completion" | "approval" | "input" | "failed";

const TITLES: Record<Kind, string> = {
  completion: "Thread completed",
  approval: "Approval needed",
  input: "Input needed",
  failed: "Thread failed",
};

/**
 * Whether a thread's changes are told to the user at all: not an archived one,
 * nor a delegated task's, which tells its parent instead, as in T3 (D865).
 */
export function notifiesUser(thread: ThreadRecord): boolean {
  return thread.archivedAt === undefined && thread.relationshipToParent !== "subagent";
}

/** What changed about a thread that the user should hear about, if anything. */
export function notificationKind(
  previous: ThreadRecord["lastTurn"] | undefined,
  next: ThreadRecord["lastTurn"] | undefined,
): Kind | undefined {
  if (next === undefined) return undefined;
  if (
    previous !== undefined &&
    previous.turnId === next.turnId &&
    previous.status === next.status &&
    previous.waitingFor === next.waitingFor
  ) {
    return undefined;
  }
  switch (next.status) {
    case "completed":
      return "completion";
    case "failed":
      return "failed";
    case "waiting":
      return next.waitingFor === "user-input" ? "input" : "approval";
    default:
      return undefined;
  }
}

let audio: AudioContext | undefined;
/** A short chime made on the spot: two notes for a completion, one for anything else. */
function playSound(kind: Kind) {
  try {
    audio ??= new AudioContext();
    const notes = kind === "completion" ? [660, 880] : [520];
    notes.forEach((frequency, index) => {
      const oscillator = audio!.createOscillator();
      const gain = audio!.createGain();
      const start = audio!.currentTime + index * 0.12;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.15, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.25);
      oscillator.connect(gain).connect(audio!.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.3);
    });
  } catch {
    // No audio here (or not allowed yet): stay silent.
  }
}

export const notificationsPlugin = builtin(
  "jhin.notifications",
  {
    provides: { [NOTIFICATIONS_CAPABILITY]: "1.0.0" },
    requires: {
      [CONNECTIONS_CAPABILITY]: "^1",
      [MESH_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [SETTINGS_CAPABILITY]: "^1",
    },
    optional: { [UI_TOASTS_CAPABILITY]: "^1", [UI_SETTINGS_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      context.config.define(SECTION, NotificationSettings);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const mesh = context.services.get<MeshMembership>(MESH_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const deviceSettings = context.services.get<DeviceSettings>(SETTINGS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      const pages = context.services.tryGet<SettingsPages>(UI_SETTINGS_CAPABILITY);

      const settings = () => {
        try {
          return context.config.get<NotificationSettings>(SECTION);
        } catch {
          return NotificationSettings.parse({});
        }
      };
      const focused = () => document.visibilityState === "visible" && document.hasFocus();
      const shown = new Map<string, Notification>();
      const baseTitle = document.title;
      const countListeners = new Set<() => void>();
      const updateBadge = () => {
        document.title = shown.size === 0 ? baseTitle : `(${shown.size}) ${baseTitle}`;
        for (const listener of Array.from(countListeners)) listener();
      };
      const shownNotifications: ThreadNotifications = {
        count: () => shown.size,
        subscribe(listener) {
          countListeners.add(listener);
          return toDisposable(() => countListeners.delete(listener));
        },
      };
      context.services.provide(NOTIFICATIONS_CAPABILITY, shownNotifications);
      const clearAll = () => {
        for (const notification of shown.values()) notification.close();
        shown.clear();
        updateBadge();
      };
      window.addEventListener("focus", clearAll);
      context.subscriptions.add({ dispose: () => window.removeEventListener("focus", clearAll) });

      const open = (target: NodeTarget, threadId: string) =>
        navigation.navigate({
          node: target.node,
          ...(target.remote === undefined ? {} : { remote: target.remote }),
          thread: threadId,
        });

      const notify = (target: NodeTarget, thread: ThreadRecord, kind: Kind) => {
        const { mode, inApp } = settings();
        const route = navigation.current();
        const isOpen =
          route.thread === thread.id &&
          route.node === target.node &&
          route.remote === target.remote;
        if (focused()) {
          if (!inApp || isOpen) return;
          const Icon =
            kind === "completion"
              ? CircleCheckIcon
              : kind === "failed"
                ? CircleAlertIcon
                : kind === "approval"
                  ? ShieldQuestionIcon
                  : MessageCircleQuestionIcon;
          toasts?.show({
            type: kind === "completion" ? "success" : kind === "failed" ? "error" : "warning",
            title: TITLES[kind],
            description: thread.title,
            data: { hideCopyButton: true, leadingIcon: <Icon className="size-4" /> },
            action: { label: "Open thread", onClick: () => open(target, thread.id) },
          });
          return;
        }
        if (mode === "sound" || mode === "notifications-and-sound") playSound(kind);
        if (
          (mode === "notifications" || mode === "notifications-and-sound") &&
          typeof Notification !== "undefined" &&
          Notification.permission === "granted"
        ) {
          const tag = `${targetKey(target)}:${thread.id}`;
          shown.get(tag)?.close();
          const notification = new Notification(TITLES[kind], {
            body: thread.title,
            tag,
            silent: true,
          });
          notification.addEventListener("click", () => {
            notification.close();
            shown.delete(tag);
            updateBadge();
            window.focus();
            open(target, thread.id);
          });
          shown.set(tag, notification);
          updateBadge();
        }
      };

      /** The last turn of every thread seen so far, per target; first sight is the baseline. */
      const seen = new Map<string, Map<string, ThreadRecord["lastTurn"]>>();
      const watchers = new Map<string, Disposable>();
      const watch = (target: NodeTarget) => {
        const key = targetKey(target);
        if (watchers.has(key)) return;
        const check = () => {
          const catalog = threads.catalog(target);
          if (catalog.status !== "ready") return;
          const last = seen.get(key);
          const first = last === undefined;
          // Rebuilt from the catalog each time, so deleted threads leave it.
          const next = new Map<string, ThreadRecord["lastTurn"]>();
          for (const thread of catalog.threads) {
            const previous = last?.get(thread.id);
            const known = last?.has(thread.id) === true;
            next.set(thread.id, thread.lastTurn);
            if (first || !known || !notifiesUser(thread)) continue;
            const kind = notificationKind(previous, thread.lastTurn);
            if (kind !== undefined) notify(target, thread, kind);
          }
          seen.set(key, next);
        };
        watchers.set(key, threads.subscribe(target, check));
        check();
      };
      /** Watches every node reached now, and stops watching the ones gone. */
      const sync = () => {
        const targets: NodeTarget[] = [];
        for (const node of connections.list()) {
          targets.push({ node: node.id });
          for (const member of mesh.members(node.id) ?? []) {
            if (!member.self && member.reachable)
              targets.push({ node: node.id, remote: member.nodeId });
          }
        }
        const keys = new Set(targets.map(targetKey));
        for (const [key, watcher] of watchers) {
          if (keys.has(key)) continue;
          watcher.dispose();
          watchers.delete(key);
          seen.delete(key);
        }
        for (const target of targets) watch(target);
      };
      const meshWatchers = new Map<string, Disposable>();
      const syncMesh = () => {
        const ids = new Set(connections.list().map((node) => node.id));
        for (const [id, watcher] of meshWatchers) {
          if (ids.has(id)) continue;
          watcher.dispose();
          meshWatchers.delete(id);
        }
        for (const id of ids) {
          if (!meshWatchers.has(id)) meshWatchers.set(id, mesh.subscribe(id, sync));
        }
        sync();
      };
      context.subscriptions.add(connections.subscribe(syncMesh));
      syncMesh();
      context.subscriptions.add({
        dispose() {
          for (const watcher of [...watchers.values(), ...meshWatchers.values()]) watcher.dispose();
          watchers.clear();
          meshWatchers.clear();
          clearAll();
        },
      });

      // The settings section is a chunk of its own, loaded when it first opens (D440, D1041).
      const NotificationsSettings = lazyChunk(
        () =>
          import("./notifications-settings.tsx").then((module) =>
            module.createNotificationsSettings(context, deviceSettings, playSound),
          ),
        {
          loading: () => null,
          failed: (_props, retry) => (
            <ChunkFailed retry={retry}>Couldn't load this section.</ChunkFailed>
          ),
        },
      );

      if (pages !== undefined) {
        context.subscriptions.add(
          pages.addSection({
            id: "notifications",
            label: "Notifications",
            icon: BellIcon,
            order: 20,
            component: NotificationsSettings,
          }),
        );
      }
    },
  }),
);
