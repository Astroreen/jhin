// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/device/LocalDeviceHost.ts
// (starting the device hub on a loopback port and the agent-device daemon, their environment,
// the stale hub left by a previous server, the readiness waits and the startup errors' wording),
// DeviceHost.ts (the errors) and packages/shared/src/nodeRuntime.ts (finding Node), without
// Effect. docs/plans/preview.md, D1207.
import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Net from "node:net";
import * as Path from "node:path";

import {
  AGENT_DEVICE_SPEC,
  HUB_SPEC,
  installMessage,
  runProgram,
  toolEnvironment,
  type Toolchain,
} from "./toolchain.ts";

const HUB_READY_TIMEOUT_MS = 30_000;
const DAEMON_READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 100;
const STOP_GRACE_MS = 5_000;

export type HubStatus = "idle" | "installing" | "starting" | "ready" | "failed";

/** A host step that failed; the panel shows T3's "Device support failed during {step}." */
class DeviceHostError extends Error {
  readonly step: string;
  constructor(step: string, options?: { cause?: unknown }) {
    super(`Device host local failed while ${step}.`, options);
    this.name = "DeviceHostError";
    this.step = step;
  }
}

/** T3's `nodeRuntimeUnavailableMessage("Local device support")`. */
const NODE_UNAVAILABLE =
  "Local device support requires Node.js. Install Node.js and make sure node is on PATH, then retry.";

export interface AgentDeviceEndpoint {
  readonly baseUrl: string;
  readonly token: string;
  readonly entryPath: string;
  readonly nodePath: string;
}

export interface HubHostOptions {
  readonly toolchain: Toolchain;
  /** Jhin's home, whose `tools/` holds the installs. */
  readonly home: string;
  /** Where agent-device keeps its daemon state and the hub its pid file. */
  readonly stateDir: string;
  /** A configured Node (read at each start), else this process when it is Node, else PATH's. */
  readonly node?: () => string | undefined;
  /** The Android SDK found for the node (read at each start), put on the helpers' PATH. */
  readonly androidSdk?: () => string | undefined;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly onStatus?: (status: HubStatus, detail?: string) => void;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** The Node that runs the hub: T3 runs its own executable when it is Node, else `node` on PATH. */
function resolveNode(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (configured !== undefined) return configured;
  if (process.release.name === "node" && process.versions.electron === undefined) {
    return process.execPath;
  }
  const name = process.platform === "win32" ? "node.exe" : "node";
  for (const dir of (env.PATH ?? env.Path ?? "").split(Path.delimiter)) {
    if (dir === "") continue;
    const candidate = Path.join(dir, name);
    if (Fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** T3's `deviceHostEnvironment`: the SDK's tools first on PATH. */
function hostEnvironment(
  env: NodeJS.ProcessEnv,
  sdkRoot: string | undefined,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  if (sdkRoot === undefined) return env;
  return {
    ...env,
    ANDROID_HOME: sdkRoot,
    PATH: [
      Path.join(sdkRoot, "platform-tools"),
      Path.join(sdkRoot, "emulator"),
      env.PATH ?? env.Path ?? "",
    ].join(platform === "win32" ? ";" : ":"),
  };
}

/** T3's `hubEnvironment`: no colours, and the runtime folder SSH sessions may lack. */
function hubEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, FORCE_COLOR: "0", NO_COLOR: "1" };
  const uid = process.getuid?.();
  if (platform === "linux" && next.XDG_RUNTIME_DIR === undefined && uid !== undefined) {
    // The emulator publishes its gRPC token there.
    const runtimeDir = `/run/user/${uid}`;
    const stat = Fs.statSync(runtimeDir, { throwIfNoEntry: false });
    if (stat?.isDirectory() === true && stat.uid === uid) next.XDG_RUNTIME_DIR = runtimeDir;
  }
  return next;
}

/** Only a Mac can list Apple simulators; elsewhere the hub's attempt surfaces as an error. */
const hubPlatformArguments = (platform: NodeJS.Platform) =>
  platform === "darwin" ? [] : ["--platform", "android"];

/** A free loopback port, as T3's `reserveLoopbackPort` finds one. */
function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = Net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address() as Net.AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });
}

