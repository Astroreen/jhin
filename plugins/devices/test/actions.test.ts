// Cases follow T3 Code's apps/server/src/device/DeviceActions.test.ts (MIT, see
// THIRD_PARTY_NOTICES.md), without Effect. docs/plans/preview.md, D1332.
import { DeviceAction, DeviceError } from "@jhin/preview-api";
import { describe, expect, it } from "vite-plus/test";

import {
  readDeviceDetail,
  runDeviceAction,
  supportsAction,
  type ActionHost,
} from "../src/actions.ts";

type Call = { command: string; args: readonly string[]; stdin?: string };

const makeHost = (
  respond: (call: Call) => { stdout?: string; stderr?: string; code?: number } = () => ({}),
  helpers: ActionHost["helpers"] = {
    serveSimAxSettings: "/hub/simax/serve-sim-ax-settings",
    serveSimCli: "/hub/serve-sim.js",
  },
) => {
  const calls: Call[] = [];
  const host: ActionHost = {
    helpers,
    run: async (command, args, options) => {
      const call = { command, args, ...(options?.stdin ? { stdin: options.stdin } : {}) };
      calls.push(call);
      const result = respond(call);
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 };
    },
  };
  return { host, calls };
};

const udid = "SIM-1";

const failure = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error as DeviceError;
  }
  throw new Error("expected the action to fail");
};

describe("supportsAction", () => {
  it("advertises platform-specific toggles", () => {
    const toggle = (setting: Extract<DeviceAction, { type: "setToggle" }>["setting"]) =>
      ({ type: "setToggle", setting, value: true }) as const;
    expect(supportsAction("ios", toggle("voiceOver"))).toBe(true);
    expect(supportsAction("android", toggle("voiceOver"))).toBe(false);
    expect(supportsAction("android", toggle("networkEnabled"))).toBe(true);
    expect(supportsAction("ios", toggle("networkEnabled"))).toBe(false);
    expect(supportsAction("ios", { type: "setLiquidGlass", value: "clear" })).toBe(true);
    expect(supportsAction("android", { type: "setLiquidGlass", value: "clear" })).toBe(false);
    expect(supportsAction("android", { type: "setOrientation", value: "portrait" })).toBe(true);
    expect(supportsAction("ios", { type: "setOrientation", value: "portrait" })).toBe(false);
  });
});

