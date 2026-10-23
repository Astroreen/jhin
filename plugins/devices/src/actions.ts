// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/device/DeviceActions.ts
// (the device tools' actions and the settings read back), without Effect. docs/plans/preview.md, D1332.
//
// serve-sim's preview drives its "Simulator" panel by sending shell commands over a token-gated
// socket. Proxying that would hand any client arbitrary command execution on the node, so the
// node runs the same underlying commands itself, typed per action: `xcrun simctl ui` and
// `simctl privacy` for iOS, the `serve-sim-ax-settings` helper that serve-sim bundles for the
// accessibility toggles, and `adb shell` for Android.
import {
  DeviceError,
  type DeviceAction,
  type DeviceForegroundApp,
  type DeviceOrientation,
  type DevicePlatform,
  type DeviceSettings,
  type DeviceTextSize,
} from "@jhin/preview-api";

interface ActionRunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** What a device's actions run with: its host's programs, and serve-sim's helpers when the hub is installed. */
export interface ActionHost {
  /** Runs `xcrun`, `adb` or the node; resolves with the exit code. */
  run(
    command: "xcrun" | "adb" | "node",
    args: readonly string[],
    options?: { stdin?: string },
  ): Promise<ActionRunResult>;
  readonly helpers: {
    readonly serveSimAxSettings: string | null;
    readonly serveSimCli: string | null;
  };
}

type ActionType = DeviceAction["type"];

const IOS_ACTIONS: ReadonlySet<ActionType> = new Set([
  "setAppearance",
  "setTextSize",
  "setToggle",
  "setLiquidGlass",
  "setColorFilter",
  "setLocation",
  "clearLocation",
  "setPermission",
  "openUrl",
  "launchApp",
  "terminateApp",
  "sendPush",
]);

const ANDROID_ACTIONS: ReadonlySet<ActionType> = new Set([
  "setAppearance",
  "setTextSize",
  "setToggle",
  "setOrientation",
  "setLocation",
  "setPermission",
  "openUrl",
  "launchApp",
  "terminateApp",
]);

const IOS_TOGGLES = new Set([
  "reduceMotion",
  "increaseContrast",
  "reduceTransparency",
  "showBorders",
  "voiceOver",
]);
const ANDROID_TOGGLES = new Set(["reduceMotion", "networkEnabled"]);

export const supportsAction = (platform: DevicePlatform, input: DeviceAction): boolean => {
  const actions = platform === "ios" ? IOS_ACTIONS : ANDROID_ACTIONS;
  if (!actions.has(input.type)) return false;
  if (input.type === "setToggle") {
    return (platform === "ios" ? IOS_TOGGLES : ANDROID_TOGGLES).has(input.setting);
  }
  return true;
};

/** T3's `DeviceActionUnavailableError`, as a device error with its reason. */
const unavailable = (
  operation: string,
  platform: DevicePlatform,
  reason: "unsupported" | "helper_missing",
) =>
  new DeviceError(
    "DEVICE_ACTION_UNAVAILABLE",
    reason === "helper_missing"
      ? `Device action ${operation} needs the device hub's helpers: turn on the device hub and open the device once.`
      : `Device action ${operation} is not available on ${platform === "ios" ? "iOS" : "Android"}.`,
    { operation, platform, reason },
  );

const ok = (operation: string) => (result: ActionRunResult) => {
  if (result.code === 0) return result.stdout;
  throw new DeviceError(
    "DEVICE_OPERATION_FAILED",
    `Device action ${operation} failed (exit code ${result.code ?? "none"}).`,
    { operation, exitCode: result.code, stderr: result.stderr.slice(0, 2000) },
  );
};

/** A coordinate in plain decimals (no `1e-7`), to about ten centimetres. */
const coordinate = (value: number): string => String(Number(value.toFixed(6)));

const IOS_TEXT_SIZES: Record<DeviceTextSize, string> = {
  small: "small",
  default: "large",
  large: "extra-extra-large",
  "extra-large": "accessibility-large",
};
const ANDROID_TEXT_SIZES: Record<DeviceTextSize, string> = {
  small: "0.85",
  default: "1.0",
  large: "1.15",
  "extra-large": "1.3",
};

