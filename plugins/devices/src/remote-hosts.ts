// The devices of hosts over SSH follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/device/DeviceService.ts (hosts reconciled with the settings, devices listed,
// booted, shut down and screenshotted through each host's hub, one failing host leaving the
// others) and DeviceMultiHost.test.ts. docs/plans/preview.md, D1494–D1499.
import {
  DeviceError,
  type DeviceHostStatus,
  type DeviceHostSummary,
  type DeviceInput,
  type DevicePlatform,
  type DeviceSummary,
} from "@jhin/preview-api";
import { z } from "@jhin/sdk";

import type { ActionHost } from "./actions.ts";
import { runRemoteAgentDeviceInput } from "./agent-device.ts";
import { adbInputs } from "./hosts.ts";
import {
  createSshHost,
  isLocalSshHost,
  type SshDeviceHostConfig,
  type SshHost,
  type SshHostReady,
  type SshOptions,
} from "./ssh-host.ts";

const HubDevice = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  platform: z.enum(["ios", "android"]),
  booted: z.boolean(),
  physical: z.boolean(),
});
const HubDeviceList = z.object({
  simulators: z.array(HubDevice),
  emulators: z.array(HubDevice),
});
const HubActionResult = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  serial: z.string().optional(),
  error: z.string().optional(),
});

/** T3's `vendorPrefix`: serve-sim for iOS, serve-emu for Android. */
const vendorPrefix = (platform: DevicePlatform) =>
  platform === "ios" ? "/vendor/serve-sim" : "/vendor/serve-emu";

const BOOT_TIMEOUT_MS = 3 * 60_000;
const SCREENSHOT_TIMEOUT_MS = 20_000;

async function hubJson<T>(
  url: string,
  schema: z.ZodType<T>,
  operation: string,
  init: { body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.body === undefined ? "GET" : "POST",
      ...(init.body === undefined
        ? {}
        : { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } }),
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
  } catch (error) {
    throw new DeviceError(
      "DEVICE_OPERATION_FAILED",
      `Device ${operation} failed: ${String(error)}`,
    );
  }
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!response.ok || !parsed.success) {
    throw new DeviceError(
      "DEVICE_OPERATION_FAILED",
      `Device ${operation} failed: the device hub answered ${response.status}.`,
    );
  }
  return parsed.data;
}