describe("runDeviceAction", () => {
  it("maps shared text sizes onto simctl content-size categories", async () => {
    const { host, calls } = makeHost();
    await runDeviceAction(host, "ios", udid, { type: "setTextSize", value: "extra-large" });
    expect(calls).toEqual([
      { command: "xcrun", args: ["simctl", "ui", udid, "content_size", "accessibility-large"] },
    ]);
  });

  it("maps shared text sizes onto Android font_scale", async () => {
    const { host, calls } = makeHost();
    await runDeviceAction(host, "android", "emulator-5554", {
      type: "setTextSize",
      value: "large",
    });
    expect(calls[0]?.args).toEqual([
      "-s",
      "emulator-5554",
      "shell",
      "settings",
      "put",
      "system",
      "font_scale",
      "1.15",
    ]);
  });

  it("rotates emulators through the accelerometer and physical devices through the lock", async () => {
    const emulator = makeHost();
    await runDeviceAction(emulator.host, "android", "emulator-5554", {
      type: "setOrientation",
      value: "landscape_left",
    });
    expect(emulator.calls.at(-1)?.args).toEqual([
      "-s",
      "emulator-5554",
      "emu",
      "sensor",
      "set",
      "acceleration",
      "9.81:0:0",
    ]);
    const phone = makeHost();
    await runDeviceAction(phone.host, "android", "R5CT1234", {
      type: "setOrientation",
      value: "landscape_right",
    });
    expect(phone.calls).toEqual([
      {
        command: "adb",
        args: ["-s", "R5CT1234", "shell", "cmd", "window", "user-rotation", "lock", "3"],
      },
    ]);
  });

  it("runs accessibility toggles through the bundled helper via simctl spawn", async () => {
    const { host, calls } = makeHost();
    await runDeviceAction(host, "ios", udid, {
      type: "setToggle",
      setting: "voiceOver",
      value: true,
    });
    expect(calls).toEqual([
      {
        command: "xcrun",
        args: [
          "simctl",
          "spawn",
          udid,
          "/hub/simax/serve-sim-ax-settings",
          "set",
          "voiceover",
          "on",
        ],
      },
    ]);
  });

  it("fails clearly when the helper is missing", async () => {
    const { host } = makeHost(() => ({}), { serveSimAxSettings: null, serveSimCli: null });
    const error = await failure(
      runDeviceAction(host, "ios", udid, { type: "setColorFilter", value: "grayscale" }),
    );
    expect(error.code).toBe("DEVICE_ACTION_UNAVAILABLE");
    expect(error.details).toMatchObject({ reason: "helper_missing" });
    expect(error.message).toContain("needs the device hub's helpers");
  });

  it("rejects actions the platform does not support without running anything", async () => {
    const { host, calls } = makeHost();
    const error = await failure(
      runDeviceAction(host, "android", "emulator-5554", {
        type: "sendPush",
        appId: "com.example",
        payload: "hi",
      }),
    );
    expect(error.message).toContain("not available on Android");
    expect(calls).toEqual([]);
  });

  it("surfaces non-zero exit codes as operation errors", async () => {
    const { host } = makeHost(() => ({ code: 1, stderr: "Invalid device: SIM-1" }));
    const error = await failure(
      runDeviceAction(host, "ios", udid, { type: "setAppearance", value: "dark" }),
    );
    expect(error.code).toBe("DEVICE_OPERATION_FAILED");
    expect(error.details).toMatchObject({
      operation: "appearance",
      stderr: "Invalid device: SIM-1",
    });
    expect(error.message).toContain("exit code 1");
    expect(error.message).not.toContain("Invalid device: SIM-1");
  });

  it("wraps a bare push string in an APNs alert and feeds it on stdin", async () => {
    const { host, calls } = makeHost();
    await runDeviceAction(host, "ios", udid, {
      type: "sendPush",
      appId: "com.example.app",
      payload: "Hello",
    });
    expect(calls[0]?.args).toEqual(["simctl", "push", udid, "com.example.app", "-"]);
    expect(calls[0]?.stdin).toBe('{"aps":{"alert":"Hello"}}');
  });
});