const textSizeFromIos = (category: string): DeviceTextSize | undefined => {
  const entry = (Object.entries(IOS_TEXT_SIZES) as Array<[DeviceTextSize, string]>).find(
    ([, value]) => value === category,
  );
  if (entry) return entry[0];
  if (category.startsWith("accessibility")) return "extra-large";
  // The small ones first: `extra-small` contains "extra" too (T3 reads it as large).
  if (category === "extra-small" || category === "small" || category === "medium") return "small";
  if (category.includes("extra")) return "large";
  return "default";
};

const textSizeFromAndroid = (scale: number): DeviceTextSize => {
  if (scale <= 0.9) return "small";
  if (scale >= 1.25) return "extra-large";
  if (scale >= 1.1) return "large";
  return "default";
};

const IOS_TOGGLE_OPTIONS: Record<string, string> = {
  reduceMotion: "reduce-motion",
  increaseContrast: "increase-contrast",
  reduceTransparency: "reduce-transparency",
  showBorders: "show-borders",
  voiceOver: "voiceover",
};

const IOS_TCC_SERVICES: Record<string, string> = {
  camera: "camera",
  microphone: "microphone",
  photos: "photos",
  contacts: "contacts",
  calendar: "calendar",
  reminders: "reminders",
  motion: "motion",
  "media-library": "media-library",
  faceid: "faceid",
};

const ANDROID_PERMISSIONS: Record<string, ReadonlyArray<string>> = {
  camera: ["android.permission.CAMERA"],
  microphone: ["android.permission.RECORD_AUDIO"],
  photos: ["android.permission.READ_MEDIA_IMAGES", "android.permission.READ_EXTERNAL_STORAGE"],
  contacts: ["android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"],
  calendar: ["android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR"],
  location: [
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
  ],
  notifications: ["android.permission.POST_NOTIFICATIONS"],
  motion: ["android.permission.ACTIVITY_RECOGNITION"],
};

const ANDROID_GRAVITY: Record<DeviceOrientation, string> = {
  portrait: "0:9.81:0",
  landscape_left: "9.81:0:0",
  portrait_upside_down: "0:-9.81:0",
  landscape_right: "-9.81:0:0",
};
const ANDROID_ROTATION: Record<DeviceOrientation, string> = {
  portrait: "0",
  landscape_left: "1",
  portrait_upside_down: "2",
  landscape_right: "3",
};

/** Runs one of the tools panel's actions on a device (T3's `runDeviceAction`). */
export async function runDeviceAction(
  host: ActionHost,
  platform: DevicePlatform,
  deviceId: string,
  input: DeviceAction,
): Promise<void> {
  if (!supportsAction(platform, input)) throw unavailable(input.type, platform, "unsupported");
  if (platform === "ios") await runIos(host, deviceId, input);
  else await runAndroid(host, deviceId, input);
}

const simctl = async (host: ActionHost, udid: string, args: readonly string[], operation: string) =>
  ok(operation)(await host.run("xcrun", ["simctl", ...args.slice(0, 1), udid, ...args.slice(1)]));

const axSettings = async (host: ActionHost, udid: string, args: readonly string[]) => {
  const helper = host.helpers.serveSimAxSettings;
  if (!helper) throw unavailable("accessibility", "ios", "helper_missing");
  return ok("accessibility")(await host.run("xcrun", ["simctl", "spawn", udid, helper, ...args]));
};

