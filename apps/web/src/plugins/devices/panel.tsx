// The Device panel follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/
// device/DevicePanel.tsx (the device groups, rows, their actions and empty states, booting and
// error texts) and DeviceWorkspace.tsx ("Power off device", "Close device panel").
import {
  DeviceEvents,
  deviceStream,
  type DeviceHostStatus,
  type DeviceHubAccessResult,
  type DeviceState,
  type DeviceSummary,
} from "@jhin/preview-api";
import type { RpcClient } from "@jhin/rpc";
import { Button, Spinner, cn } from "@jhin/ui";
import { PowerIcon, RefreshCwIcon, SmartphoneIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { httpBase } from "../../lib/session.ts";
import { DeviceStreamView } from "./stream-view.tsx";
import type { DeviceHubAccess } from "./stream.ts";

export interface DevicePanelProps {
  readonly client: RpcClient;
  /** The node's RPC URL: its device hub is under the same host (D1208). */
  readonly nodeUrl: string;
  readonly threadId: string;
  readonly state: DeviceState | undefined;
  readonly call: (method: string, params: unknown) => Promise<unknown>;
  readonly onError: (title: string, error: unknown) => void;
  readonly onClose: () => void;
}

/** A device's newest screen from its stream, while the panel shows it. */
function DeviceScreen(props: { client: RpcClient; device: DeviceSummary }) {
  const [screen, setScreen] = useState<string | undefined>(undefined);
  useEffect(() => {
    const subscription = props.client.subscribe(
      deviceStream(props.device.hostId, props.device.id),
      { after: 0 },
      (event) => {
        if (event.type !== DeviceEvents.screen) return;
        const data = (event.payload as { data?: unknown } | null)?.data;
        if (typeof data === "string") setScreen(`data:image/png;base64,${data}`);
      },
    );
    return () => subscription.dispose();
  }, [props.client, props.device.hostId, props.device.id]);
  if (screen === undefined) {
    return (
      <div
        className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground"
        role="status"
      >
        <Spinner className="size-3.5" />
        Connecting video…
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4">
      <img
        alt={`${props.device.name} screen`}
        className="max-h-full max-w-full rounded-[1.5rem] border border-border object-contain shadow-sm"
        src={screen}
      />
    </div>
  );
}

/** Where the hub is on the node behind `nodeUrl`, with the ticket every URL carries. */
function hubAccess(nodeUrl: string, result: DeviceHubAccessResult): DeviceHubAccess {
  const http = `${httpBase(nodeUrl)}${result.path}`;
  return {
    httpBase: http,
    wsBase: http.replace(/^http/, "ws"),
    query: result.query,
    socketQuery: result.socketQuery,
    credentials: false,
  };
}

/**
 * An open device: the hub's live video and input (D1208), else D408's screenshots while the
 * hub installs or when it cannot run on the node.
 */
function OpenDevice(props: {
  client: RpcClient;
  nodeUrl: string;
  device: DeviceSummary;
  hostStatus: DeviceHostStatus | undefined;
  call: (method: string, params: unknown) => Promise<unknown>;
}) {
  const { device, nodeUrl } = props;
  // The panel's `call` is a new function each render; the request must not follow it.
  const call = useRef(props.call);
  call.current = props.call;
  const [access, setAccess] = useState<DeviceHubAccess | undefined>(undefined);
  const [reason, setReason] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  /** Tickets refused since the stream last showed video. */
  const refusals = useRef(0);
  // A hub that comes up after the first request timed out is asked again.
  const ready = props.hostStatus?.status === "ready";
  useEffect(() => {
    let current = true;
    void call.current("device.hub.access", { hostId: device.hostId }).then(
      (result) => {
        if (!current) return;
        setAccess(hubAccess(nodeUrl, result as DeviceHubAccessResult));
        setReason(undefined);
      },
      (error: unknown) => {
        if (!current) return;
        setAccess(undefined);
        setReason(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      current = false;
    };
  }, [nodeUrl, device.hostId, device.id, attempt, ready]);

  if (access !== undefined) {
    return (
      <div className="flex min-h-0 flex-1">
        <DeviceStreamView
          access={access}
          deviceDescription={device.version}
          deviceId={device.id}
          deviceName={device.name}
          onStreaming={() => {
            refusals.current = 0;
          }}
          onUnauthorized={() => {
            setAccess(undefined);
            // An expired ticket is renewed; one refused again and again (a client that may
            // watch but not control) stops, and the screenshots stay.
            refusals.current += 1;
            if (refusals.current > 2) {
              setReason(
                "The device hub refused this client: watching a device's video needs devices.read and devices.write.",
              );
              return;
            }
            setAttempt((count) => count + 1);
          }}
          platform={device.platform}
        />
      </div>
    );
  }
  const installing =
    props.hostStatus?.status === "installing" || props.hostStatus?.status === "starting";
  const note = installing ? props.hostStatus?.detail : reason;
  return (
    <>
      <DeviceScreen client={props.client} device={device} />
      {note === undefined ? null : (
        <p className="shrink-0 px-3 pb-3 text-center text-xs text-muted-foreground" role="note">
          {note}
        </p>
      )}
    </>
  );
}

function DeviceRow(props: {
  device: DeviceSummary;
  label: string;
  busy: boolean;
  onOpen: () => void;
}) {
  const { device } = props;
  return (
    <li className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent/60">
      <SmartphoneIcon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{device.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {`${props.label} · ${device.version} · ${device.booted ? "Running" : "Stopped"}`}
        </div>
      </div>
      <Button disabled={props.busy} onClick={props.onOpen} size="xs" variant="outline">
        {device.booted ? "Open" : "Start"}
      </Button>
    </li>
  );
}

export function DevicePanel(props: DevicePanelProps) {
  const { state, threadId } = props;
  const [refreshing, setRefreshing] = useState(false);
  const [opening, setOpening] = useState<string | undefined>(undefined);
  const session = state?.sessions.findLast((each) => each.threadId === threadId);
  const open =
    session === undefined ? undefined : state?.devices.find((each) => each.id === session.deviceId);
  const host = state?.hosts[0];
  const booting = (state?.booting ?? []).filter((each) => each.threadId === threadId);

  const refresh = () => {
    setRefreshing(true);
    void props
      .call("device.list", { threadId })
      .catch((error: unknown) => props.onError("Couldn't refresh devices", error))
      .finally(() => setRefreshing(false));
  };
  const openDevice = (device: DeviceSummary) => {
    setOpening(device.id);
    void props
      .call("device.open", { threadId, deviceId: device.id })
      .catch((error: unknown) => props.onError("Couldn't open the device", error))
      .finally(() => setOpening(undefined));
  };

  const header = (
    <div className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 border-b border-border/60 px-3">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {open === undefined ? "Devices" : open.name}
      </span>
      {open === undefined ? (
        <Button
          aria-label="Refresh devices"
          disabled={refreshing}
          onClick={refresh}
          size="icon-xs"
          variant="ghost"
        >
          <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
        </Button>
      ) : (
        <Button
          aria-label="Power off device"
          onClick={() =>
            void props
              .call("device.close", { threadId, deviceId: open.id, shutdown: true })
              .catch((error: unknown) => props.onError("Couldn't power off the device", error))
          }
          size="icon-xs"
          variant="ghost"
        >
          <PowerIcon className="size-3.5" />
        </Button>
      )}
      <Button
        aria-label="Close device panel"
        onClick={props.onClose}
        size="icon-xs"
        variant="ghost"
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );

  if (open !== undefined) {
    return (
      <>
        {header}
        <OpenDevice
          call={props.call}
          client={props.client}
          device={open}
          hostStatus={state?.hostStatuses?.[open.hostId]}
          nodeUrl={props.nodeUrl}
        />
      </>
    );
  }

  const groups = [
    { platform: "ios" as const, title: "iOS Simulators" },
    { platform: "android" as const, title: "Android Emulators" },
  ];
  const devices = state?.devices ?? [];
  return (
    <>
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {booting.length > 0 ? (
          <p className="mb-3 flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Spinner className="size-3.5" />
            {`Starting ${booting.map((each) => devices.find((device) => device.id === each.deviceId)?.name ?? each.deviceId).join(", ")}… This can take a minute.`}
          </p>
        ) : null}
        {state === undefined ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Spinner className="size-3.5" />
            Finding devices…
          </p>
        ) : devices.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No simulators or emulators were found on this environment.
          </p>
        ) : null}
        {groups.map((group) => {
          const available = host?.platforms.find((each) => each.platform === group.platform);
          const members = devices
            .filter((device) => device.platform === group.platform)
            .toSorted(
              (a, b) => Number(b.booted) - Number(a.booted) || a.name.localeCompare(b.name),
            );
          if (
            members.length === 0 &&
            available?.available !== true &&
            available?.reason === undefined
          ) {
            return null;
          }
          return (
            <section aria-label={group.title} className="mb-4" key={group.platform}>
              <h2 className="mb-1 px-2 text-xs font-medium text-muted-foreground">{group.title}</h2>
              {available?.available === false ? (
                <p className="px-2 text-xs text-muted-foreground">{available.reason}</p>
              ) : members.length === 0 && group.platform === "android" ? (
                <p className="px-2 text-xs text-muted-foreground">
                  No Android virtual devices found. Create one in Android Studio's Device Manager,
                  then refresh.
                </p>
              ) : (
                <ul>
                  {members.map((device) => (
                    <DeviceRow
                      busy={opening !== undefined}
                      device={device}
                      key={device.id}
                      label={host?.label ?? "This node"}
                      onOpen={() => openDevice(device)}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

export type { DeviceState };
