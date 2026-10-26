// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/device/SshDeviceHost.ts
// (probe, start, the tunnels, the health checks and the reconnect), localSshDeviceHost.ts and
// runSshCommand / baseSshArgs of packages/ssh/src/command.ts (preview.md D1494–D1496).
import * as ChildProcess from "node:child_process";
import * as Dns from "node:dns/promises";
import * as Net from "node:net";
import * as Os from "node:os";

import type { DeviceHostStatus, DeviceHostSummary, DevicePlatform } from "@jhin/preview-api";
import { z } from "@jhin/sdk";

import {
  quoteRemoteArg,
  remoteDeviceEnvironment,
  remoteDeviceScript,
  type RemoteMode,
} from "./ssh-script.ts";

/** T3's `SshDeviceHostConfig` (D1494). */
export const SshDeviceHostConfig = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "letters, digits, _ and -")
    .refine((id) => id !== "local", "The local host id is reserved."),
  label: z.string().trim().min(1),
  target: z
    .string()
    .trim()
    .min(1)
    .regex(/^[^\s-][^\s]*$/, "user@host or an SSH alias"),
  identityFile: z.string().trim().min(1).optional(),
  port: z.number().int().min(1).max(65_535).optional(),
});
export type SshDeviceHostConfig = z.output<typeof SshDeviceHostConfig>;

const PROBE_TIMEOUT_MS = 45_000;
/** A start may install the tools first (T3's 1 300 s). */
const START_TIMEOUT_MS = 1_300_000;
const FORWARD_READY_MS = 15_000;
const HEALTH_EVERY_MS = 10_000;
const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface SshCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Where a started host's hub and daemon answer, through the tunnels (D1496). */
export interface SshHostReady {
  /** The host's Node.js, which runs agent-device's CLI there. */
  readonly nodePath: string;
  readonly hubOrigin: string;
  readonly agent?: {
    readonly entryPath: string;
    readonly stateDir: string;
    readonly baseUrl: string;
  };
  readonly helpers: {
    readonly serveSimAxSettings: string | null;
    readonly serveSimCli: string | null;
  };
}

const Probe = z.object({
  nodePath: z.string(),
  platforms: z.array(
    z.object({
      platform: z.enum(["ios", "android"]),
      available: z.boolean(),
      reason: z.string().optional(),
    }),
  ),
  hubInstalled: z.boolean(),
  agentDeviceInstalled: z.boolean(),
});
export type SshProbe = z.output<typeof Probe>;
const Started = Probe.extend({
  hubPort: z.number().int(),
  daemonPort: z.number().int().optional(),
  token: z.string().optional(),
  entryPath: z.string().optional(),
  stateDir: z.string().optional(),
  helpers: z.object({
    serveSimAxSettings: z.string().nullable(),
    serveSimCli: z.string().nullable(),
  }),
});

export interface SshOptions {
  /** The `ssh` to run; `ssh` on PATH when unset (tests give a fake). */
  readonly ssh?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

/** T3's `baseSshArgs` and the target: `-o BatchMode=yes -o ConnectTimeout=10 [-p] [-i] -- target`. */
function sshArgs(config: SshDeviceHostConfig, preHost: readonly string[] = []): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    ...(config.port === undefined ? [] : ["-p", String(config.port)]),
    ...(config.identityFile === undefined ? [] : ["-i", config.identityFile]),
    ...preHost,
    "--",
    config.target,
  ];
}

/** Runs one command on the host (T3's `runSshCommand`); never rejects for the command's own exit. */
function runSsh(
  config: SshDeviceHostConfig,
  remote: readonly string[],
  options: SshOptions & { readonly stdin?: string; readonly timeoutMs?: number } = {},
): Promise<SshCommandResult> {
  return new Promise((resolve) => {
    const child = ChildProcess.spawn(options.ssh ?? "ssh", [...sshArgs(config), ...remote], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr = (stderr + String(chunk)).slice(-8000)));
    const timer = setTimeout(() => {
      stderr = `${stderr}SSH command timed out after ${options.timeoutMs ?? 60_000}ms.`;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: error.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.stdin ?? "");
  });
}

/** `sh -c '<T3's environment><script>'`: ssh joins its arguments with spaces. */
const shell = (script: string) => ["sh", "-c", quoteRemoteArg(remoteDeviceEnvironment + script)];