async function runIos(host: ActionHost, udid: string, input: DeviceAction): Promise<void> {
  switch (input.type) {
    case "setAppearance":
      await simctl(host, udid, ["ui", "appearance", input.value], "appearance");
      return;
    case "setTextSize":
      await simctl(host, udid, ["ui", "content_size", IOS_TEXT_SIZES[input.value]], "text size");
      return;
    case "setToggle":
      if (input.setting === "increaseContrast") {
        await simctl(
          host,
          udid,
          ["ui", "increase_contrast", input.value ? "enabled" : "disabled"],
          "increase contrast",
        );
        return;
      }
      await axSettings(host, udid, [
        "set",
        IOS_TOGGLE_OPTIONS[input.setting]!,
        input.value ? "on" : "off",
      ]);
      return;
    case "setLiquidGlass":
      await axSettings(host, udid, ["set", "liquid-glass", input.value]);
      return;
    case "setColorFilter":
      await axSettings(host, udid, ["set", "color-filter", input.value]);
      return;
    case "setLocation":
      await simctl(
        host,
        udid,
        ["location", "set", `${coordinate(input.latitude)},${coordinate(input.longitude)}`],
        "location",
      );
      return;
    case "clearLocation":
      await simctl(host, udid, ["location", "clear"], "location");
      return;
    case "setPermission": {
      if (input.permission === "notifications") {
        // simctl has no notification permission verb; serve-sim's CLI edits
        // the BulletinBoard plist for it.
        const cli = host.helpers.serveSimCli;
        if (!cli) throw unavailable("permission", "ios", "helper_missing");
        ok("permission")(
          await host.run("node", [
            cli,
            "permissions",
            input.decision,
            input.permission,
            input.appId,
            "-d",
            udid,
          ]),
        );
        return;
      }
      const service =
        input.permission === "location" ? "location" : IOS_TCC_SERVICES[input.permission];
      if (!service) throw unavailable("permission", "ios", "unsupported");
      await simctl(host, udid, ["privacy", input.decision, service, input.appId], "permission");
      return;
    }
    case "openUrl":
      await simctl(host, udid, ["openurl", input.url], "open url");
      return;
    case "launchApp":
      await simctl(host, udid, ["launch", input.appId], "launch");
      return;
    case "terminateApp":
      await simctl(host, udid, ["terminate", input.appId], "terminate");
      return;
    case "sendPush": {
      const payload =
        typeof input.payload === "string" ? { aps: { alert: input.payload } } : input.payload;
      ok("push")(
        await host.run("xcrun", ["simctl", "push", udid, input.appId, "-"], {
          stdin: JSON.stringify(payload),
        }),
      );
      return;
    }
    case "setOrientation":
      throw unavailable(input.type, "ios", "unsupported");
  }
}

/**
 * `adb shell` joins its arguments and the device's shell parses them again, so a value the
 * caller chose (a URL, an app id) goes single-quoted: `&`, `;` or `$(…)` in it stay text.
 * T3 passes them bare; its UI is the only caller there, Jhin's commands reach agents too.
 */
const shellQuote = (value: string): string => `'${value.replaceAll("'", () => "'\\''")}'`;

