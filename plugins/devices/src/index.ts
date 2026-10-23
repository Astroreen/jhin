// The tools' descriptions, how a device is chosen and the errors' wording follow T3 Code (MIT,
// see THIRD_PARTY_NOTICES.md): apps/server/src/mcp/toolkits/device/tools.ts and handlers.ts, and
// apps/server/src/device/DeviceService.ts (sessions per thread, booting, closing).
import { THREADS_STREAM, ThreadEvents } from "@jhin/agent-api";
import {
  AUTH_VERIFIER_CAPABILITY,
  AuthEvents,
  OWNER_PRINCIPAL_ID,
  type AuthVerifier,
} from "@jhin/auth-api";
import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
import { HTTP_SERVER_CAPABILITY, type HttpServer } from "@jhin/http-api";
import {
  DEVICES_STREAM,
  DEVICE_HOSTS_CAPABILITY,
  DEVICE_STREAM_PREFIX,
  DeviceActionInput,
  DeviceButtonInput,
  DeviceCloseInput,
  DeviceDetail,
  DeviceError,
  DeviceEvents,
  DeviceHubAccessInput,
  DeviceHubAccessResult,
  DeviceInputResult,
  DeviceListInput,
  DeviceListResult,
  DeviceOpenInput,
  DeviceOpenResult,
  DeviceScreenshotResult,
  DeviceSwipeInput,
  DeviceTapInput,
  DeviceTargetInput,
  DeviceTypeInput,
  LOCAL_DEVICE_HOST_ID,
  pngSize,
  type DeviceHostStatus,
  type DeviceInput,
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
import { definePlugin, toDisposable, z, describePermissions } from "@jhin/sdk";
import { EVENTLOG_CAPABILITY, type EventLog, type Json } from "@jhin/storage-api";

import * as Fs from "node:fs";
import * as NodePath from "node:path";

import { readDeviceDetail, runDeviceAction, type ActionHost } from "./actions.ts";
import { createLocalHost } from "./hosts.ts";
import { HUB_SPEC, runProgram, toolEnvironment, toolPaths } from "./toolchain.ts";
import { createDeviceHub } from "./hub.ts";
import { resolveNode } from "./hub-host.ts";
import { createKeyedQueue } from "./keyed-queue.ts";

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
    hub: z.boolean().default(false).meta({
      title: "Device hub",
      description:
        "Off until you turn it on: live video and input through T3's device hub. When on, expo-device-hub and agent-device are installed from npm into Jhin's home the first time a device opens, and npm runs their install scripts as this node's user. Off: a screenshot about twice a second, and input through adb only.",
    }),
    node: Path.meta({
      title: "Node.js",
      description:
        "The node that runs the device hub; this node's own Node.js or node on PATH. Takes effect when the hub next starts.",
      advanced: true,
    }),
    npm: Path.meta({
      title: "npm",
      description:
        "The npm that installs the device hub; npm on PATH when unset. Takes effect with the next install.",
      advanced: true,
    }),
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

    let hubStatus: DeviceHostStatus | undefined;

    const state = (): DeviceState => ({
      hosts: [host.summary()],
      devices,
      sessions,
      booting,
      ...(detail === undefined ? {} : { detail }),
      ...(hubStatus === undefined ? {} : { hostStatuses: { [LOCAL_DEVICE_HOST_ID]: hubStatus } }),
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

    // T3's device hub for live video and input (D1206–D1209); D408's tools stay the fallback.
    const paths = context.services.tryGet<HostPaths>(HOST_PATHS_CAPABILITY);
    const config = () => context.config.get<Config>(CONFIG_SECTION);
    const hub = createDeviceHub({
      home: paths?.home,
      stateDir: paths?.dataDir(context.plugin.id),
      enabled: () => config().hub,
      node: () => config().node,
      npm: () => config().npm,
      androidSdk: () => host.androidSdk(),
      summary: () => host.summary(),
      adbInput: (device, input) => host.input(device, input),
      http: context.services.tryGet<HttpServer>(HTTP_SERVER_CAPABILITY),
      verifier: context.services.tryGet<AuthVerifier>(AUTH_VERIFIER_CAPABILITY),
      onStatus: (next) => {
        hubStatus = next;
        publish();
      },
      log: (message, fields) => context.log.debug(message, fields),
    });
    context.onDeactivate(() => hub.stop());
    // The setting is the consent (D1206): turned off, the hub goes at once.
    context.subscriptions.add(
      context.config.onDidChange(CONFIG_SECTION, () => {
        if (!config().hub) {
          void hub
            .disable()
            .catch((error: unknown) =>
              context.log.warn("device hub not stopped", { error: String(error) }),
            );
        }
      }),
    );
    context.subscriptions.add(
      context.events.on(AuthEvents.tokenRotated, () => hub.revoke(OWNER_PRINCIPAL_ID)),
    );
    context.subscriptions.add(
      context.events.on(AuthEvents.clientRevoked, (payload) => {
        const principal = (payload as { principal?: unknown } | undefined)?.principal;
        if (typeof principal === "string") hub.revoke(principal);
      }),
    );

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

    // The titles of this plugin's permissions (security.md D961).
    describePermissions(context, {
      "devices.read": {
        title: "View devices",
        description: "List simulators and emulators, take screenshots and watch their video.",
      },
      "devices.write": {
        title: "Control devices",
        description: "Open and close simulators and emulators, and tap, swipe and type on them.",
      },
    });
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
        // The Device panel will ask for the hub's video: it starts now (D1207).
        hub.warm();
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
      name: "device.hub.access",
      title: "Connect to device video",
      description:
        "Where a client reaches this node's device hub for live video and input, with a short-lived ticket for its URLs. Starts the hub when it is not running.",
      input: DeviceHubAccessInput,
      output: DeviceHubAccessResult,
      permissions: ["devices.read"],
      handler: (_input, invocation) => {
        // A ticket belongs to a principal, so revoking its token ends it: no caller, no ticket.
        if (invocation.caller === undefined) {
          throw new DeviceError(
            "DEVICE_UNAVAILABLE",
            "device.hub.access issues tickets to a caller; call it over RPC, the CLI or MCP.",
          );
        }
        return hub.access(invocation.caller);
      },
    });

    // --- T3's device tools panel: its settings and actions (D1332) ----------------
    /** The device's programs, and serve-sim's helpers from the installed hub (T3's `helperPaths`). */
    const actionHost = (): ActionHost => {
      const programs = host.programs();
      const serveSim =
        paths === undefined
          ? undefined
          : NodePath.join(
              toolPaths(paths.home, HUB_SPEC).installDir,
              "node_modules",
              "expo-device-hub",
              "vendor",
              "serve-sim",
              "dist",
            );
      const helper = (...parts: string[]) => {
        if (serveSim === undefined) return null;
        const file = NodePath.join(serveSim, ...parts);
        return Fs.existsSync(file) ? file : null;
      };
      return {
        helpers: {
          serveSimAxSettings: helper("simax", "serve-sim-ax-settings"),
          serveSimCli: helper("serve-sim.js"),
        },
        async run(command, args, options) {
          const program =
            // The node that runs serve-sim's CLI is the hub's: not Electron's own executable.
            command === "node" ? (resolveNode(config().node) ?? "node") : programs[command];
          if (program === undefined) {
            throw new DeviceError(
              "DEVICE_PLATFORM_UNAVAILABLE",
              command === "xcrun"
                ? "Xcode command line tools were not found."
                : "Android platform tools (adb) were not found in the Android SDK.",
            );
          }
          // A command that does not start is the action's failure too; one that outlives
          // its 30 s is stopped and answers no exit code, which the action reports.
          const result = await runProgram(program, args, {
            // The device tools' own variables (ANDROID_SERIAL, ANDROID_ADB_SERVER_PORT, …) too.
            env: toolEnvironment(process.env),
            timeoutMs: 30_000,
            ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
          }).catch((error: unknown) => {
            throw new DeviceError(
              "DEVICE_OPERATION_FAILED",
              `Device ${command} could not be run: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
          return { code: result.code, stdout: result.stdout, stderr: result.stderr };
        },
      };
    };
    /** One action or settings read at a time per device (D1332). */
    const actionQueue = createKeyedQueue();
    const runningDevice = async (input: { threadId: string; deviceId?: string | undefined }) => {
      const device = await target(input);
      if (!device.booted) {
        throw new DeviceError(
          "DEVICE_UNAVAILABLE",
          `Device ${device.id} is not running. Call device_open first.`,
        );
      }
      return device;
    };
    context.commands.register({
      name: "device.detail",
      title: "Read a device's settings",
      description:
        "A running device's appearance, text size, accessibility and network settings and its foreground app, as the Device panel's tools show them.",
      input: DeviceTargetInput,
      output: DeviceDetail,
      permissions: ["devices.read"],
      handler: async (input) => {
        const device = await runningDevice(input);
        // Behind any action under way on the device, so it never reads one half done.
        const read = await actionQueue.run(`${device.hostId}\u0000${device.id}`, async () => {
          // Still running once its turn comes.
          await runningDevice(input);
          return readDeviceDetail(actionHost(), device.platform, device.id);
        });
        return {
          hostId: device.hostId,
          deviceId: device.id,
          ...read,
          readAt: now(),
        };
      },
    });
    context.commands.register({
      name: "device.action",
      title: "Change a device's settings or apps",
      description:
        "One of the Device panel's tools on a running device: appearance, text size, accessibility toggles, orientation, location, an app's permission, open a URL, launch or terminate an app, or a push notification (iOS).",
      input: DeviceActionInput,
      output: DeviceDetail,
      permissions: ["devices.write"],
      handler: async (input) => {
        const device = await runningDevice(input);
        // One action at a time per device, its read-back included: an agent's and the panel's
        // steps (three settings, a permission group) do not interleave.
        return actionQueue.run(`${device.hostId}\u0000${device.id}`, async () => {
          // Still running once its turn comes: one closed meanwhile says so, not adb's error.
          await runningDevice(input);
          const actions = actionHost();
          await runDeviceAction(actions, device.platform, device.id, input.action);
          // The settings read back after the change, as T3's panel shows them.
          const read = await readDeviceDetail(actions, device.platform, device.id);
          return { hostId: device.hostId, deviceId: device.id, ...read, readAt: now() };
        });
      },
    });

    /** One input to a thread's device (D1209). */
    const drive = async (
      input: { threadId: string; deviceId?: string | undefined },
      deviceInput: DeviceInput,
    ) => {
      const device = await runningDevice(input);
      return { device, via: await hub.input(input.threadId, device, deviceInput) };
    };
    context.commands.register({
      name: "device.tap",
      title: "Tap device",
      description:
        "Tap an open device at a point of its screen, in the device's coordinates (as agent-device snapshots give them; pixels on Android).",
      input: DeviceTapInput,
      output: DeviceInputResult,
      permissions: ["devices.write"],
      handler: (input) => drive(input, { type: "tap", x: input.x, y: input.y }),
    });
    context.commands.register({
      name: "device.swipe",
      title: "Swipe device",
      description:
        "Swipe on an open device from one point of its screen to another, in the device's coordinates.",
      input: DeviceSwipeInput,
      output: DeviceInputResult,
      permissions: ["devices.write"],
      handler: (input) => drive(input, { type: "swipe", from: input.from, to: input.to }),
    });
    context.commands.register({
      name: "device.type",
      title: "Type on device",
      description: "Type text into the focused field of an open device.",
      input: DeviceTypeInput,
      output: DeviceInputResult,
      permissions: ["devices.write"],
      handler: (input) => drive(input, { type: "text", text: input.text }),
    });
    context.commands.register({
      name: "device.button",
      title: "Press device button",
      description:
        "Press a hardware button of an open device: home, back (Android) or appSwitcher (recent apps).",
      input: DeviceButtonInput,
      output: DeviceInputResult,
      permissions: ["devices.write"],
      handler: (input) => drive(input, { type: "button", button: input.button }),
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
