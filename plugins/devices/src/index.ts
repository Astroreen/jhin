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
import {
  HOST_IDENTITY_CAPABILITY,
  HOST_PATHS_CAPABILITY,
  type HostIdentity,
  type HostPaths,
} from "@jhin/host-api";
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
  DeviceHostTestInput,
  DeviceHostTestResult,
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

import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as NodePath from "node:path";

import { readDeviceDetail, runDeviceAction, type ActionHost } from "./actions.ts";
import { createLocalHost } from "./hosts.ts";
import { HUB_SPEC, runProgram, toolEnvironment, toolPaths } from "./toolchain.ts";
import { createDeviceHub } from "./hub.ts";
import { resolveNode } from "./hub-host.ts";
import { createKeyedQueue } from "./keyed-queue.ts";
import { createRemoteHosts } from "./remote-hosts.ts";
import { SshDeviceHostConfig, isLocalSshHost, probeSshHost } from "./ssh-host.ts";

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
    agentAccess: z.boolean().optional().meta({
      title: "Agent access",
      description:
        "Off until you allow it: agents tap, swipe and type on devices through agent-device, installed from npm into Jhin's home when you turn this on. Off: their input goes through adb (Android only). Unset, it follows the device hub, which before this setting installed agent-device too.",
    }),
    onboardingCompleted: z.boolean().default(false).meta({
      title: "Device setup done",
      description: "The Device panel's setup was finished; it shows again while this is off.",
      advanced: true,
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
    sshHosts: z
      .array(SshDeviceHostConfig)
      .default([])
      .refine(
        (hosts) => new Set(hosts.map((host) => host.id)).size === hosts.length,
        "Device host ids must be unique.",
      )
      .meta({
        title: "Device hosts",
        description:
          "Add remote machines with simulator or emulator runtimes installed, and this node will connect over SSH and set up device tools automatically (with the device hub on). Changes apply at once.",
        advanced: true,
      }),
    ssh: Path.meta({
      title: "ssh",
      description:
        "The ssh that reaches device hosts; ssh on PATH when unset. Takes effect when the plugin restarts.",
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
    const config = () => context.config.get<Config>(CONFIG_SECTION);
    /**
     * Agents may use agent-device (D1329). Unset, the setting follows the hub: a node that
     * turned the hub on before this setting existed had agreed to agent-device with it (D1206).
     */
    const agentAccess = () => config().agentAccess ?? config().hub;
    /** Whether agent-device runs; the hub below answers once it exists. */
    let agentToolsReady = () => false;

    // Device hosts over SSH (preview.md D1494–D1499).
    const identity = context.services.tryGet<HostIdentity>(HOST_IDENTITY_CAPABILITY);
    const homeOf = context.services.tryGet<HostPaths>(HOST_PATHS_CAPABILITY)?.home ?? "";
    /** T3's owner: the node, its home and the host, so two nodes never share a host's state. */
    const ownerOf = (hostId: string) =>
      Crypto.createHash("sha256")
        .update(`${identity?.nodeId ?? ""}\0${homeOf}\0${hostId}`)
        .digest("hex")
        .slice(0, 24);
    const remote = createRemoteHosts({
      configs: () => config().sshHosts,
      enabled: () => config().hub,
      agentAccess: () => agentAccess(),
      ssh: config().ssh,
      owner: (hostId) => ownerOf(hostId),
      onChange: () => publish(),
      log: (message, fields) => context.log.debug(message, fields),
    });
    void remote.reconcile();
    context.onDeactivate(() => remote.stop());
    /** Whether a host id names a host over SSH. */
    const isRemote = (hostId: string | undefined) =>
      hostId !== undefined && hostId !== LOCAL_DEVICE_HOST_ID;

    const state = (): DeviceState => {
      const hostStatuses = {
        ...remote.statuses(),
        ...(hubStatus === undefined ? {} : { [LOCAL_DEVICE_HOST_ID]: hubStatus }),
      };
      return {
        hosts: [host.summary(), ...remote.summaries()],
        devices: [...devices, ...remote.devices()],
        sessions,
        booting,
        ...(detail === undefined ? {} : { detail }),
        ...(Object.keys(hostStatuses).length === 0 ? {} : { hostStatuses }),
        setup: {
          hubEnabled: config().hub,
          agentAccessEnabled: agentAccess(),
          onboardingCompleted: config().onboardingCompleted,
          // Allowed now, not only still running: a stop under way already reads as not ready.
          agentToolsReady: config().hub && agentAccess() && agentToolsReady(),
        },
      };
    };
    const publish = () => {
      streams.clear(DEVICES_STREAM);
      streams.append(DEVICES_STREAM, DeviceEvents.state, { state: state() as unknown as Json });
    };
    /** The local host's devices, and those of the hosts over SSH (one failing leaves the rest). */
    const refresh = async (retryHostId?: string) => {
      const [listed] = await Promise.all([host.list(), remote.refresh(retryHostId)]);
      devices = listed.devices;
      detail = listed.detail;
      publish();
      return [...listed.devices, ...remote.devices()];
    };
    context.services.provide(DEVICE_HOSTS_CAPABILITY, { state, refresh });

    // T3's device hub for live video and input (D1206–D1209); D408's tools stay the fallback.
    const paths = context.services.tryGet<HostPaths>(HOST_PATHS_CAPABILITY);
    const hub = createDeviceHub({
      home: paths?.home,
      stateDir: paths?.dataDir(context.plugin.id),
      enabled: () => config().hub,
      agentAccess: () => agentAccess(),
      node: () => config().node,
      npm: () => config().npm,
      androidSdk: () => host.androidSdk(),
      summary: () => host.summary(),
      adbInput: (device, input) => host.input(device, input),
      remote: { has: remote.has, origin: remote.origin, ensure: remote.ensure },
      http: context.services.tryGet<HttpServer>(HTTP_SERVER_CAPABILITY),
      verifier: context.services.tryGet<AuthVerifier>(AUTH_VERIFIER_CAPABILITY),
      onStatus: (next) => {
        hubStatus = next;
        publish();
      },
      // A daemon that died: the setup no longer says its tools are ready.
      onAgentGone: () => publish(),
      log: (message, fields) => context.log.debug(message, fields),
    });
    agentToolsReady = () => hub.agentReady();
    context.onDeactivate(() => hub.stop());
    // The setting is the consent (D1206): turned off, the hub goes at once.
    // Agent tools run while the hub is on and agents are allowed (D1329): either turning on
    // starts them at once, either turning off stops them.
    let agentsAllowed = config().hub && agentAccess();
    context.subscriptions.add(
      context.config.onDidChange(CONFIG_SECTION, () => {
        void remote.reconcile();
        if (!config().hub) {
          // The consent goes for the hosts over SSH too (D1206, D1494).
          void remote
            .disable()
            .catch((error: unknown) =>
              context.log.warn("device hosts not stopped", { error: String(error) }),
            );
          void hub
            .disable()
            .catch((error: unknown) =>
              context.log.warn("device hub not stopped", { error: String(error) }),
            );
        }
        const allowed = config().hub && agentAccess();
        if (allowed !== agentsAllowed) {
          agentsAllowed = allowed;
          if (allowed) hub.warmAgent();
          else {
            void remote
              .stopAgents()
              .catch((error: unknown) =>
                context.log.warn("device hosts' agent tools not stopped", { error: String(error) }),
              );
          }
          if (!allowed)
            void hub
              .stopAgent()
              .then(publish)
              .catch((error: unknown) =>
                context.log.warn("agent tools not stopped", { error: String(error) }),
              );
        }
        publish();
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
    const target = async (input: {
      threadId: string;
      deviceId?: string | undefined;
      hostId?: string | undefined;
    }) => {
      const latest = sessions.findLast((session) => session.threadId === input.threadId);
      const id = input.deviceId ?? latest?.deviceId;
      // A named device is local unless a host is named; the thread's latest keeps its host.
      const hostId =
        input.hostId ??
        (input.deviceId === undefined ? latest?.hostId : undefined) ??
        LOCAL_DEVICE_HOST_ID;
      if (id === undefined) {
        throw new DeviceError(
          "DEVICE_NOT_FOUND",
          "No device is open in this thread. Call device_open first.",
        );
      }
      const mine = (device: DeviceSummary) => device.id === id && device.hostId === hostId;
      const known = [...devices, ...remote.devices()].find(mine) ?? (await refresh()).find(mine);
      if (known === undefined) {
        throw new DeviceError(
          "DEVICE_NOT_FOUND",
          `No device ${id} on host ${hostId}. Call device_list for current ids.`,
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
    const capture = async (key: string) => {
      const [hostId, deviceId] = JSON.parse(key) as [string, string];
      const stream = `${DEVICE_STREAM_PREFIX}${hostId}/${encodeURIComponent(deviceId)}`;
      while (!lifetime.disposed && (watchers.get(key) ?? 0) > 0) {
        const device = isRemote(hostId)
          ? remote.devices().find((each) => each.hostId === hostId && each.id === deviceId)
          : byId(devices, deviceId);
        if (device !== undefined && device.booted) {
          try {
            const png = isRemote(hostId)
              ? await remote.screenshot(device)
              : await host.screenshot(device);
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
          const parts = stream.split("/");
          const deviceId = JSON.stringify([parts[1] ?? "", decodeURIComponent(parts[2] ?? "")]);
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
        const listed = (await refresh(input.retryHostId)).filter(
          (device) => input.hostId === undefined || device.hostId === input.hostId,
        );
        return {
          hosts: [host.summary(), ...remote.summaries()].filter(
            (each) => input.hostId === undefined || each.id === input.hostId,
          ),
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
        const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
        const onSsh = isRemote(hostId);
        if (onSsh && !remote.has(hostId)) {
          throw new DeviceError("DEVICE_NOT_FOUND", `No device host ${hostId}. Call device_list.`);
        }
        const summary = onSsh
          ? remote.summaries().find((each) => each.id === hostId)!
          : host.summary();
        const listed = (await refresh(onSsh ? hostId : undefined)).filter(
          (device) => device.hostId === hostId,
        );
        let device: DeviceSummary | undefined;
        if (input.deviceId !== undefined) {
          device = byId(listed, input.deviceId);
          if (device === undefined) {
            throw new DeviceError(
              "DEVICE_NOT_FOUND",
              `No device ${input.deviceId} on host ${hostId}. Call device_list for current ids.`,
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
                : `No ${input.platform} devices were found on host ${hostId}. Call device_list to see why.`,
            );
          }
        }
        const chosen: DeviceSummary = device;
        const platform = summary.platforms.find((each) => each.platform === chosen.platform);
        if (platform?.available !== true) {
          throw new DeviceError(
            "DEVICE_PLATFORM_UNAVAILABLE",
            `${chosen.platform} devices are unavailable on host ${hostId}: ${platform?.reason ?? "unknown"}`,
          );
        }
        if (!device.booted) {
          const starting = {
            hostId,
            deviceId: device.id,
            threadId: input.threadId,
          };
          booting = [...booting, starting];
          publish();
          const stopped = device;
          const bootKey = `${hostId}\u0000${stopped.id}`;
          const boot =
            boots.get(bootKey) ??
            (onSsh
              ? // An AVD's id becomes its serial once it runs (T3's `boot`).
                remote
                  .boot(stopped)
                  .then((id) => ({ ...stopped, id, booted: true }) satisfies DeviceSummary)
              : host.boot(stopped));
          boots.set(bootKey, boot);
          try {
            device = await boot;
          } finally {
            boots.delete(bootKey);
            booting = booting.filter((each) => each !== starting);
          }
          await refresh(onSsh ? hostId : undefined);
        }
        const opened = device;
        keepSessions([
          ...sessions.filter(
            (session) =>
              !(
                session.threadId === input.threadId &&
                session.deviceId === opened.id &&
                session.hostId === hostId
              ),
          ),
          {
            threadId: input.threadId,
            hostId,
            deviceId: opened.id,
            platform: opened.platform,
            openedAt: now(),
          },
        ]);
        publish();
        // The Device panel will ask for the hub's video: it starts now (D1207).
        if (!onSsh) hub.warm();
        const control = onSsh ? remote.control(opened) : host.control(opened);
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
        const png = isRemote(device.hostId)
          ? await remote.screenshot(device)
          : await host.screenshot(device);
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
        return hub.access(invocation.caller, _input.hostId);
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
    /** The programs of the device's own host: this node's, or an SSH host's (D1499). */
    const actionsFor = (device: DeviceSummary): Promise<ActionHost> =>
      isRemote(device.hostId) ? remote.actionHost(device.hostId) : Promise.resolve(actionHost());
    const runningDevice = async (input: {
      threadId: string;
      deviceId?: string | undefined;
      hostId?: string | undefined;
    }) => {
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
          return readDeviceDetail(await actionsFor(device), device.platform, device.id);
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
          const actions = await actionsFor(device);
          await runDeviceAction(actions, device.platform, device.id, input.action);
          // The settings read back after the change, as T3's panel shows them. The action took
          // either way: a read-back that fails answers unknown settings, not a failed action
          // an agent would repeat.
          const read = await readDeviceDetail(actions, device.platform, device.id).catch(
            (error: unknown) => {
              context.log.warn("device settings not read back", {
                deviceId: device.id,
                error: String(error),
              });
              return { settings: {}, foregroundApp: null, readError: String(error) };
            },
          );
          return { hostId: device.hostId, deviceId: device.id, ...read, readAt: now() };
        });
      },
    });

    /** One input to a thread's device (D1209). */
    const drive = async (
      input: { threadId: string; deviceId?: string | undefined; hostId?: string | undefined },
      deviceInput: DeviceInput,
    ) => {
      const device = await runningDevice(input);
      return {
        device,
        via: isRemote(device.hostId)
          ? await remote.input(input.threadId, device, deviceInput)
          : await hub.input(input.threadId, device, deviceInput),
      };
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

    // T3's connection check of a device host, before or after it is saved (D1500).
    context.commands.register({
      name: "device.hosts.test",
      title: "Test a device host's connection",
      description:
        "Connects to a device host over SSH and reports which platforms it can run and whether its device tools are installed; a host that is this machine is reported as local.",
      input: DeviceHostTestInput,
      output: DeviceHostTestResult,
      permissions: ["devices.write"],
      handler: async ({ host: candidate }) => {
        const parsed = SshDeviceHostConfig.safeParse(candidate);
        if (!parsed.success) {
          return {
            status: "failed" as const,
            error: parsed.error.issues[0]?.message ?? "Invalid host.",
          };
        }
        const options = config().ssh === undefined ? {} : { ssh: config().ssh };
        if (await isLocalSshHost(parsed.data, options).catch(() => false)) {
          return { status: "local" as const };
        }
        try {
          const probe = await probeSshHost(parsed.data, ownerOf(parsed.data.id), options);
          return {
            status: "connected" as const,
            platforms: probe.platforms,
            hubInstalled: probe.hubInstalled,
            agentDeviceInstalled: probe.agentDeviceInstalled,
          };
        } catch (error) {
          return {
            status: "failed" as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }
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
            (input.hostId === undefined || session.hostId === input.hostId) &&
            (input.deviceId === undefined || session.deviceId === input.deviceId),
        );
        keepSessions(sessions.filter((session) => !closing.includes(session)));
        publish();
        if (input.shutdown === true) {
          const targets =
            input.deviceId === undefined
              ? closing.map((each) => [each.hostId, each.deviceId] as const)
              : [[input.hostId ?? LOCAL_DEVICE_HOST_ID, input.deviceId] as const];
          for (const [hostId, id] of targets) {
            const device = [...devices, ...remote.devices()].find(
              (each) => each.hostId === hostId && each.id === id,
            );
            if (device === undefined) continue;
            if (isRemote(hostId)) await remote.shutdown(device);
            else await host.shutdown(device);
          }
          await refresh();
        }
        return {};
      },
    });
  },
});