describe("the tools' other actions", () => {
  it("quotes what the caller chose before the device's shell reads it", async () => {
    const { host, calls } = makeHost();
    await runDeviceAction(host, "android", "emulator-5554", {
      type: "openUrl",
      url: "https://x.test/?a=1&b=2;reboot $(id)'q",
    });
    expect(calls[0]?.args).toEqual([
      "-s",
      "emulator-5554",
      "shell",
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      `'https://x.test/?a=1&b=2;reboot $(id)'\\''q'`,
    ]);
    await runDeviceAction(host, "android", "emulator-5554", {
      type: "launchApp",
      appId: "com.example",
    });
    await runDeviceAction(host, "android", "emulator-5554", {
      type: "terminateApp",
      appId: "com.example",
    });
    expect(calls.slice(1).map((call) => call.args.slice(3))).toEqual([
      ["monkey", "-p", "'com.example'", "-c", "android.intent.category.LAUNCHER", "1"],
      ["am", "force-stop", "'com.example'"],
    ]);
  });

  it("opens, launches, terminates and places on iOS through simctl", async () => {
    const { host, calls } = makeHost();
    await runDeviceAction(host, "ios", udid, { type: "openUrl", url: "myapp://x?a=1&b=2" });
    await runDeviceAction(host, "ios", udid, { type: "launchApp", appId: "com.example" });
    await runDeviceAction(host, "ios", udid, { type: "terminateApp", appId: "com.example" });
    await runDeviceAction(host, "ios", udid, { type: "setLocation", latitude: 1.5, longitude: -2 });
    await runDeviceAction(host, "ios", udid, { type: "clearLocation" });
    expect(calls.map((call) => call.args)).toEqual([
      ["simctl", "openurl", udid, "myapp://x?a=1&b=2"],
      ["simctl", "launch", udid, "com.example"],
      ["simctl", "terminate", udid, "com.example"],
      ["simctl", "location", udid, "set", "1.5,-2"],
      ["simctl", "location", udid, "clear"],
    ]);
  });

  it("fixes an emulator's location and refuses to clear it, which the emulator cannot", async () => {
    const { host, calls } = makeHost();
    await runDeviceAction(host, "android", "emulator-5554", {
      type: "setLocation",
      latitude: 59.3,
      longitude: 18.1,
    });
    const refused = await failure(
      runDeviceAction(host, "android", "emulator-5554", { type: "clearLocation" }),
    );
    expect(refused.code).toBe("DEVICE_ACTION_UNAVAILABLE");
    expect(calls.map((call) => call.args)).toEqual([
      ["-s", "emulator-5554", "emu", "geo", "fix", "18.1", "59.3"],
    ]);
  });

  it("refuses a phone's location, which only an emulator's console places", async () => {
    const { host, calls } = makeHost();
    const refused = await failure(
      runDeviceAction(host, "android", "R5CT1234", {
        type: "setLocation",
        latitude: 1,
        longitude: 2,
      }),
    );
    expect(refused.code).toBe("DEVICE_ACTION_UNAVAILABLE");
    expect(calls).toEqual([]);
  });

  it("fails the network toggle when adb itself cannot run the mobile-data step", async () => {
    const host: ActionHost = {
      helpers: { serveSimAxSettings: "", serveSimCli: "" },
      run: async (_command, args) => {
        if (args.includes("data")) {
          throw new DeviceError("DEVICE_OPERATION_FAILED", "Device adb could not be run: gone");
        }
        return { stdout: "", stderr: "", code: 0 };
      },
    };
    const failed = await failure(
      runDeviceAction(host, "android", "emulator-5554", {
        type: "setToggle",
        setting: "networkEnabled",
        value: false,
      }),
    );
    expect(failed.message).toContain("could not be run");
  });

  it("turns Wi-Fi off on a device without mobile data", async () => {
    const { host, calls } = makeHost((call) =>
      call.args.includes("data") ? { code: 1, stderr: "no telephony" } : {},
    );
    await runDeviceAction(host, "android", "emulator-5554", {
      type: "setToggle",
      setting: "networkEnabled",
      value: false,
    });
    expect(calls.map((call) => call.args.slice(3))).toEqual([
      ["svc", "wifi", "disable"],
      ["svc", "data", "disable"],
    ]);
  });

  it("decides iOS permissions through TCC, and notifications through serve-sim's CLI", async () => {
    const { host, calls } = makeHost();
    await runDeviceAction(host, "ios", udid, {
      type: "setPermission",
      appId: "com.example",
      permission: "camera",
      decision: "reset",
    });
    await runDeviceAction(host, "ios", udid, {
      type: "setPermission",
      appId: "com.example",
      permission: "notifications",
      decision: "grant",
    });
    expect(calls).toEqual([
      { command: "xcrun", args: ["simctl", "privacy", udid, "reset", "camera", "com.example"] },
      {
        command: "node",
        args: [
          "/hub/serve-sim.js",
          "permissions",
          "grant",
          "notifications",
          "com.example",
          "-d",
          udid,
        ],
      },
    ]);
  });

  it("holds an Android permission when one of its group took, and fails when none did", async () => {
    const photos = makeHost((call) =>
      call.args.includes("android.permission.READ_MEDIA_IMAGES") ? { code: 255 } : {},
    );
    await runDeviceAction(photos.host, "android", "emulator-5554", {
      type: "setPermission",
      appId: "com.example",
      permission: "photos",
      decision: "grant",
    });
    expect(photos.calls.map((call) => call.args.slice(3))).toEqual([
      ["pm", "grant", "'com.example'", "android.permission.READ_MEDIA_IMAGES"],
      ["pm", "grant", "'com.example'", "android.permission.READ_EXTERNAL_STORAGE"],
    ]);
    const none = makeHost(() => ({ code: 255, stderr: "Unknown package" }));
    const error = await failure(
      runDeviceAction(none.host, "android", "emulator-5554", {
        type: "setPermission",
        appId: "com.example",
        permission: "camera",
        decision: "revoke",
      }),
    );
    expect(error.code).toBe("DEVICE_OPERATION_FAILED");
    // Android has no reset of one permission.
    const reset = await failure(
      runDeviceAction(none.host, "android", "emulator-5554", {
        type: "setPermission",
        appId: "com.example",
        permission: "camera",
        decision: "reset",
      }),
    );
    expect(reset.code).toBe("DEVICE_ACTION_UNAVAILABLE");
  });
});