/** The last line of a failed command's stderr, the way T3 reports a host's step. */
const failure = (step: string, result: SshCommandResult) =>
  new Error(
    result.stderr.trim().split("\n").at(-1)?.trim() ||
      `Device host failed while ${step}${result.code === 0 ? "" : ` (exit code ${result.code})`}.`,
  );

/** Runs T3's remote script in one of its modes with the host's Node.js (D1495). */
async function bootstrap(
  config: SshDeviceHostConfig,
  owner: string,
  mode: RemoteMode,
  options: SshOptions,
): Promise<string> {
  const result = await runSsh(
    config,
    shell(
      'command -v node >/dev/null 2>&1 || { echo "Node is missing from the non-interactive SSH PATH" >&2; exit 1; }; exec node',
    ),
    {
      ...options,
      stdin: remoteDeviceScript(owner, mode),
      timeoutMs: mode === "start" || mode === "agent-start" ? START_TIMEOUT_MS : PROBE_TIMEOUT_MS,
    },
  );
  if (result.code !== 0) throw failure(mode, result);
  return result.stdout.trim().split("\n").at(-1) ?? "";
}

/** What a host can run, and whether its tools are there (T3's `SshDeviceHost.probe`). */
export async function probeSshHost(
  config: SshDeviceHostConfig,
  owner: string,
  options: SshOptions = {},
): Promise<SshProbe> {
  const line = await bootstrap(config, owner, "probe", options);
  const parsed = Probe.safeParse(JSON.parse(line || "null"));
  if (!parsed.success) throw new Error("Device host failed while reading probe result.");
  return parsed.data;
}

/**
 * Whether the host is this machine (T3's `isLocalSshDeviceHost`): `ssh -G` names port 22, no
 * proxy, and a host name whose addresses are all this machine's.
 */