export interface RemoteHostsOptions extends SshOptions {
  readonly configs: () => readonly SshDeviceHostConfig[];
  /** The device hub's consent (D1206): nothing starts on any host while it is off. */
  readonly enabled: () => boolean;
  readonly agentAccess: () => boolean;
  /** T3's owner of a host's state on it. */
  readonly owner: (hostId: string) => string;
  /** Whether a host is this machine; `ssh -G` by default (T3's `isLocalSshDeviceHost`). */
  readonly isLocal?: (config: SshDeviceHostConfig) => Promise<boolean>;
  readonly onChange: () => void;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

/** The node's device hosts over SSH, kept in line with `jhin.devices.sshHosts` (D1494). */
export function createRemoteHosts(options: RemoteHostsOptions) {
  const hosts = new Map<string, SshHost>();
  const statuses = new Map<string, DeviceHostStatus>();
  const lists = new Map<string, DeviceSummary[]>();
  const sshOptions: SshOptions = {
    ...(options.ssh === undefined ? {} : { ssh: options.ssh }),
    ...(options.env === undefined ? {} : { env: options.env }),
  };
  const same = (a: SshDeviceHostConfig, b: SshDeviceHostConfig) =>
    a.label === b.label &&
    a.target === b.target &&
    a.port === b.port &&
    a.identityFile === b.identityFile;

  let reconciling: Promise<void> = Promise.resolve();
  /** T3's `reconcile`: removed or changed hosts stop first, then new ones are made. */
  const reconcile = () => {
    const run = async () => {
      const configured = options.configs();
      const remote: SshDeviceHostConfig[] = [];
      for (const config of configured) {
        const local = await (options.isLocal ?? ((each) => isLocalSshHost(each, sshOptions)))(
          config,
        ).catch(() => false);
        if (!local) remote.push(config);
      }
      for (const [id, host] of hosts) {
        const next = remote.find((config) => config.id === id);
        if (next !== undefined && same(next, host.config)) continue;
        hosts.delete(id);
        statuses.delete(id);
        lists.delete(id);
        // Removed for good: a command that still holds it cannot start it again.
        await host.retire();
      }
      for (const config of remote) {
        if (hosts.has(config.id)) continue;
        hosts.set(
          config.id,
          createSshHost({
            ...sshOptions,
            config,
            owner: options.owner(config.id),
            onStatus: (status) => {
              // A late status of a host removed meanwhile does not linger (T3).
              if (hosts.get(config.id)?.config !== config) return;
              statuses.set(config.id, status);
              options.onChange();
            },
            log: options.log,
          }),
        );
      }
      options.onChange();
    };
    reconciling = reconciling.then(run, run);
    return reconciling;
  };

  const hostOf = (hostId: string): SshHost => {
    const host = hosts.get(hostId);
    if (host === undefined) throw new DeviceError("DEVICE_NOT_FOUND", `No device host ${hostId}.`);
    return host;
  };
  const unavailable = () =>
    new DeviceError(
      "DEVICE_UNAVAILABLE",
      "Devices on SSH hosts need the device hub. Turn it on with Devices → Device hub (jhin.devices.hub).",
    );
  const ready = async (hostId: string): Promise<SshHostReady> => {
    if (!options.enabled()) throw unavailable();
    return hostOf(hostId).ensureReady();
  };

  /** A host's devices from its hub, with its AVDs (T3's `fetchDevices`). */
  async function list(host: SshHost): Promise<DeviceSummary[]> {
    const started = await host.ensureReady();
    const listed = await hubJson(`${started.hubOrigin}/api/devices`, HubDeviceList, "list");
    const devices: DeviceSummary[] = [...listed.simulators, ...listed.emulators].map((device) => ({
      hostId: host.id,
      id: device.id,
      platform: device.platform,
      name: device.name,
      version: device.version,
      booted: device.booted,
      physical: device.physical,
    }));
    if (host.summary().platforms.some((each) => each.platform === "android" && each.available)) {
      const avds = await host.run("emulator", ["-list-avds"]);
      if (avds.code === 0) {
        for (const avd of avds.stdout.split("\n").map((line) => line.trim())) {
          if (avd === "" || devices.some((device) => device.name === avd)) continue;
          devices.push({
            hostId: host.id,
            id: avd,
            platform: "android",
            name: avd,
            version: "",
            booted: false,
            physical: false,
          });
        }
      }
    }
    return devices;
  }

  return {
    reconcile,
    has: (hostId: string) => hosts.has(hostId),
    summaries: (): DeviceHostSummary[] => [...hosts.values()].map((host) => host.summary()),
    statuses: (): Record<string, DeviceHostStatus> => Object.fromEntries(statuses),
    devices: (): DeviceSummary[] => [...lists.values()].flat(),

    /**
     * Lists every host's devices while the hub is allowed; a host that fails keeps its
     * `failed` status and lists nothing, the others go on (T3's multi-host). A host still
     * connecting (an install takes minutes) is listed once it is up, without holding the
     * answer for the others; `only` waits for that one host.
     */
    async refresh(only?: string): Promise<void> {
      if (!options.enabled()) {
        lists.clear();
        return;
      }
      const listOne = async (host: SshHost) => {
        try {
          lists.set(host.id, await list(host));
        } catch (error) {
          lists.delete(host.id);
          options.log("device host not listed", { hostId: host.id, error: String(error) });
        }
        options.onChange();
      };
      const waited: Promise<void>[] = [];
      for (const host of hosts.values()) {
        if (only !== undefined && host.id !== only) continue;
        // A failed host is tried again only when asked (T3's `retryHostId`, D1497).
        if (
          only === undefined &&
          host.current() === undefined &&
          statuses.get(host.id)?.status === "failed"
        ) {
          continue;
        }
        const listing = listOne(host);
        if (only !== undefined || host.current() !== undefined) waited.push(listing);
      }
      await Promise.all(waited);
    },

    /** Agents may no longer use agent-device (D1329): every host's daemon stops, hubs run on. */
    async stopAgents(): Promise<void> {
      await Promise.all([...hosts.values()].map((host) => host.stopAgent()));
    },

    /** The hub was turned off (D1206): every host's tunnel and helpers stop at once. */
    async disable(): Promise<void> {
      lists.clear();
      await Promise.all([...hosts.values()].map((host) => host.stop()));
      statuses.clear();
      options.onChange();
    },

    origin: (hostId: string) => hosts.get(hostId)?.current()?.hubOrigin,
    ensure: (hostId: string) => ready(hostId),

    /** Boots through the host's hub; an AVD's id becomes its serial (T3's `boot`). */
    async boot(device: DeviceSummary): Promise<string> {
      const started = await ready(device.hostId);
      const result = await hubJson(
        `${started.hubOrigin}/api/devices/boot`,
        HubActionResult,
        "boot",
        {
          body: { platform: device.platform, id: device.id, name: device.name },
          timeoutMs: BOOT_TIMEOUT_MS,
        },
      );
      if (!result.ok) {
        throw new DeviceError(
          "DEVICE_BOOT_FAILED",
          `Device ${device.id} on host ${device.hostId} could not boot: ${result.error ?? "the hub refused"}.`,
        );
      }
      if (device.platform === "ios") {
        // Booting alone does not attach a serve-sim helper; the grid start does both.
        await hubJson(
          `${started.hubOrigin}${vendorPrefix("ios")}/grid/api/start`,
          HubActionResult,
          "attach stream",
          { body: { udid: device.id }, timeoutMs: BOOT_TIMEOUT_MS },
        );
      }
      return result.serial ?? result.id ?? device.id;
    },

    async shutdown(device: DeviceSummary): Promise<void> {
      const started = await ready(device.hostId);
      await (device.platform === "ios"
        ? hubJson(
            `${started.hubOrigin}${vendorPrefix("ios")}/grid/api/shutdown`,
            HubActionResult,
            "shutdown",
            { body: { udid: device.id } },
          )
        : hubJson(`${started.hubOrigin}/api/devices/shutdown`, HubActionResult, "shutdown", {
            body: { platform: device.platform, id: device.id },
          }));
    },

    /** The screen through the hub's vendor route (T3's `screenshot`). */
    async screenshot(device: DeviceSummary): Promise<Buffer> {
      const started = await ready(device.hostId);
      const url = `${started.hubOrigin}${vendorPrefix(device.platform)}/api/screenshot?device=${encodeURIComponent(device.id)}`;
      const response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(SCREENSHOT_TIMEOUT_MS),
      }).catch((error: unknown) => {
        throw new DeviceError(
          "DEVICE_OPERATION_FAILED",
          `Device screenshot failed: ${String(error)}`,
        );
      });
      if (!response.ok) {
        throw new DeviceError(
          "DEVICE_OPERATION_FAILED",
          `Device screenshot failed: the device hub answered ${response.status}.`,
        );
      }
      return Buffer.from(await response.arrayBuffer());
    },