describe("readDeviceDetail", () => {
  it("reads iOS settings from simctl and the accessibility helper", async () => {
    const { host } = makeHost((call) => {
      const key = call.args.join(" ");
      if (key.endsWith("ui SIM-1 appearance")) return { stdout: "dark\n" };
      if (key.endsWith("ui SIM-1 content_size")) return { stdout: "extra-extra-large\n" };
      if (key.endsWith("ui SIM-1 increase_contrast")) return { stdout: "enabled\n" };
      if (key.includes("serve-sim-ax-settings status")) {
        return {
          stdout:
            '{"reduce-motion":"on","reduce-transparency":"off","show-borders":"off","voiceover":"off","liquid-glass":"tinted","color-filter":"grayscale"}',
        };
      }
      return { code: 1 };
    });
    const detail = await readDeviceDetail(host, "ios", udid);
    expect(detail.settings).toEqual({
      appearance: "dark",
      textSize: "large",
      increaseContrast: true,
      reduceMotion: true,
      reduceTransparency: false,
      showBorders: false,
      voiceOver: false,
      liquidGlass: "tinted",
      colorFilter: "grayscale",
    });
  });

  it("degrades unreadable values to unknown instead of failing", async () => {
    const { host } = makeHost(() => ({ code: 1, stderr: "boom" }));
    const detail = await readDeviceDetail(host, "ios", udid);
    expect(detail.settings).toEqual({});
    expect(detail.foregroundApp).toBeNull();
  });

  it("reads Android settings and the focused package", async () => {
    const { host } = makeHost((call) => {
      const key = call.args.join(" ");
      if (key.endsWith("cmd uimode night")) return { stdout: "Night mode: yes\n" };
      if (key.endsWith("font_scale")) return { stdout: "0.85\n" };
      if (key.endsWith("animator_duration_scale")) return { stdout: "0\n" };
      if (key.endsWith("wifi_on")) return { stdout: "1\n" };
      if (key.endsWith("dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'")) {
        return {
          stdout:
            "  mFocusedApp=ActivityRecord{155579877 u0 com.example.app/.MainActivity t15}\n  mCurrentFocus=Window{1a2b u0 com.example.app/com.example.app.MainActivity}\n",
        };
      }
      return { code: 1 };
    });
    const detail = await readDeviceDetail(host, "android", "emulator-5554");
    expect(detail.settings).toEqual({
      appearance: "dark",
      textSize: "small",
      reduceMotion: true,
      networkEnabled: true,
    });
    expect(detail.foregroundApp).toEqual({ id: "com.example.app" });
  });

  it("reads Android's appearance only from a definite night mode", async () => {
    const appearance = async (reply: string) => {
      const { host } = makeHost((call) =>
        call.args.join(" ").endsWith("cmd uimode night") ? { stdout: reply } : { code: 1 },
      );
      return (await readDeviceDetail(host, "android", "emulator-5554")).settings.appearance;
    };
    expect(await appearance("Night mode: no\n")).toBe("light");
    expect(await appearance("Night mode: yes\n")).toBe("dark");
    // Following the clock, or a reply that only contains "no": neither is shown.
    expect(await appearance("Night mode: auto\n")).toBeUndefined();
    expect(await appearance("Unknown command\n")).toBeUndefined();
  });

  it("bounds a push payload given as JSON, as one given as text", () => {
    const push = (payload: unknown) =>
      DeviceAction.safeParse({ type: "sendPush", appId: "com.example.app", payload }).success;
    expect(push({ aps: { alert: "hi" } })).toBe(true);
    expect(push({ aps: { alert: "x".repeat(4096) } })).toBe(false);
    expect(push("x".repeat(4097))).toBe(false);
  });

  it("reads iOS's small text categories as small, extra-small included", async () => {
    const textSize = async (category: string) => {
      const { host } = makeHost((call) =>
        call.args.includes("content_size") ? { stdout: `${category}\n` } : { code: 1 },
      );
      return (await readDeviceDetail(host, "ios", "SIM-1")).settings.textSize;
    };
    expect(await textSize("extra-small")).toBe("small");
    expect(await textSize("medium")).toBe("small");
    expect(await textSize("extra-extra-large")).toBe("large");
    expect(await textSize("accessibility-large")).toBe("extra-large");
  });

  it("fails a launch monkey aborts, though it exits 0", async () => {
    const { host } = makeHost((call) =>
      call.args.includes("monkey")
        ? { stdout: "** No activities found to run, monkey aborted.\n" }
        : {},
    );
    const failed = await failure(
      runDeviceAction(host, "android", "emulator-5554", {
        type: "launchApp",
        appId: "com.example.missing",
      }),
    );
    expect(failed.code).toBe("DEVICE_OPERATION_FAILED");
    expect(failed.message).toContain("com.example.missing");
  });

  it("gives tiny coordinates as plain decimals, not in exponent form", async () => {
    const { host, calls } = makeHost();
    await runDeviceAction(host, "android", "emulator-5554", {
      type: "setLocation",
      latitude: 59.3,
      longitude: 1e-7,
    });
    await runDeviceAction(host, "ios", "SIM-1", {
      type: "setLocation",
      latitude: 0.0000012,
      longitude: 18.1,
    });
    // `String(1e-7)` is "1e-7", which neither tool reads as a number.
    expect(calls[0]!.args.slice(-2)).toEqual(["0", "59.3"]);
    expect(calls[1]!.args.at(-1)).toBe("0.000001,18.1");
  });

  it("fails a URL nothing on an Android device opens, though am exits 0", async () => {
    const { host } = makeHost((call) =>
      call.args.includes("start")
        ? {
            stdout:
              "Error: Activity not started, unable to resolve Intent { act=android.intent.action.VIEW }\n",
          }
        : {},
    );
    const failed = await failure(
      runDeviceAction(host, "android", "emulator-5554", { type: "openUrl", url: "nope://x" }),
    );
    expect(failed.code).toBe("DEVICE_OPERATION_FAILED");
  });

  it("fails a settings read when the device tool cannot run at all", async () => {
    const host: ActionHost = {
      helpers: { serveSimAxSettings: "", serveSimCli: "" },
      run: async () => {
        throw new DeviceError("DEVICE_OPERATION_FAILED", "Device adb could not be run: missing");
      },
    };
    await expect(readDeviceDetail(host, "android", "emulator-5554")).rejects.toThrow(
      "could not be run",
    );
  });
});
