// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/device/AgentDeviceTarget.ts
// (the per-host endpoint file and the per-thread session) and
// apps/server/src/mcp/toolkits/device/handlers.ts (the flags that pin agent-device to a device),
// without Effect. The commands are agent-device's own (`press`, `swipe`, `type`, `home`, `back`,
// `app-switcher`). docs/plans/preview.md, D1209.
import * as Crypto from "node:crypto";
import * as Fs from "node:fs";
import * as Path from "node:path";

import { DeviceError, type DeviceInput, type DeviceSummary } from "@jhin/preview-api";

import type { AgentDeviceEndpoint } from "./hub-host.ts";
import { runProgram, toolEnvironment } from "./toolchain.ts";

const COMMAND_TIMEOUT_MS = 60_000;

const key = (value: string) => Crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);

/** A stable file per host lets the endpoint change without retargeting other commands. */
const agentDeviceConfigPath = (stateDir: string, hostId: string) =>
  Path.join(stateDir, "hosts", `${key(hostId)}.json`);

const agentDeviceSession = (threadId: string, hostId: string, deviceId: string) =>
  `jhin-${key(JSON.stringify([threadId, hostId, deviceId]))}`;

/** T3's `agentDeviceTargetArgs`. */
const agentDeviceTargetArgs = (device: DeviceSummary): string[] =>
  device.platform === "ios"
    ? ["--platform", "ios", "--udid", device.id]
    : ["--platform", "android", "--serial", device.id];

/** Written readable by the owner only: it holds the daemon's token. */
function writeAgentDeviceConfig(file: string, endpoint: AgentDeviceEndpoint): void {
  Fs.mkdirSync(Path.dirname(file), { recursive: true });
  const content = JSON.stringify({
    daemonBaseUrl: endpoint.baseUrl,
    daemonAuthToken: endpoint.token,
  });
  try {
    if (Fs.readFileSync(file, "utf8") === content) return;
  } catch {
    // Not written yet.
  }
  const temporary = Path.join(Path.dirname(file), `.endpoint-${Crypto.randomUUID()}`);
  try {
    Fs.writeFileSync(temporary, content, { mode: 0o600 });
    Fs.renameSync(temporary, file);
  } finally {
    Fs.rmSync(temporary, { force: true });
  }
}

/** The agent-device command for an input. Coordinates are the device's, as its snapshots give. */
function agentDeviceArgs(input: DeviceInput): string[] {
  switch (input.type) {
    case "tap":
      return ["press", String(input.x), String(input.y)];
    case "swipe":
      return [
        "swipe",
        String(input.from.x),
        String(input.from.y),
        String(input.to.x),
        String(input.to.y),
      ];
    case "text":
      return ["type", input.text];
    case "button":
      return [input.button === "appSwitcher" ? "app-switcher" : input.button];
  }
}

const describe = (input: DeviceInput) =>
  input.type === "button" ? (agentDeviceArgs(input)[0] ?? input.button) : agentDeviceArgs(input)[0];

/** Runs one input through agent-device, pinned to the device and the thread's session. */
export async function runAgentDeviceInput(options: {
  readonly endpoint: AgentDeviceEndpoint;
  readonly stateDir: string;
  readonly threadId: string;
  readonly device: DeviceSummary;
  readonly input: DeviceInput;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { endpoint, device } = options;
  const config = agentDeviceConfigPath(options.stateDir, device.hostId);
  writeAgentDeviceConfig(config, endpoint);
  const env: NodeJS.ProcessEnv = {
    ...toolEnvironment(options.env ?? process.env),
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
  };
  // The endpoint comes from --config only, as T3's launcher clears these.
  delete env.AGENT_DEVICE_DAEMON_BASE_URL;
  delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
  delete env.AGENT_DEVICE_CONFIG;
  const result = await runProgram(
    endpoint.nodePath,
    [
      endpoint.entryPath,
      ...agentDeviceTargetArgs(device),
      "--config",
      config,
      "--session",
      agentDeviceSession(options.threadId, device.hostId, device.id),
      "--json",
      // Everything after `--` is the command and its operands: text an agent types that starts
      // with `-` stays text and never retargets the command.
      "--",
      ...agentDeviceArgs(options.input),
    ],
    { env, timeoutMs: COMMAND_TIMEOUT_MS },
  ).catch((cause: unknown) => {
    // Nothing ran: the device never got the input.
    throw new DeviceError(
      "DEVICE_UNAVAILABLE",
      `Device agent-device ${describe(options.input)} failed: The device command could not run.`,
      { cause: String(cause) },
    );
  });
  answer(result, options.input);
}

/**
 * Runs one input through agent-device on an SSH host (preview.md D1499): its CLI there, with the
 * host's Node.js, against the daemon of the host's state folder, with D1209's arguments.
 */
export async function runRemoteAgentDeviceInput(options: {
  readonly run: (
    command: string,
    args: readonly string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  readonly nodePath: string;
  readonly entryPath: string;
  readonly stateDir: string;
  readonly threadId: string;
  readonly device: DeviceSummary;
  readonly input: DeviceInput;
}): Promise<void> {
  const { device } = options;
  const result = await options.run(options.nodePath, [
    options.entryPath,
    ...agentDeviceTargetArgs(device),
    "--state-dir",
    options.stateDir,
    "--session",
    agentDeviceSession(options.threadId, device.hostId, device.id),
    "--json",
    "--",
    ...agentDeviceArgs(options.input),
  ]);
  // ssh's own failure (127: no connection, no ssh) means the command never ran there.
  if (result.code === 127 || result.code === 255) {
    throw new DeviceError(
      "DEVICE_UNAVAILABLE",
      `Device agent-device ${describe(options.input)} failed: The device command could not run.`,
      { cause: result.stderr.slice(0, 2000) },
    );
  }
  answer(result, options.input);
}

/** What agent-device's exit and JSON answer mean (D1209). */
function answer(
  result: { code: number | null; stdout: string; stderr: string },
  input: DeviceInput,
): void {
  const options = { input };
  if (result.code === 0) return;
  let reason = `The device command failed (exit code ${result.code ?? "unknown"}).`;
  let code: unknown;
  try {
    const error = (JSON.parse(result.stdout) as { error?: { message?: unknown; code?: unknown } })
      .error;
    code = error?.code;
    if (typeof error?.message === "string" && error.message !== "") reason = error.message;
  } catch {
    // Not the CLI's JSON: the exit code says enough.
  }
  // agent-device refused the arguments before doing anything: the input never ran, so adb
  // may carry it (and a wrong argument order would not take input down with it).
  if (code === "INVALID_ARGS") {
    throw new DeviceError(
      "DEVICE_UNAVAILABLE",
      `agent-device did not accept the ${describe(options.input)} command: ${reason}`,
    );
  }
  throw new DeviceError(
    "DEVICE_OPERATION_FAILED",
    `Device agent-device ${describe(options.input)} failed: ${reason}`,
    { stderr: result.stderr.slice(0, 2000) },
  );
}
