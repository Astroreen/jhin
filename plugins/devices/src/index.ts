// The tools' descriptions, how a device is chosen and the errors' wording follow T3 Code (MIT,
// see THIRD_PARTY_NOTICES.md): apps/server/src/mcp/toolkits/device/tools.ts and handlers.ts, and
// apps/server/src/device/DeviceService.ts (sessions per thread, booting, closing).
import { THREADS_STREAM, ThreadEvents } from "@jhin/agent-api";
import {
  DEVICES_STREAM,
  DEVICE_HOSTS_CAPABILITY,
  DEVICE_STREAM_PREFIX,
  DeviceCloseInput,
  DeviceError,
  DeviceEvents,
  DeviceListInput,
  DeviceListResult,
  DeviceOpenInput,
  DeviceOpenResult,
  DeviceScreenshotResult,
  DeviceTargetInput,
  LOCAL_DEVICE_HOST_ID,
  pngSize,
  type DeviceSession,
  type DeviceState,
  type DeviceSummary,
} from "@jhin/preview-api";
import {
  LIVE_STREAMS_CAPABILITY,
  createMemoryStreams,
  type LiveStreams,
  type StreamSource,
} from "@jhin/rpc";
import { definePlugin, toDisposable, z } from "@jhin/sdk";
import { EVENTLOG_CAPABILITY, type EventLog, type Json } from "@jhin/storage-api";

import { createLocalHost } from "./hosts.ts";

const CONFIG_SECTION = "jhin.devices";
/** A watched device's screen is taken again this long after the last one. */
const SCREEN_EVERY_MS = 500;

const Path = z.string().min(1).optional();
const Config = z
  .object({
    androidSdk: Path.meta({
      title: "Android SDK",
      description: "Where the Android SDK is; ANDROID_HOME or the usual folders when unset.",
    }),
    adb: Path.meta({ title: "adb", description: "The adb to run instead of the SDK's." }),
    emulator: Path.meta({
      title: "emulator",
      description: "The Android emulator to run instead of the SDK's.",
    }),
    xcrun: Path.meta({ title: "xcrun", description: "The xcrun to run instead of Xcode's." }),
  })
  .meta({
    title: "Devices",
    description:
      "iOS Simulators and Android Emulators of this node, for agents and the Device panel.",
  });
type Config = z.output<typeof Config>;