async function runAndroid(host: ActionHost, serial: string, input: DeviceAction): Promise<void> {
  const adb = async (args: readonly string[], operation: string) =>
    ok(operation)(await host.run("adb", ["-s", serial, ...args]));
  const shell = (args: readonly string[], operation: string) => adb(["shell", ...args], operation);
  switch (input.type) {
    case "setAppearance":
      await shell(["cmd", "uimode", "night", input.value === "dark" ? "yes" : "no"], "appearance");
      return;
    case "setTextSize":
      await shell(
        ["settings", "put", "system", "font_scale", ANDROID_TEXT_SIZES[input.value]],
        "text size",
      );
      return;
    case "setToggle":
      if (input.setting === "networkEnabled") {
        const state = input.value ? "enable" : "disable";
        await shell(["svc", "wifi", state], "network");
        // Mobile data only where there is telephony (most emulators have none): Wi-Fi took,
        // so a device that refuses it is no failure. adb itself failing still is.
        await shell(["svc", "data", state], "network").catch((error: unknown) => {
          // Only the device's refusal (an exit code) is tolerated; adb that could not run
          // fails with the same code but no exit code.
          const refused =
            error instanceof DeviceError &&
            error.code === "DEVICE_OPERATION_FAILED" &&
            typeof error.details["exitCode"] === "number";
          if (!refused) throw error;
        });
        return;
      }
      if (input.setting === "reduceMotion") {
        const scale = input.value ? "0" : "1";
        for (const key of [
          "animator_duration_scale",
          "transition_animation_scale",
          "window_animation_scale",
        ]) {
          await shell(["settings", "put", "global", key, scale], "reduce motion");
        }
        return;
      }
      throw unavailable(input.type, "android", "unsupported");
    case "setOrientation":
      // `user-rotation lock` only rotates window content on recent images; the display the
      // encoder captures stays put. Tilting the emulator's accelerometer rotates it for real, so
      // that is used whenever the target is an emulator.
      if (serial.startsWith("emulator-")) {
        await shell(["settings", "put", "system", "accelerometer_rotation", "1"], "orientation");
        await shell(["cmd", "window", "user-rotation", "free"], "orientation");
        await adb(
          ["emu", "sensor", "set", "acceleration", ANDROID_GRAVITY[input.value]],
          "orientation",
        );
        return;
      }
      await shell(
        ["cmd", "window", "user-rotation", "lock", ANDROID_ROTATION[input.value]],
        "orientation",
      );
      return;
    case "setLocation":
      // The emulator console places it; a phone has no console to ask.
      if (!serial.startsWith("emulator-")) throw unavailable(input.type, "android", "unsupported");
      await adb(
        ["emu", "geo", "fix", coordinate(input.longitude), coordinate(input.latitude)],
        "location",
      );
      return;
    case "clearLocation":
      // The emulator has no "clear", so it is refused rather than reported done (T3 answers
      // it with nothing; its panel offers Clear on iOS only).
      throw unavailable(input.type, "android", "unsupported");
    case "setPermission": {
      const permissions = ANDROID_PERMISSIONS[input.permission];
      // Android has no reset of one permission; T3's panel offers Reset on iOS only.
      if (!permissions || input.decision === "reset") {
        throw unavailable("permission", "android", "unsupported");
      }
      // An app declares some of a group's permissions only (photos: one per Android
      // version): the action holds when at least one of them took.
      let failure: unknown;
      let changed = false;
      for (const permission of permissions) {
        try {
          await shell(["pm", input.decision, shellQuote(input.appId), permission], "permission");
          changed = true;
        } catch (error) {
          failure ??= error;
        }
      }
      if (!changed) throw failure;
      return;
    }
    case "openUrl": {
      const out = await shell(
        ["am", "start", "-a", "android.intent.action.VIEW", "-d", shellQuote(input.url)],
        "open url",
      );
      // `am start` exits 0 when nothing on the device opens the URL.
      if (/Error: Activity not started|unable to resolve Intent/i.test(out)) {
        throw new DeviceError(
          "DEVICE_OPERATION_FAILED",
          `Device action open url failed: nothing on the device opens ${input.url}.`,
          { operation: "open url" },
        );
      }
      return;
    }
    case "launchApp": {
      const out = await shell(
        ["monkey", "-p", shellQuote(input.appId), "-c", "android.intent.category.LAUNCHER", "1"],
        "launch",
      );
      // monkey exits 0 even when the package is missing or has nothing to launch.
      if (/No activities found to run|monkey aborted/i.test(out)) {
        throw new DeviceError(
          "DEVICE_OPERATION_FAILED",
          `Device action launch failed: ${input.appId} is not installed or has no launcher activity.`,
          { operation: "launch", appId: input.appId },
        );
      }
      return;
    }
    case "terminateApp":
      await shell(["am", "force-stop", shellQuote(input.appId)], "terminate");
      return;
    case "setLiquidGlass":
    case "setColorFilter":
    case "sendPush":
      throw unavailable(input.type, "android", "unsupported");
  }
}

/** The device's settings and foreground app, as T3's `readDeviceDetail` reads them. */
export async function readDeviceDetail(
  host: ActionHost,
  platform: DevicePlatform,
  deviceId: string,
): Promise<{ settings: DeviceSettings; foregroundApp: DeviceForegroundApp | null }> {
  return platform === "ios" ? readIos(host, deviceId) : readAndroid(host, deviceId);
}

/**
 * A value the device would not give (the tool ran and refused, or the hub's helper is not
 * there) reads as unknown; a tool that cannot run at all fails the read, so the caller learns
 * why instead of getting empty settings.
 */
const quiet = <A>(work: Promise<A>): Promise<A | undefined> =>
  work.catch((error: unknown) => {
    // Output the reader cannot parse (a warning line, a helper of another version) is unknown
    // too: the tool ran.
    const unknown =
      error instanceof SyntaxError ||
      (error instanceof DeviceError &&
        ((error.code === "DEVICE_OPERATION_FAILED" &&
          typeof error.details["exitCode"] === "number") ||
          error.code === "DEVICE_ACTION_UNAVAILABLE"));
    if (unknown) return undefined;
    throw error;
  });

