// Finding the Android SDK and reading devices follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/device/LocalDeviceHost.ts (where the SDK is looked for, the platform checks and
// their messages) and DeviceService.ts (AVDs listed besides running emulators, boot failures).
// T3 drives simulators through its device hub; this is the node's own path beside it (D408), and
// the fallback when the hub cannot run (D1207).
import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import {
  DeviceError,
  LOCAL_DEVICE_HOST_ID,
  type DeviceHostSummary,
  type DeviceInput,
  type DevicePlatform,
  type DeviceSummary,
} from "@jhin/preview-api";

const COMMAND_TIMEOUT_MS = 30_000;
const BOOT_TIMEOUT_MS = 180_000;

export interface ToolPaths {
  /** The Android SDK; else ANDROID_HOME, ANDROID_SDK_ROOT, the usual folders, or adb on PATH. */
  readonly androidSdk?: string | undefined;
  readonly adb?: string | undefined;
  readonly emulator?: string | undefined;
  readonly xcrun?: string | undefined;
}

/** Runs a tool and gives its output; fails with the device error T3 reports. */
function run(
  file: string,
  args: readonly string[],
  options: { encoding?: "buffer"; timeout?: number } = {},
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    ChildProcess.execFile(
      file,
      [...args],
      {
        encoding: "buffer",
        timeout: options.timeout ?? COMMAND_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const code = typeof error.code === "number" ? error.code : undefined;
          reject(
            new DeviceError(
              "DEVICE_OPERATION_FAILED",
              `Device ${Path.basename(file)} ${args[0] ?? ""} failed: The device command failed${code === undefined ? "" : ` (exit code ${code})`}.`,
              { stderr: stderr.toString("utf8").slice(0, 2000) },
            ),
          );
          return;
        }
        resolve({ stdout, stderr: stderr.toString("utf8") });
      },
    );
  });
}