export default definePlugin({
  activate(context) {
    context.config.define(CONFIG_SECTION, Config);
    const live = context.services.tryGet<LiveStreams>(LIVE_STREAMS_CAPABILITY);
    const log = context.services.tryGet<EventLog>(EVENTLOG_CAPABILITY);
    const streams = createMemoryStreams({ log: context.log });
    const host = createLocalHost(() => context.config.get<Config>(CONFIG_SECTION));
    const now = () => new Date().toISOString();

    // Kept in the plugin's state, so a reload keeps each thread's open devices (rule 5).
    let devices: DeviceSummary[] = [];
    let detail: string | undefined;
    let sessions: DeviceSession[] = context.state.get<DeviceSession[]>("sessions") ?? [];
    let booting: DeviceState["booting"] = [];
    const keepSessions = (next: DeviceSession[]) => {
      sessions = next;
      context.state.set("sessions", next);
    };
    /** Boots in flight, so two opens of one stopped device start it once. */
    const boots = new Map<string, Promise<DeviceSummary>>();
    /** A device by id, or a running emulator by its AVD name. */
    const byId = (list: readonly DeviceSummary[], id: string) =>
      list.find((device) => device.id === id) ??
      list.find((device) => device.platform === "android" && device.booted && device.name === id);
    const lifetime = { disposed: false };

    const state = (): DeviceState => ({
      hosts: [host.summary()],
      devices,
      sessions,
      booting,
      ...(detail === undefined ? {} : { detail }),
    });
    const publish = () => {
      streams.clear(DEVICES_STREAM);
      streams.append(DEVICES_STREAM, DeviceEvents.state, { state: state() as unknown as Json });
    };
    const refresh = async () => {
      const listed = await host.list();
      devices = listed.devices;
      detail = listed.detail;
      publish();
      return listed.devices;
    };
    context.services.provide(DEVICE_HOSTS_CAPABILITY, { state, refresh });

    /** The device a command means: named, else the thread's latest, as T3 picks. */
    const target = async (input: { threadId: string; deviceId?: string | undefined }) => {
      const id =
        input.deviceId ??
        sessions.findLast((session) => session.threadId === input.threadId)?.deviceId;
      if (id === undefined) {
        throw new DeviceError(
          "DEVICE_NOT_FOUND",
          "No device is open in this thread. Call device_open first.",
        );
      }
      const known =
        devices.find((device) => device.id === id) ??
        (await refresh()).find((device) => device.id === id);
      if (known === undefined) {
        throw new DeviceError(
          "DEVICE_NOT_FOUND",
          `No device ${id} on host ${LOCAL_DEVICE_HOST_ID}. Call device_list for current ids.`,
        );
      }
      return known;
    };

    // --- A device's screen while somebody watches ------------------------------------------
    const watchers = new Map<string, number>();
    /** One capture loop per device at most. */
    const loops = new Map<string, Promise<void>>();
    // Neither simctl nor adb tells when a screen changes, so a watched device's screen is
    // taken again after each one (no two at once), until nobody watches it.
    const capture = async (deviceId: string) => {
      const stream = `${DEVICE_STREAM_PREFIX}${LOCAL_DEVICE_HOST_ID}/${encodeURIComponent(deviceId)}`;
      while (!lifetime.disposed && (watchers.get(deviceId) ?? 0) > 0) {
        const device = byId(devices, deviceId);
        if (device !== undefined && device.booted) {
          try {
            const png = await host.screenshot(device);
            streams.clear(stream);
            streams.append(stream, DeviceEvents.screen, {
              data: png.toString("base64"),
              ...pngSize(png),
            });
          } catch (error) {
            // A failed screenshot (the device restarting) is tried again with the next one.
            context.log.debug("device screen not taken", { deviceId, error: String(error) });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, SCREEN_EVERY_MS));
      }
    };
    const startCapture = (deviceId: string) => {
      if (loops.has(deviceId)) return;
      const loop = capture(deviceId).finally(() => loops.delete(deviceId));
      loops.set(deviceId, loop);
    };

    if (live === undefined) {
      context.log.warn("no rpc.streams@1: clients see no device list or screens");
    } else {
      const read = { permissions: ["devices.read"] };
      const watched: StreamSource = {
        head: (stream) => streams.head(stream),
        read: (stream, options) => streams.read(stream, options),
        subscribe(stream, listener) {
          const subscription = streams.subscribe(stream, listener);
          if (!stream.startsWith(DEVICE_STREAM_PREFIX)) return subscription;
          const deviceId = decodeURIComponent(stream.split("/")[2] ?? "");
          const before = watchers.get(deviceId) ?? 0;
          watchers.set(deviceId, before + 1);
          if (before === 0) startCapture(deviceId);
          let watching = true;
          return toDisposable(() => {
            subscription.dispose();
            if (!watching) return;
            watching = false;
            watchers.set(deviceId, Math.max(0, (watchers.get(deviceId) ?? 1) - 1));
          });
        },
      };
      context.subscriptions.add(live.serve(DEVICES_STREAM, watched, read));
      context.subscriptions.add(live.serve(DEVICE_STREAM_PREFIX, watched, read));
    }
    context.onDeactivate(() => {
      lifetime.disposed = true;
    });

    // A deleted thread's devices leave its panel (they keep running).
    if (log !== undefined) {
      context.subscriptions.add(
        log.subscribe(THREADS_STREAM, (event) => {
          if (event.type !== ThreadEvents.threadDeleted) return;
          const threadId = (event.payload as { id?: unknown } | null)?.id;
          if (typeof threadId !== "string") return;
          keepSessions(sessions.filter((session) => session.threadId !== threadId));
          publish();
        }),
      );
    }
    void refresh().catch((error: unknown) =>
      context.log.warn("devices not listed", { error: String(error) }),
    );

    context.commands.register({
      name: "device.list",
      title: "List devices",
      description:
        "List iOS Simulators and Android Emulators on this node's device hosts, which platforms each host can run, and which devices are already open in this thread's Device panel. Call this before device_open when you do not know a device id.",
      input: DeviceListInput,
      output: DeviceListResult,
      permissions: ["devices.read"],
      handler: async (input) => {
        const listed = await refresh();
        return {
          hosts: [host.summary()],
          devices: listed,
          open: sessions
            .filter(
              (session) => input.threadId === undefined || session.threadId === input.threadId,
            )
            .map((session) => ({ hostId: session.hostId, deviceId: session.deviceId })),
        };
      },
    });

    context.commands.register({
      name: "device.open",
      title: "Open device",
      description:
        "Open a simulator or emulator for this thread: boots it if needed and shows it in the user's Device panel so they can watch. Returns the command pinned to the device; drive the device with it afterwards.",
      input: DeviceOpenInput,
      output: DeviceOpenResult,
      permissions: ["devices.write"],
      handler: async (input) => {
        const summary = host.summary();
        const listed = await refresh();
        let device: DeviceSummary | undefined;
        if (input.deviceId !== undefined) {
          device = byId(listed, input.deviceId);
          if (device === undefined) {
            throw new DeviceError(
              "DEVICE_NOT_FOUND",
              `No device ${input.deviceId} on host ${LOCAL_DEVICE_HOST_ID}. Call device_list for current ids.`,
            );
          }
        } else {
          const available = summary.platforms.filter((platform) => platform.available);
          if (input.platform === undefined && available.length > 1) {
            throw new DeviceError(
              "DEVICE_PLATFORM_UNAVAILABLE",
              "Both iOS and Android devices are available; pass platform or deviceId.",
            );
          }
          const candidates = listed.filter(
            (each) => input.platform === undefined || each.platform === input.platform,
          );
          device = candidates.find((each) => each.booted) ?? candidates[0];
          if (device === undefined) {
            throw new DeviceError(
              "DEVICE_NOT_FOUND",
              input.platform === undefined
                ? "No simulators or emulators were found. Call device_list to see why."
                : `No ${input.platform} devices were found on host ${LOCAL_DEVICE_HOST_ID}. Call device_list to see why.`,
            );
          }
        }
        const chosen: DeviceSummary = device;
        const platform = summary.platforms.find((each) => each.platform === chosen.platform);
        if (platform?.available !== true) {
          throw new DeviceError(
            "DEVICE_PLATFORM_UNAVAILABLE",
            `${chosen.platform} devices are unavailable on host ${LOCAL_DEVICE_HOST_ID}: ${platform?.reason ?? "unknown"}`,
          );
        }
        if (!device.booted) {
          const starting = {
            hostId: LOCAL_DEVICE_HOST_ID,
            deviceId: device.id,
            threadId: input.threadId,
          };
          booting = [...booting, starting];
          publish();
          const stopped = device;
          const boot = boots.get(stopped.id) ?? host.boot(stopped);
          boots.set(stopped.id, boot);
          try {
            device = await boot;
          } finally {
            boots.delete(stopped.id);
            booting = booting.filter((each) => each !== starting);
          }
          await refresh();
        }
        const opened = device;
        keepSessions([
          ...sessions.filter(
            (session) => !(session.threadId === input.threadId && session.deviceId === opened.id),
          ),
          {
            threadId: input.threadId,
            hostId: LOCAL_DEVICE_HOST_ID,
            deviceId: opened.id,
            platform: opened.platform,
            openedAt: now(),
          },
        ]);
        publish();
        const control = host.control(opened);
        return {
          device: opened,
          control: { command: control.command, targetArgs: control.targetArgs },
          quickStart: control.quickStart,
        };
      },
    });

    context.commands.register({
      name: "device.screenshot",
      title: "Screenshot device",
      description:
        "Capture the current screen of an open device as a PNG image. Use it to see what the user sees.",
      input: DeviceTargetInput,
      output: DeviceScreenshotResult,
      permissions: ["devices.read"],
      handler: async (input) => {
        const device = await target(input);
        const png = await host.screenshot(device);
        return {
          device,
          screenshot: {
            mimeType: "image/png" as const,
            data: png.toString("base64"),
            ...pngSize(png),
          },
        };
      },
    });

    context.commands.register({
      name: "device.close",
      title: "Close device",
      description:
        "Remove a device from this thread's Device panel. Pass shutdown=true to also power the simulator or emulator off.",
      input: DeviceCloseInput,
      output: z.object({}),
      permissions: ["devices.write"],
      handler: async (input) => {
        const closing = sessions.filter(
          (session) =>
            session.threadId === input.threadId &&
            (input.deviceId === undefined || session.deviceId === input.deviceId),
        );
        keepSessions(sessions.filter((session) => !closing.includes(session)));
        publish();
        if (input.shutdown === true) {
          const ids =
            input.deviceId === undefined ? closing.map((each) => each.deviceId) : [input.deviceId];
          for (const id of ids) {
            const device = devices.find((each) => each.id === id);
            if (device !== undefined) await host.shutdown(device);
          }
          await refresh();
        }
        return {};
      },
    });
  },
});
