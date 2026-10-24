import {
  CONNECTIONS_CAPABILITY,
  NAVIGATION_CAPABILITY,
  RIGHT_PANEL_CAPABILITY,
  THREADS_CAPABILITY,
  type ChatHeaderActionProps,
  type Connections,
  type Navigation,
  type RightPanel,
  type RightPanelSurfaceProps,
  type ThreadsCatalog,
} from "@jhin/client-api";
import { DEVICES_STREAM, DeviceEvents, type DeviceState } from "@jhin/preview-api";
import type { RpcClient } from "@jhin/rpc";
import { definePlugin, toDisposable, type Disposable } from "@jhin/sdk";
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
import { SmartphoneIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { builtin } from "../../lib/builtin.ts";
import { useExternal } from "../../lib/hooks.ts";
import { ChunkFailed, lazyChunk } from "../../lib/lazy-chunk.tsx";
import type { DevicePanelProps } from "./panel.tsx";

/** The route's `panel` while the Device panel shows. */
const DEVICE_PANEL = "devices";

function PanelShell(props: { children?: ReactNode; embedded?: boolean }) {
  // A surface of the right panel (t3-parity.md D1424) fills it below its strip.
  if (props.embedded === true) {
    return (
      <section aria-label="Device panel" className="flex min-h-0 flex-1 flex-col">
        {props.children}
      </section>
    );
  }
  return (
    <aside
      aria-label="Device panel"
      className="flex h-full w-[420px] max-w-[60vw] shrink-0 flex-col border-l border-border bg-background"
    >
      {props.children}
    </aside>
  );
}

// A chunk of its own, loaded when the panel first opens (D440).
const DevicePanel = lazyChunk<DevicePanelProps>(
  () => import("./panel.tsx").then((module) => module.DevicePanel),
  {
    loading: () => null,
    failed: (_props, retry) => (
      <ChunkFailed retry={retry}>Couldn't load the Device panel.</ChunkFailed>
    ),
  },
);

/** Each connected node's device state, from its `devices` stream while somebody listens. */
function createDeviceStates(connections: Connections) {
  interface Feed {
    state: DeviceState | undefined;
    readonly listeners: Set<() => void>;
    client: RpcClient | undefined;
    stop: Disposable | undefined;
  }
  const feeds = new Map<string, Feed>();
  const follow = (id: string, feed: Feed) => {
    const client = feed.listeners.size === 0 ? undefined : connections.get(id)?.client;
    if (client === feed.client) return;
    feed.stop?.dispose();
    feed.stop = undefined;
    feed.client = client;
    if (client === undefined) return;
    feed.stop = client.subscribe(DEVICES_STREAM, { after: 0 }, (event) => {
      if (event.type !== DeviceEvents.state) return;
      feed.state = (event.payload as { state?: DeviceState } | null)?.state;
      for (const listener of Array.from(feed.listeners)) listener();
    });
  };
  const watching = connections.subscribe(() => {
    for (const [id, feed] of feeds) follow(id, feed);
  });
  const of = (id: string): Feed => {
    let feed = feeds.get(id);
    if (feed === undefined) {
      feed = { state: undefined, listeners: new Set(), client: undefined, stop: undefined };
      feeds.set(id, feed);
    }
    return feed;
  };
  return {
    state: (id: string) => of(id).state,
    subscribe(id: string, listener: () => void): Disposable {
      const feed = of(id);
      feed.listeners.add(listener);
      follow(id, feed);
      return toDisposable(() => {
        feed.listeners.delete(listener);
        follow(id, feed);
      });
    },
    dispose() {
      watching.dispose();
      for (const feed of feeds.values()) feed.stop?.dispose();
      feeds.clear();
    },
  };
}

/**
 * `jhin.device-panel`: the node's simulators and emulators beside the chat
 * (docs/plans/preview.md, D408): the `app.panel` `jhin.device.panel`, the
 * chat header's `jhin.device.toggle`, and `jhin.device.reveal`, which brings
 * the panel up when an agent opens a device for the thread.
 */
export const devicePanelPlugin = builtin(
  "jhin.device-panel",
  {
    requires: {
      [UI_SLOTS_CAPABILITY]: "^1",
      [CONNECTIONS_CAPABILITY]: "^1",
      [NAVIGATION_CAPABILITY]: "^1",
      [THREADS_CAPABILITY]: "^1",
    },
    optional: { [UI_TOASTS_CAPABILITY]: "^1", [RIGHT_PANEL_CAPABILITY]: "^1" },
  },
  definePlugin({
    activate(context) {
      const slots = context.services.get<SlotRegistry>(UI_SLOTS_CAPABILITY);
      const connections = context.services.get<Connections>(CONNECTIONS_CAPABILITY);
      const navigation = context.services.get<Navigation>(NAVIGATION_CAPABILITY);
      const threads = context.services.get<ThreadsCatalog>(THREADS_CAPABILITY);
      const toasts = context.services.tryGet<Toasts>(UI_TOASTS_CAPABILITY);
      const rightPanel = context.services.tryGet<RightPanel>(RIGHT_PANEL_CAPABILITY);
      const states = context.subscriptions.add(createDeviceStates(connections));
      const onError = (title: string, error: unknown) =>
        toasts?.show({
          type: "error",
          title,
          description: error instanceof Error ? error.message : String(error),
        });

      // One source per node, so a component keeps one subscription however often it renders.
      const sources = new Map<string, { subscribe(listener: () => void): Disposable }>();
      const sourceOf = (node: string) => {
        let source = sources.get(node);
        if (source === undefined) {
          source = { subscribe: (listener) => states.subscribe(node, listener) };
          sources.set(node, source);
        }
        return source;
      };
      const useState = (node: string) => useExternal(sourceOf(node), () => states.state(node));

      const toggle = () => {
        const route = navigation.current();
        if (route.node === undefined || route.thread === undefined || route.remote !== undefined) {
          return;
        }
        const { panel, section: _section, ...rest } = route;
        navigation.navigate(panel === DEVICE_PANEL ? rest : { ...rest, panel: DEVICE_PANEL });
      };

      function DeviceToggle({ target, thread }: ChatHeaderActionProps) {
        const route = useExternal(navigation, navigation.current);
        const state = useState(target.node);
        // A node without the devices plugin never answers: no toggle there. Beside the right
        // panel, its "Add panel surface" opens the devices (D1424), as T3's header has no toggle.
        if (
          rightPanel !== undefined ||
          thread === undefined ||
          target.remote !== undefined ||
          state === undefined
        ) {
          return null;
        }
        return (
          <Tooltip>
            <TooltipTrigger render={<span className="flex shrink-0" />}>
              <Toggle
                aria-label="Toggle device panel"
                className="shrink-0"
                onPressedChange={toggle}
                pressed={route.panel === DEVICE_PANEL}
                size="sm"
                variant="ghost"
              >
                <SmartphoneIcon className="size-4" />
              </Toggle>
            </TooltipTrigger>
            <TooltipPopup side="bottom">Toggle device panel</TooltipPopup>
          </Tooltip>
        );
      }

      /** By thread: the devices already open, so only one an agent opens brings the panel up. */
      const known =
        context.state.get<Map<string, Set<string>>>("open") ?? new Map<string, Set<string>>();
      context.state.set("open", known);
      function Reveal({ target, thread }: ChatHeaderActionProps) {
        const state = useState(target.node);
        useEffect(() => {
          if (thread === undefined || state === undefined) return;
          const key = `${target.node}|${thread.id}`;
          const open = state.sessions
            .filter((session) => session.threadId === thread.id)
            .map((session) => session.deviceId);
          const seen = known.get(key);
          known.set(key, new Set(open));
          if (seen === undefined || !open.some((id) => !seen.has(id))) return;
          const route = navigation.current();
          if (route.thread === thread.id && route.panel !== DEVICE_PANEL) {
            const { section: _section, ...rest } = route;
            navigation.navigate({ ...rest, panel: DEVICE_PANEL });
          }
        }, [state]);
        return null;
      }

      /** The right panel's `devices` surface (D1424). */
      function DeviceSurface({ place, surface }: RightPanelSurfaceProps) {
        const node = place.target.node;
        const state = useState(node);
        const connection = useExternal(connections, () => connections.get(node));
        if (place.threadId === undefined || place.target.remote !== undefined) return null;
        if (connection === undefined) return null;
        return (
          <PanelShell embedded>
            <DevicePanel
              call={(method, params) => threads.call({ node }, method, params)}
              client={connection.client}
              nodeUrl={connection.url}
              onClose={() => void rightPanel?.close(place, surface.id)}
              onError={onError}
              state={state}
              threadId={place.threadId}
            />
          </PanelShell>
        );
      }

      function Panel() {
        const route = useExternal(navigation, navigation.current);
        const node = route.node;
        const state = useState(node ?? "");
        const connection = useExternal(connections, () =>
          node === undefined ? undefined : connections.get(node),
        );
        if (
          rightPanel !== undefined ||
          route.panel !== DEVICE_PANEL ||
          node === undefined ||
          route.thread === undefined
        ) {
          return null;
        }
        if (route.remote !== undefined || connection === undefined) return null;
        const threadId = route.thread;
        return (
          <PanelShell>
            <DevicePanel
              call={(method, params) => threads.call({ node }, method, params)}
              client={connection.client}
              nodeUrl={connection.url}
              onClose={toggle}
              onError={onError}
              state={state}
              threadId={threadId}
            />
          </PanelShell>
        );
      }

      context.subscriptions.add(
        slots.contribute<ChatHeaderActionProps>("chat.header.actions", {
          id: "jhin.device.toggle",
          component: DeviceToggle,
        }),
      );
      context.subscriptions.add(
        slots.contribute<ChatHeaderActionProps>("chat.header.actions", {
          id: "jhin.device.reveal",
          component: Reveal,
        }),
      );
      context.subscriptions.add(
        slots.contribute("app.panel", { id: "jhin.device.panel", component: Panel }),
      );
      if (rightPanel !== undefined) {
        context.subscriptions.add(
          rightPanel.register({
            id: DEVICE_PANEL,
            title: "Device",
            icon: SmartphoneIcon,
            offer: {
              label: "Device",
              shortcut: "M",
              order: 70,
              // T3's `deviceAvailable`: a thread; here also one on a node this client reaches.
              useAvailability: (place) =>
                place.threadId === undefined
                  ? {
                      available: false,
                      reason: "Devices are only available from a thread.",
                      hint: "Available from a thread.",
                    }
                  : place.target.remote !== undefined
                    ? {
                        available: false,
                        reason:
                          "Devices open on nodes this client connects to; this thread is on another node of the mesh.",
                      }
                    : { available: true },
            },
            component: DeviceSurface,
          }),
        );
      }
    },
  }),
);