export async function isLocalSshHost(
  config: SshDeviceHostConfig,
  options: SshOptions & { readonly localAddresses?: ReadonlySet<string> } = {},
): Promise<boolean> {
  const result = await new Promise<SshCommandResult>((resolve) => {
    ChildProcess.execFile(
      options.ssh ?? "ssh",
      [
        "-G",
        ...(config.port === undefined ? [] : ["-p", String(config.port)]),
        ...(config.identityFile === undefined ? [] : ["-i", config.identityFile]),
        "--",
        config.target,
      ],
      { timeout: 5_000, ...(options.env === undefined ? {} : { env: options.env }) },
      (error, stdout, stderr) =>
        resolve({ code: error === null ? 0 : 1, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
  if (result.code !== 0) return false;
  const settings = new Map(
    result.stdout.split("\n").map((line) => {
      const separator = line.indexOf(" ");
      return [line.slice(0, separator), line.slice(separator + 1).trim()] as const;
    }),
  );
  // A local forwarded port or a proxy can lead to a different machine.
  if (
    settings.get("port") !== "22" ||
    ["proxycommand", "proxyjump"].some((key) => settings.has(key) && settings.get(key) !== "none")
  ) {
    return false;
  }
  const hostname = settings.get("hostname")?.replace(/^\[|\]$/g, "");
  if (!hostname) return false;
  let addresses: string[];
  if (Net.isIP(hostname)) addresses = [hostname];
  else {
    addresses = await Promise.race([
      Dns.lookup(hostname, { all: true }).then(
        (entries) => entries.map((entry) => entry.address),
        () => [] as string[],
      ),
      new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 2_000).unref()),
    ]);
  }
  const local =
    options.localAddresses ??
    new Set(
      Object.values(Os.networkInterfaces()).flatMap(
        (entries) => entries?.map((entry) => entry.address) ?? [],
      ),
    );
  return (
    addresses.length > 0 &&
    addresses.every(
      (address) => local.has(address) || address === "::1" || address.startsWith("127."),
    )
  );
}

/** A free loopback port, reserved and let go (T3's `reserveLoopbackPort`). */
function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = Net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as Net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Resolves once `url` answers 200, or rejects after `ms` (T3's `waitForHttpReady`). */
async function waitForHttp(url: string, ms: number, stopped: () => boolean): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (stopped()) throw new Error("The forward exited.");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // Not yet.
    }
    if (Date.now() > deadline) throw new Error("Forwarded endpoint did not answer.");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const healthy = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(5_000) }).then(
    (response) => response.ok,
    () => false,
  );

export interface SshHostOptions extends SshOptions {
  readonly config: SshDeviceHostConfig;
  /** T3's owner: 24 hex digits of SHA-256 over the node's id, home and the host's id. */
  readonly owner: string;
  readonly onStatus: (status: DeviceHostStatus) => void;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

/** One device host over SSH (T3's `SshDeviceHost.make`). */
export function createSshHost(options: SshHostOptions) {
  const { config, owner } = options;
  let summary: DeviceHostSummary = {
    id: config.id,
    kind: "ssh",
    label: config.label,
    platforms: [],
  };
  let ready: SshHostReady | undefined;
  let tunnel: ChildProcess.ChildProcess | undefined;
  let health: ReturnType<typeof setInterval> | undefined;
  let reconnecting: ReturnType<typeof setTimeout> | undefined;
  let wantsAgent = false;
  let activated = false;
  let stopped = false;
  /** One start, stop or reconnect at a time (T3's semaphore). */
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <A>(work: () => Promise<A>): Promise<A> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const status = (next: DeviceHostStatus) => options.onStatus(next);

  const closeTunnel = () => {
    if (health !== undefined) clearInterval(health);
    health = undefined;
    const closing = tunnel;
    tunnel = undefined;
    closing?.kill("SIGTERM");
  };

  /** Starts the remote side, then forwards its ports and waits for them (T3's `connectOnce`). */
  async function connectOnce(): Promise<SshHostReady> {
    activated = true;
    const line = await bootstrap(config, owner, wantsAgent ? "agent-start" : "start", options);
    status({ status: "starting" });
    const parsed = Started.safeParse(JSON.parse(line || "null"));
    if (!parsed.success) throw new Error("Device host failed while reading host endpoints.");
    const remote = parsed.data;
    summary = { ...summary, platforms: remote.platforms };
    const hubPort = await reservePort();
    const daemonPort = await reservePort();
    // A multiplexed client hands its -L forwards to the control master and exits,
    // so the tunnel must own its own connection.
    const child = ChildProcess.spawn(
      options.ssh ?? "ssh",
      sshArgs(config, [
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ControlPersist=no",
        "-o",
        "ServerAliveInterval=10",
        "-o",
        "ServerAliveCountMax=3",
        "-N",
        "-L",
        `127.0.0.1:${hubPort}:127.0.0.1:${remote.hubPort}`,
        ...(remote.daemonPort === undefined
          ? []
          : ["-L", `127.0.0.1:${daemonPort}:127.0.0.1:${remote.daemonPort}`]),
      ]),
      {
        stdio: ["ignore", "ignore", "pipe"],
        ...(options.env === undefined ? {} : { env: options.env }),
      },
    );
    tunnel = child;
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr = (stderr + String(chunk)).slice(-2000)));
    let exited = false;
    child.once("exit", () => {
      exited = true;
      // The tunnel went while it served: reconnect (T3's `raceFirst(exitCode, unhealthy)`).
      if (tunnel === child && ready !== undefined) lost();
    });
    child.once("error", () => (exited = true));
    const next: SshHostReady = {
      nodePath: remote.nodePath,
      hubOrigin: `http://127.0.0.1:${hubPort}`,
      ...(remote.daemonPort !== undefined &&
      remote.entryPath !== undefined &&
      remote.stateDir !== undefined
        ? {
            agent: {
              entryPath: remote.entryPath,
              stateDir: remote.stateDir,
              baseUrl: `http://127.0.0.1:${daemonPort}`,
            },
          }
        : {}),
      helpers: remote.helpers,
    };
    try {
      await waitForHttp(`${next.hubOrigin}/readyz`, FORWARD_READY_MS, () => exited);
      if (next.agent !== undefined) {
        await waitForHttp(`${next.agent.baseUrl}/health`, FORWARD_READY_MS, () => exited);
      }
    } catch (error) {
      throw Object.assign(new Error(stderr.trim() || (error as Error).message), {
        forward: true,
      });
    }
    ready = next;
    status({ status: "ready" });
    // Reconnecting also repairs helpers that died while SSH itself stayed connected.
    health = setInterval(() => {
      void (async () => {
        const hubAlive = await healthy(`${next.hubOrigin}/readyz`);
        const daemonAlive =
          next.agent === undefined ? true : await healthy(`${next.agent.baseUrl}/health`);
        if ((!hubAlive || !daemonAlive) && ready === next) lost();
      })();
    }, HEALTH_EVERY_MS);
    health.unref?.();
    return next;
  }

  /** T3's `connect`: fresh ports twice more when the forward could not bind. */
  async function connect(): Promise<SshHostReady> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await connectOnce();
      } catch (error) {
        closeTunnel();
        if (attempt >= 2 || (error as { forward?: boolean }).forward !== true) throw error;
      }
    }
  }

  /** The tunnel or a helper went: reconnect with T3's backoff, 1 s doubling to 30 s. */
  function lost(): void {
    if (stopped) return;
    ready = undefined;
    closeTunnel();
    status({ status: "starting", detail: "Reconnecting to device host…" });
    let delay = RECONNECT_FIRST_MS;
    const attempt = () => {
      reconnecting = setTimeout(() => {
        reconnecting = undefined;
        void exclusive(async () => {
          if (stopped || ready !== undefined) return;
          try {
            await connect();
          } catch (error) {
            status({ status: "failed", detail: (error as Error).message });
            delay = Math.min(delay * 2, RECONNECT_MAX_MS);
            attempt();
          }
        });
      }, delay);
    };
    attempt();
  }

  const ensure = (agent: boolean) =>
    exclusive(async () => {
      stopped = false;
      if (agent && !wantsAgent) {
        // The daemon starts with the next connection, as T3's `changeAgent(true)`.
        wantsAgent = true;
        if (ready !== undefined && ready.agent === undefined) {
          ready = undefined;
          closeTunnel();
        }
      }
      if (ready !== undefined) return ready;
      const probe = await probeSshHost(config, owner, options);
      summary = { ...summary, platforms: probe.platforms };
      status(
        probe.hubInstalled
          ? { status: "starting" }
          : { status: "installing", detail: "Installing device support…" },
      );
      try {
        return await connect();
      } catch (error) {
        status({ status: "failed", detail: (error as Error).message });
        throw error;
      }
    });

  return {
    id: config.id,
    config,
    summary: (): DeviceHostSummary => summary,
    current: (): SshHostReady | undefined => ready,
    /** The hub runs and its tunnel answers (T3's `ensureReady`). */
    ensureReady: () => ensure(false),
    /** The hub and agent-device's daemon (T3's `ensureAgentReady`). */
    ensureAgentReady: () => ensure(true),
    /** What the host can run now (T3's `platformAvailability`). */
    async platformAvailability(platform: DevicePlatform) {
      try {
        const probe = await probeSshHost(config, owner, options);
        summary = { ...summary, platforms: probe.platforms };
        return probe.platforms.find((each) => each.platform === platform)!;
      } catch {
        return {
          platform,
          available: false,
          reason: "Cannot reach device host. Test its SSH connection in Settings.",
        };
      }
    },
    /** Runs a program on the host (T3's `ready.run`). */
    run(
      command: string,
      args: readonly string[],
      run: { stdin?: string; timeoutMs?: number } = {},
    ) {
      return runSsh(config, shell(`exec ${[command, ...args].map(quoteRemoteArg).join(" ")}`), {
        ...options,
        ...run,
      });
    },
    /** Agent access was turned off: the daemon stops, the hub runs on. */
    stopAgent: () =>
      exclusive(async () => {
        if (!wantsAgent) return;
        wantsAgent = false;
        ready = undefined;
        closeTunnel();
        await bootstrap(config, owner, "stop-agent", options).catch(() => undefined);
      }),
    /** Stops the tunnel and the host's helpers; devices keep running, the user owns those. */
    stop: () =>
      exclusive(async () => {
        stopped = true;
        ready = undefined;
        if (reconnecting !== undefined) clearTimeout(reconnecting);
        reconnecting = undefined;
        closeTunnel();
        if (activated) await bootstrap(config, owner, "stop", options).catch(() => undefined);
        activated = false;
        wantsAgent = false;
      }),
  };
}

export type SshHost = ReturnType<typeof createSshHost>;