const text = async (file: string, args: readonly string[]) =>
  (await run(file, args)).stdout.toString("utf8");

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(Path.delimiter)) {
    const candidate = Path.join(dir, name);
    if (dir !== "" && Fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The SDK folder, as T3 looks for it. */
function androidSdk(paths: ToolPaths): string | undefined {
  const candidates = [
    paths.androidSdk,
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    Path.join(Os.homedir(), "Library", "Android", "sdk"),
    Path.join(Os.homedir(), "Android", "Sdk"),
    process.env.LOCALAPPDATA === undefined
      ? undefined
      : Path.join(process.env.LOCALAPPDATA, "Android", "Sdk"),
  ];
  const adb = onPath("adb");
  if (adb !== undefined) candidates.push(Path.dirname(Path.dirname(Fs.realpathSync(adb))));
  return candidates.find((dir) => dir !== undefined && Fs.existsSync(dir));
}

interface Tools {
  readonly adb?: string;
  readonly emulator?: string;
  readonly xcrun?: string;
  readonly androidReason?: string;
  readonly iosReason?: string;
}

function findTools(paths: ToolPaths): Tools {
  const sdk = androidSdk(paths);
  const exe = process.platform === "win32" ? ".exe" : "";
  const adb =
    paths.adb ?? (sdk === undefined ? undefined : Path.join(sdk, "platform-tools", `adb${exe}`));
  const emulator =
    paths.emulator ??
    (sdk === undefined ? undefined : Path.join(sdk, "emulator", `emulator${exe}`));
  const hasAdb = adb !== undefined && Fs.existsSync(adb);
  const androidReason =
    sdk === undefined && paths.adb === undefined
      ? "Android SDK was not found. Install it with Android Studio or set ANDROID_HOME to your SDK directory."
      : !hasAdb
        ? "Android platform tools (adb) were not found in the Android SDK."
        : undefined;
  const xcrun = paths.xcrun ?? (process.platform === "darwin" ? onPath("xcrun") : undefined);
  const iosReason =
    paths.xcrun === undefined && process.platform !== "darwin"
      ? "iOS Simulators need macOS with Xcode."
      : xcrun === undefined || !Fs.existsSync(xcrun)
        ? "Xcode command line tools were not found."
        : undefined;
  return {
    ...(hasAdb ? { adb: adb! } : {}),
    ...(emulator !== undefined && Fs.existsSync(emulator) ? { emulator } : {}),
    ...(iosReason === undefined ? { xcrun: xcrun! } : {}),
    ...(androidReason === undefined ? {} : { androidReason }),
    ...(iosReason === undefined ? {} : { iosReason }),
  };
}

function hostSummary(tools: Tools): DeviceHostSummary {
  const platform = (name: DevicePlatform, reason: string | undefined) => ({
    platform: name,
    available: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
  });
  return {
    id: LOCAL_DEVICE_HOST_ID,
    kind: "local",
    label: "This node",
    platforms: [platform("ios", tools.iosReason), platform("android", tools.androidReason)],
  };
}

// --- Android --------------------------------------------------------------------------

async function avdName(adb: string, serial: string): Promise<string | undefined> {
  const out = await text(adb, ["-s", serial, "emu", "avd", "name"]).catch(() => "");
  return out.split(/\r?\n/)[0]?.trim() || undefined;
}

async function androidDevices(tools: Tools): Promise<DeviceSummary[]> {
  if (tools.adb === undefined) return [];
  const adb = tools.adb;
  const listed = await text(adb, ["devices", "-l"]);
  const running = await Promise.all(
    listed
      .split(/\r?\n/)
      .slice(1)
      .map((line) => /^(\S+)\s+device\b(.*)$/.exec(line.trim()))
      .filter((match) => match !== null)
      .map(async (match) => {
        const serial = match[1]!;
        const physical = !serial.startsWith("emulator-");
        const model = /\bmodel:(\S+)/.exec(match[2]!)?.[1]?.replaceAll("_", " ");
        const name = (physical ? model : await avdName(adb, serial)) ?? model ?? serial;
        const release = (
          await text(adb, ["-s", serial, "shell", "getprop", "ro.build.version.release"]).catch(
            () => "",
          )
        ).trim();
        return {
          hostId: LOCAL_DEVICE_HOST_ID,
          id: serial,
          platform: "android" as const,
          name,
          version: release === "" ? "Android" : `Android ${release}`,
          booted: true,
          physical,
        };
      }),
  );
  // AVDs not running are listed by name, as T3 adds them.
  const avds =
    tools.emulator === undefined
      ? []
      : (await text(tools.emulator, ["-list-avds"]).catch(() => ""))
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line !== "" && !line.startsWith("INFO"));
  const runningNames = new Set(running.map((device) => device.name));
  return [
    ...running,
    ...avds
      .filter((name) => !runningNames.has(name))
      .map((name) => ({
        hostId: LOCAL_DEVICE_HOST_ID,
        id: name,
        platform: "android" as const,
        name,
        version: "Android",
        booted: false,
        physical: false,
      })),
  ];
}

// --- iOS ----------------------------------------------------------------------------------

interface SimctlList {
  readonly devices?: Record<
    string,
    readonly { udid: string; name: string; state: string; isAvailable?: boolean }[]
  >;
}

function runtimeVersion(runtime: string): string {
  const match = /SimRuntime\.([A-Za-z]+)-(\d+(?:-\d+)*)$/.exec(runtime);
  return match === null ? runtime : `${match[1]} ${match[2]!.replaceAll("-", ".")}`;
}

async function iosDevices(tools: Tools): Promise<DeviceSummary[]> {
  if (tools.xcrun === undefined) return [];
  const list = JSON.parse(
    await text(tools.xcrun, ["simctl", "list", "devices", "available", "--json"]),
  ) as SimctlList;
  return Object.entries(list.devices ?? {}).flatMap(([runtime, devices]) =>
    devices
      .filter((device) => device.isAvailable !== false)
      .map((device) => ({
        hostId: LOCAL_DEVICE_HOST_ID,
        id: device.udid,
        platform: "ios" as const,
        name: device.name,
        version: runtimeVersion(runtime),
        booted: device.state === "Booted",
        physical: false,
      })),
  );
}

// --- Text through `adb shell input` ------------------------------------------------------

/**
 * `input text` reads `%s` as a space and types no newline: text goes in pieces, a literal
 * `%s` as `%` then `s`, and a newline as the Enter key.
 */
function inputTextPieces(typed: string): string[] {
  const pieces: string[] = [];
  for (const [index, line] of typed.split("\n").entries()) {
    if (index > 0) pieces.push("\n");
    for (const [at, part] of line.split("%s").entries()) {
      if (at > 0) pieces.push("%", "s");
      if (part !== "") pieces.push(part);
    }
  }
  return pieces;
}

/** adb hands the line to the device's shell: quoted whole, spaces as input's `%s`. */
const quoteForInput = (piece: string) =>
  `'${piece.replaceAll(" ", "%s").replaceAll("'", "'\\''")}'`;

// --- The host -----------------------------------------------------------------------------

/** The node's own simulators and emulators. */
export function createLocalHost(paths: () => ToolPaths) {
  const tools = () => findTools(paths());
  return {
    summary: () => hostSummary(tools()),

    async list(): Promise<{ devices: DeviceSummary[]; detail?: string }> {
      const found = tools();
      const errors: string[] = [];
      const lists = await Promise.all([
        iosDevices(found).catch((error: unknown) => {
          errors.push(String((error as Error).message));
          return [];
        }),
        androidDevices(found).catch((error: unknown) => {
          errors.push(String((error as Error).message));
          return [];
        }),
      ]);
      return {
        devices: lists.flat(),
        ...(errors.length === 0 ? {} : { detail: errors.join(" ") }),
      };
    },

    /** The programs the tools panel's actions run (D1332): adb and xcrun, where found. */
    programs: (): { adb?: string; xcrun?: string } => {
      const found = tools();
      return {
        ...(found.adb === undefined ? {} : { adb: found.adb }),
        ...(found.xcrun === undefined ? {} : { xcrun: found.xcrun }),
      };
    },

    /** The SDK folder the hub's helpers get on their PATH (T3's `deviceHostEnvironment`). */
    androidSdk: () => androidSdk(paths()),

    /**
     * An input through adb, when agent tools could not start (D1209): `input tap`, `swipe`,
     * `text` and `keyevent`. simctl has no input, so an iOS device refuses.
     */
    async input(device: DeviceSummary, input: DeviceInput): Promise<void> {
      if (device.platform === "ios") {
        throw new DeviceError(
          "DEVICE_UNAVAILABLE",
          "iOS input needs the agent tools, which could not start on this node. simctl cannot tap or type.",
        );
      }
      const adb = tools().adb;
      if (adb === undefined) {
        throw new DeviceError(
          "DEVICE_PLATFORM_UNAVAILABLE",
          `android devices are unavailable on host local: ${tools().androidReason ?? "adb was not found."}`,
        );
      }
      const shell = (args: string[]) => run(adb, ["-s", device.id, "shell", "input", ...args]);
      switch (input.type) {
        case "tap":
          await shell(["tap", String(Math.round(input.x)), String(Math.round(input.y))]);
          return;
        case "swipe":
          await shell([
            "swipe",
            ...[input.from.x, input.from.y, input.to.x, input.to.y].map((value) =>
              String(Math.round(value)),
            ),
          ]);
          return;
        case "text":
          for (const piece of inputTextPieces(input.text)) {
            await shell(piece === "\n" ? ["keyevent", "66"] : ["text", quoteForInput(piece)]);
          }
          return;
        case "button":
          await shell([
            "keyevent",
            input.button === "home" ? "3" : input.button === "back" ? "4" : "187",
          ]);
          return;
      }
    },

    /** Boots a device; an AVD becomes a serial once it runs. Resolves with the running device. */
    async boot(device: DeviceSummary): Promise<DeviceSummary> {
      const found = tools();
      if (device.platform === "ios") {
        const xcrun = found.xcrun!;
        await run(xcrun, ["simctl", "boot", device.id]).catch((error: unknown) => {
          // Booting a booted simulator is no failure.
          if (!/Booted/.test(String((error as DeviceError).details?.stderr))) throw error;
        });
        await run(xcrun, ["simctl", "bootstatus", device.id, "-b"], { timeout: BOOT_TIMEOUT_MS });
        return { ...device, booted: true };
      }
      if (found.emulator === undefined || found.adb === undefined) {
        throw new DeviceError(
          "DEVICE_PLATFORM_UNAVAILABLE",
          `android devices are unavailable on host local: ${found.androidReason ?? "The Android emulator was not found in the Android SDK."}`,
        );
      }
      const child = ChildProcess.spawn(found.emulator, ["-avd", device.id, "-no-snapshot-save"], {
        detached: true,
        stdio: "ignore",
      });
      // A file that cannot run is reported here, not thrown at the node.
      const spawn = { failed: false };
      child.once("error", () => {
        spawn.failed = true;
      });
      child.unref();
      const deadline = Date.now() + BOOT_TIMEOUT_MS;
      // The emulator reports nothing when it is ready: adb is asked until it says so.
      while (Date.now() < deadline && !spawn.failed && child.exitCode === null) {
        const running = await androidDevices(found).catch(() => []);
        const started = running.find((each) => each.booted && each.name === device.id);
        if (started !== undefined) {
          const ready = (
            await text(found.adb, [
              "-s",
              started.id,
              "shell",
              "getprop",
              "sys.boot_completed",
            ]).catch(() => "")
          ).trim();
          if (ready === "1") return started;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const stopped = spawn.failed || child.exitCode !== null;
      // One that is still starting after the deadline would come up unreported: it is stopped.
      if (!stopped) child.kill();
      throw new DeviceError(
        "DEVICE_BOOT_FAILED",
        `Device ${device.id} failed to boot: ${
          stopped
            ? "The simulator or emulator could not start. Check its configuration on the environment server."
            : "The device did not become ready in time."
        }`,
      );
    },

    async screenshot(device: DeviceSummary): Promise<Buffer> {
      const found = tools();
      if (device.platform === "ios") {
        return (
          await run(found.xcrun!, ["simctl", "io", device.id, "screenshot", "--type=png", "-"])
        ).stdout;
      }
      return (await run(found.adb!, ["-s", device.id, "exec-out", "screencap", "-p"])).stdout;
    },

    async shutdown(device: DeviceSummary): Promise<void> {
      const found = tools();
      if (device.platform === "ios") {
        await run(found.xcrun!, ["simctl", "shutdown", device.id]).catch(() => undefined);
        return;
      }
      if (device.physical) return;
      await run(found.adb!, ["-s", device.id, "emu", "kill"]).catch(() => undefined);
    },

    /** How an agent drives the device itself, and a quick start. */
    control(device: DeviceSummary): { command: string; targetArgs: string[]; quickStart: string } {
      const found = tools();
      const intro = `The user is watching ${device.name} (${device.version}) in the Device panel.`;
      if (device.platform === "ios") {
        const command = found.xcrun!;
        const simctl = `${command} simctl`;
        return {
          command,
          targetArgs: ["simctl", "<subcommand>", device.id],
          quickStart: [
            intro,
            `Drive it with ${simctl} <subcommand> ${device.id}. Use this exact executable path; login shells may reset PATH.`,
            "Typical loop:",
            `  ${simctl} launch ${device.id} <bundle-id>`,
            `  ${simctl} openurl ${device.id} <url>`,
            `  ${simctl} install ${device.id} <path-to-.app>`,
            "  call device_screenshot to see the screen",
            "simctl cannot tap or type; drive the app through its own test hooks or URLs.",
          ].join("\n"),
        };
      }
      const command = found.adb!;
      const target = `${command} -s ${device.id}`;
      return {
        command,
        targetArgs: ["-s", device.id],
        quickStart: [
          intro,
          `Drive it with ${target}. Use this exact executable path; login shells may reset PATH. Always pass -s ${device.id}.`,
          "Typical loop:",
          `  ${target} shell am start -a android.intent.action.VIEW -d <url>     # or: shell monkey -p <package> 1`,
          `  ${target} exec-out uiautomator dump /dev/tty                        # the view hierarchy with bounds`,
          `  ${target} shell input tap <x> <y>`,
          `  ${target} shell input text "text"`,
          `  ${target} install <path-to-.apk>`,
          "  call device_screenshot to see the screen",
        ].join("\n"),
      };
    },
  };
}