    /** agent-device on the host when agents may use it, else adb there (D1499). */
    async input(
      threadId: string,
      device: DeviceSummary,
      input: DeviceInput,
    ): Promise<"agent-device" | "adb"> {
      if (!options.enabled()) throw unavailable();
      const host = hostOf(device.hostId);
      let reason: string | undefined;
      if (options.agentAccess()) {
        try {
          const started = await host.ensureAgentReady();
          if (started.agent !== undefined) {
            await runRemoteAgentDeviceInput({
              run: (command, args) => host.run(command, args, { timeoutMs: 60_000 }),
              nodePath: started.nodePath,
              entryPath: started.agent.entryPath,
              stateDir: started.agent.stateDir,
              threadId,
              device,
              input,
            });
            return "agent-device";
          }
          reason = "The host's agent tools did not start.";
        } catch (error) {
          if (error instanceof DeviceError && error.code === "DEVICE_OPERATION_FAILED") throw error;
          reason = error instanceof Error ? error.message : String(error);
        }
      }
      options.log("device input through adb", { hostId: device.hostId, reason });
      if (device.platform === "ios") {
        throw new DeviceError(
          "DEVICE_UNAVAILABLE",
          "iOS input needs the agent tools, which could not start on this host or are not allowed (jhin.devices.agentAccess). simctl cannot tap or type.",
        );
      }
      for (const args of adbInputs(input)) {
        const result = await host.run("adb", ["-s", device.id, "shell", "input", ...args]);
        if (result.code !== 0) {
          throw new DeviceError(
            "DEVICE_OPERATION_FAILED",
            `Device adb input failed: The device command failed (exit code ${result.code}).`,
            { stderr: result.stderr.slice(0, 2000) },
          );
        }
      }
      return "adb";
    },

    /** The device tools' programs, run on the host (T3's `ready.run`, D1499). */
    async actionHost(hostId: string): Promise<ActionHost> {
      const host = hostOf(hostId);
      const started = await ready(hostId);
      return {
        helpers: started.helpers,
        async run(command, args, run) {
          const result = await host.run(command === "node" ? started.nodePath : command, args, {
            timeoutMs: 30_000,
            ...(run?.stdin === undefined ? {} : { stdin: run.stdin }),
          });
          return { code: result.code, stdout: result.stdout, stderr: result.stderr };
        },
      };
    },

    /** How an agent drives the device from this node: through ssh (D1497). */
    control(device: DeviceSummary): { command: string; targetArgs: string[]; quickStart: string } {
      const host = hostOf(device.hostId);
      // Quoted where a shell would split them (an identity file's path with spaces).
      const shellWord = (word: string) =>
        /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`;
      const sshArgs = [
        ...(host.config.port === undefined ? [] : ["-p", String(host.config.port)]),
        ...(host.config.identityFile === undefined
          ? []
          : ["-i", shellWord(host.config.identityFile)]),
        shellWord(host.config.target),
      ];
      const targetArgs =
        device.platform === "ios"
          ? [...sshArgs, "xcrun", "simctl", "<subcommand>", device.id]
          : [...sshArgs, "adb", "-s", device.id];
      return {
        command: "ssh",
        targetArgs,
        quickStart: `${device.name} (${device.id}) runs on the device host ${host.config.label}. Drive it with ssh ${targetArgs.join(" ")}${device.platform === "ios" ? "" : " <command>"}.`,
      };
    },

    async stop(): Promise<void> {
      await reconciling;
      await Promise.all([...hosts.values()].map((host) => host.stop()));
      hosts.clear();
    },
  };
}

export type RemoteHosts = ReturnType<typeof createRemoteHosts>;