async function readIos(host: ActionHost, udid: string) {
  const uiValue = (option: string) =>
    quiet(simctl(host, udid, ["ui", option], option).then((out) => out.trim().toLowerCase()));
  const [appearance, contentSize, contrast, axStatus] = await Promise.all([
    uiValue("appearance"),
    uiValue("content_size"),
    uiValue("increase_contrast"),
    quiet(
      axSettings(host, udid, ["status"]).then((out) => JSON.parse(out) as Record<string, string>),
    ),
  ]);
  const onOff = (value: string | undefined) =>
    value === "on" ? true : value === "off" ? false : undefined;
  const flag = (key: keyof DeviceSettings, value: string | undefined) => {
    const parsed = onOff(value);
    return parsed === undefined ? {} : { [key]: parsed };
  };
  const settings: DeviceSettings = {
    ...(appearance === "light" || appearance === "dark" ? { appearance } : {}),
    ...(contentSize ? { textSize: textSizeFromIos(contentSize) } : {}),
    ...(contrast ? { increaseContrast: contrast === "enabled" } : {}),
    ...(axStatus
      ? {
          ...flag("reduceMotion", axStatus["reduce-motion"]),
          ...flag("reduceTransparency", axStatus["reduce-transparency"]),
          ...flag("showBorders", axStatus["show-borders"]),
          ...flag("voiceOver", axStatus["voiceover"]),
          ...(axStatus["liquid-glass"] === "clear" || axStatus["liquid-glass"] === "tinted"
            ? { liquidGlass: axStatus["liquid-glass"] }
            : {}),
          ...(isColorFilter(axStatus["color-filter"])
            ? { colorFilter: axStatus["color-filter"] }
            : {}),
        }
      : {}),
  };
  return { settings, foregroundApp: null };
}

const isColorFilter = (value: unknown): value is NonNullable<DeviceSettings["colorFilter"]> =>
  value === "none" ||
  value === "grayscale" ||
  value === "red-green" ||
  value === "green-red" ||
  value === "blue-yellow";

async function readAndroid(host: ActionHost, serial: string) {
  const shell = (args: readonly string[]) =>
    quiet(
      host
        .run("adb", ["-s", serial, "shell", ...args])
        .then(ok(args[0] ?? "shell"))
        .then((out) => out.trim()),
    );
  const [night, fontScale, animator, wifi, focus] = await Promise.all([
    shell(["cmd", "uimode", "night"]),
    shell(["settings", "get", "system", "font_scale"]),
    shell(["settings", "get", "global", "animator_duration_scale"]),
    shell(["settings", "get", "global", "wifi_on"]),
    // `dumpsys window windows` stopped printing the focus on API 36; the
    // unfiltered dump still does. It can be megabytes on a busy device, so the
    // device's own shell keeps only the focus lines (`adb shell` runs it in sh).
    shell(["dumpsys", "window", "|", "grep", "-E", "'mCurrentFocus|mFocusedApp'"]),
  ]);
  const scale = fontScale && fontScale !== "null" ? Number(fontScale) : Number.NaN;
  const focused = focus?.match(/m(?:CurrentFocus|FocusedApp)=\w+\{[^ ]+ u\d+ ([^/ ]+)\//);
  // `Night mode: yes` or `no`; `auto` and `custom` follow the clock, so neither is shown.
  const mode = night?.match(/^Night mode: (yes|no)$/m)?.[1];
  const settings: DeviceSettings = {
    ...(mode === "yes"
      ? { appearance: "dark" as const }
      : mode === "no"
        ? { appearance: "light" as const }
        : {}),
    ...(Number.isFinite(scale) ? { textSize: textSizeFromAndroid(scale) } : {}),
    ...(animator !== undefined && animator !== "null"
      ? { reduceMotion: Number(animator) === 0 }
      : {}),
    ...(wifi === "1" || wifi === "0" ? { networkEnabled: wifi === "1" } : {}),
  };
  return { settings, foregroundApp: focused ? { id: focused[1]! } : null };
}