async function answers(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(Fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

interface DaemonFile {
  readonly httpPort: number;
  readonly token: string;
  readonly pid?: number;
}

const daemonFile = (value: unknown): DaemonFile | undefined => {
  const file = value as Partial<DaemonFile> | undefined;
  return typeof file?.httpPort === "number" &&
    Number.isInteger(file.httpPort) &&
    typeof file.token === "string"
    ? (file as DaemonFile)
    : undefined;
};

/** T3's `AgentDeviceStartError` reasons, read from the CLI's JSON failure. */
function agentStartFailure(stdout: string, stateDir: string, exitCode: number | null): Error {
  let reason = "command_failed";
  try {
    const details = (
      JSON.parse(stdout) as {
        error?: { details?: { reason?: string; inspection?: { reason?: string } } };
      }
    ).error?.details;
    if (details?.reason === "daemon_registration_unproven") {
      reason =
        details.inspection?.reason === "non-directory"
          ? "daemon_lock_not_directory"
          : "daemon_registration_unproven";
    } else if (details?.reason === "daemon_retirement_unconfirmed") {
      reason = "daemon_retirement_unconfirmed";
    }
  } catch {
    // Output that is not the CLI's JSON is not shown: it may hold anything.
  }
  const exit = exitCode === null ? "" : ` (exit code ${exitCode})`;
  const detail =
    reason === "daemon_lock_not_directory"
      ? "Daemon registration ownership could not be verified: daemon.lock is not a directory."
      : reason === "daemon_registration_unproven"
        ? "Daemon registration ownership could not be verified."
        : reason === "daemon_retirement_unconfirmed"
          ? "Daemon replacement could not be confirmed."
          : "The AgentDevice startup command failed.";
  const recovery =
    reason === "command_failed"
      ? `Inspect daemon diagnostics in ${stateDir}.`
      : `Inspect daemon.lock and daemon diagnostics in ${stateDir}. Stop older clients and daemons with their original CLI before manually repairing retained state.`;
  return new Error(`Agent tools failed to start${exit}. ${detail} ${recovery}`);
}

interface HubProcess {
  readonly child: ChildProcess.ChildProcess;
  readonly origin: string;
  readonly exited: Promise<void>;
}

/**
 * The node's device hub (`expo-device-hub`) and agent-device daemon. The hub binds loopback
 * only; clients reach it through the node's authenticated proxy (D1208).
 */
export function createHubHost(options: HubHostOptions) {
  const platform = options.platform ?? process.platform;
  const environment = () =>
    hostEnvironment(toolEnvironment(options.env ?? process.env), options.androidSdk?.(), platform);
  const hubState = Path.join(options.stateDir, "hub.json");
  const daemonState = Path.join(options.stateDir, "daemon.json");
  const log = options.log ?? (() => undefined);
  let hub: HubProcess | undefined;
  let agent: AgentDeviceEndpoint | undefined;
  let agentTool: { entryPath: string; nodePath: string } | undefined;
  let stopping = false;
  /** The plugin went: no later stop resumes, whatever order the stops run in. */
  let finished = false;
  let lock: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = lock.then(work, work);
    lock = next.catch(() => undefined);
    return next;
  };
  const status = (next: HubStatus, detail?: string) => options.onStatus?.(next, detail);

  const nodePath = () => {
    const found = resolveNode(options.node?.(), environment());
    if (found === undefined) throw new Error(NODE_UNAVAILABLE);
    return found;
  };

  /**
   * A hub left behind by a server that died without stopping it is known by its pid and the
   * entry path on its command line, so a recycled pid of something else is never touched.
   */
  const reapStaleHub = async () => {
    const previous = readJson(hubState) as { pid?: unknown; entryPath?: unknown } | undefined;
    if (typeof previous?.pid === "number" && typeof previous.entryPath === "string") {
      if (isAlive(previous.pid)) {
        const commandLine = await runProgram("ps", ["-o", "command=", "-p", String(previous.pid)], {
          timeoutMs: 5_000,
        }).catch(() => undefined);
        // Without `ps` (Windows) the hub cannot be told from a recycled pid, so it is left
        // alone: a hub orphaned there is not reaped (as T3's is not).
        if (commandLine === undefined) return;
        if (commandLine?.stdout.includes(previous.entryPath) === true) {
          log("stopping a device hub left behind by a previous node", { pid: previous.pid });
          try {
            process.kill(previous.pid, "SIGTERM");
          } catch {
            // Gone meanwhile.
          }
        }
      }
    }
    Fs.rmSync(hubState, { force: true });
  };

  const spawnHub = async (entryPath: string, node: string): Promise<HubProcess> => {
    await reapStaleHub();
    Fs.mkdirSync(options.stateDir, { recursive: true });
    const port = await reserveLoopbackPort().catch((cause: unknown) => {
      throw new DeviceHostError("reserving a port for the device hub", { cause });
    });
    const origin = `http://127.0.0.1:${port}`;
    const child = ChildProcess.spawn(
      node,
      [
        entryPath,
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        "--hide-sidebar",
        "--hide-boot-device",
        ...hubPlatformArguments(platform),
      ],
      {
        env: hubEnvironment(environment(), platform),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      },
    );
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const failed = new Promise<"exited">((resolve) => {
      child.once("error", () => resolve("exited"));
      void exited.then(() => resolve("exited"));
    });
    for (const output of [child.stdout, child.stderr]) {
      output?.setEncoding("utf8");
      output?.on("data", (text: string) => {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim() !== "") log("device hub output", { pid: child.pid, output: line.trim() });
        }
      });
    }
    const started: HubProcess = { child, origin, exited };
    // Recorded at once: a node that dies while the hub starts still finds it next time.
    Fs.writeFileSync(hubState, JSON.stringify({ pid: child.pid, port, entryPath }));
    try {
      const deadline = Date.now() + HUB_READY_TIMEOUT_MS;
      for (;;) {
        const answer = await Promise.race([answers(`${origin}/readyz`, 2_000), failed]);
        if (answer === "exited") throw new Error("The device hub exited while starting.");
        if (stopping) throw new Error("The device hub was stopped while starting.");
        if (answer) break;
        if (Date.now() > deadline) throw new Error("The device hub did not answer in time.");
        await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
      }
    } catch (cause) {
      await killHub(started);
      throw new DeviceHostError("waiting for the device hub to answer", { cause });
    }
    log("device hub started", { pid: child.pid, port });
    // A hub that exits is started again by the next request that needs it.
    void exited.then(() => {
      if (hub !== started) return;
      hub = undefined;
      agent = undefined;
      if (!stopping) status("idle", "The device hub stopped; it starts again when a device opens.");
    });
    return started;
  };

  const killHub = async (running: HubProcess) => {
    if (running.child.exitCode !== null || running.child.signalCode !== null) return;
    running.child.kill("SIGTERM");
    const timer = setTimeout(() => running.child.kill("SIGKILL"), STOP_GRACE_MS);
    await running.exited;
    clearTimeout(timer);
  };

  const ensureHubLocked = async (): Promise<HubProcess> => {
    if (hub !== undefined && hub.child.exitCode === null && hub.child.signalCode === null) {
      return hub;
    }
    if (stopping) throw new DeviceHostError("starting the device hub");
    try {
      const node = nodePath();
      if (!options.toolchain.installed(HUB_SPEC)) {
        status("installing", installMessage(options.home, "device hub", HUB_SPEC));
      }
      const tool = await options.toolchain.ensure(HUB_SPEC).catch((cause: unknown) => {
        throw new DeviceHostError("installing device support", { cause });
      });
      if (stopping) throw new DeviceHostError("starting the device hub");
      status("starting");
      hub = await spawnHub(tool.entryPath, node);
      // One that died between answering and being kept is no running hub.
      if (hub.child.exitCode !== null || hub.child.signalCode !== null) {
        hub = undefined;
        throw new DeviceHostError("waiting for the device hub to answer");
      }
      status("ready");
      return hub;
    } catch (error) {
      status("failed", failureDetail(error));
      throw error;
    }
  };

  const startAgentDaemon = async (entryPath: string, node: string) => {
    Fs.mkdirSync(options.stateDir, { recursive: true });
    const toEndpoint = (file: DaemonFile): AgentDeviceEndpoint => ({
      baseUrl: `http://127.0.0.1:${file.httpPort}`,
      token: file.token,
      entryPath,
      nodePath: node,
    });
    const existing = daemonFile(readJson(daemonState));
    if (existing !== undefined) {
      if (await answers(`http://127.0.0.1:${existing.httpPort}/health`, 2_000)) {
        return toEndpoint(existing);
      }
      Fs.rmSync(daemonState, { force: true });
    }
    // There is no `daemon start`; the first command in a state dir spawns the daemon and
    // blocks until it answers. `devices` is the cheapest one.
    let result: Awaited<ReturnType<typeof runProgram>> | undefined;
    let failure: unknown;
    try {
      result = await runProgram(node, [entryPath, "devices", "--json"], {
        env: {
          ...environment(),
          AGENT_DEVICE_STATE_DIR: options.stateDir,
          AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
          // The daemon idles out after five minutes by default; the node owns its lifetime.
          AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
          AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
        timeoutMs: DAEMON_READY_TIMEOUT_MS,
      });
    } catch (error) {
      failure = error;
    }
    // Discovery can fail after the daemon starts; a published endpoint still serves.
    const started = daemonFile(readJson(daemonState));
    if (started !== undefined) return toEndpoint(started);
    if (result === undefined) throw new DeviceHostError("starting agent tools", { cause: failure });
    if (result.code !== 0) throw agentStartFailure(result.stdout, options.stateDir, result.code);
    const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;
    for (;;) {
      const file = daemonFile(readJson(daemonState));
      if (file !== undefined) return toEndpoint(file);
      if (Date.now() > deadline) {
        throw new Error(
          `Device host local did not start agent tools within ${DAEMON_READY_TIMEOUT_MS} ms.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
  };

  const stopAgentDaemon = async () => {
    if (agentTool === undefined) return;
    await runProgram(
      agentTool.nodePath,
      [agentTool.entryPath, "daemon", "stop", "--state-dir", options.stateDir],
      { env: { ...environment(), AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1" }, timeoutMs: 10_000 },
    ).catch(() => undefined);
  };

  return {
    /** The running hub's loopback origin, without starting one. */
    current: (): string | undefined =>
      hub !== undefined && hub.child.exitCode === null ? hub.origin : undefined,

    /** The hub, installed and started first when needed. */
    ensureHub: (): Promise<string> => serialized(async () => (await ensureHubLocked()).origin),

    /** The agent-device daemon beside the hub, installed and started first when needed. */
    ensureAgent: (): Promise<AgentDeviceEndpoint> =>
      serialized(async () => {
        await ensureHubLocked();
        // A daemon that died while the hub ran is started again.
        if (agent !== undefined && (await answers(`${agent.baseUrl}/health`, 2_000))) return agent;
        agent = undefined;
        try {
          const node = nodePath();
          if (!options.toolchain.installed(AGENT_DEVICE_SPEC)) {
            status("installing", installMessage(options.home, "agent tools", AGENT_DEVICE_SPEC));
          }
          const tool = await options.toolchain.ensure(AGENT_DEVICE_SPEC).catch((cause: unknown) => {
            throw new DeviceHostError("installing agent tools", { cause });
          });
          agentTool = { entryPath: tool.entryPath, nodePath: node };
          status("starting");
          agent = await startAgentDaemon(tool.entryPath, node);
          status("ready");
          return agent;
        } catch (error) {
          status("failed", failureDetail(error));
          throw error;
        }
      }),

    /** Whether the daemon behind `endpoint` answers its health check. */
    agentAlive: (endpoint: AgentDeviceEndpoint): Promise<boolean> =>
      answers(`${endpoint.baseUrl}/health`, 2_000),

    /**
     * Stops the hub and the daemon. Devices keep running; the user owns those. An install or
     * start in progress is cut short rather than waited for. `resume` lets a later request
     * start them again (the setting turned back on); the plugin going never resumes.
     */
    stop: (resume = false): Promise<void> => {
      stopping = true;
      if (!resume) finished = true;
      options.toolchain.cancel();
      return serialized(async () => {
        const running = hub;
        hub = undefined;
        agent = undefined;
        if (running !== undefined) await killHub(running);
        Fs.rmSync(hubState, { force: true });
        await stopAgentDaemon();
        agentTool = undefined;
        if (resume && !finished) stopping = false;
      });
    },
  };
}

/** What the panel shows for a failed start: T3's step, never a tool's raw output. */
export function failureDetail(error: unknown): string {
  if (error instanceof DeviceHostError) return `Device support failed during ${error.step}.`;
  return error instanceof Error ? error.message : String(error);
}
