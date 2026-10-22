import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { DEVICES_STREAM, DeviceEvents, deviceStream, type DeviceState } from "@jhin/preview-api";
import { LIVE_STREAMS_CAPABILITY, createLiveStreams, type RpcClient } from "@jhin/rpc";
import type { StoredEvent } from "@jhin/storage-api";
import {
  connectInMemory,
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
} from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import devices from "../src/index.ts";

const manifest = JSON.parse(
  Fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).jhin;

// A 2 × 3 PNG: only its header is read.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0]),
]);

/** Fake adb, emulator and xcrun keeping their state in files of one folder. */
function fakeTools() {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-devices-"));
  Fs.writeFileSync(Path.join(dir, "screen.png"), PNG);
  Fs.writeFileSync(Path.join(dir, "running"), "");
  Fs.writeFileSync(Path.join(dir, "ios-state"), "Shutdown");
  const script = (name: string, body: string) => {
    const file = Path.join(dir, name);
    Fs.writeFileSync(file, `#!/bin/sh\nD=${JSON.stringify(dir)}\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const adb = script(
    "adb",
    `case "$1" in
  devices) echo "List of devices attached"; while read serial name; do [ -n "$serial" ] && echo "$serial device product:sdk model:sdk_gphone64 device:emu"; done < "$D/running"; exit 0;;
  -s) serial="$2"; shift 2;;
esac
case "$*" in
  "emu avd name") grep "^$serial " "$D/running" | cut -d' ' -f2; echo OK;;
  "shell getprop ro.build.version.release") echo 14;;
  "shell getprop sys.boot_completed") echo 1;;
  "exec-out screencap -p") cat "$D/screen.png";;
  "emu kill") grep -v "^$serial " "$D/running" > "$D/running.next"; mv "$D/running.next" "$D/running"; [ -f "$D/pid" ] && kill "$(cat "$D/pid")" 2>/dev/null; echo OK;;
  *) echo "unknown: $*" >&2; exit 1;;
esac`,
  );
  const emulator = script(
    "emulator",
    `case "$1" in
  -list-avds) echo Pixel_7_API_34;;
  -avd) echo "emulator-5554 $2" >> "$D/running"; echo $$ > "$D/pid"; exec sleep 600;;
esac`,
  );
  const xcrun = script(
    "xcrun",
    `case "$2 $3" in
  "list devices") printf '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-2":[{"udid":"SIM-1","name":"iPhone 15","state":"%s","isAvailable":true}]}}' "$(cat "$D/ios-state")";;
  "boot SIM-1") echo Booted > "$D/ios-state";;
  "bootstatus SIM-1") :;;
  "io SIM-1") cat "$D/screen.png";;
  "shutdown SIM-1") echo Shutdown > "$D/ios-state";;
  *) echo "unknown: $*" >&2; exit 1;;
esac`,
  );
  return { dir, adb, emulator, xcrun };
}

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

async function node(tools: Record<string, string>) {
  const storage = memoryStoragePlugin();
  const live = createLiveStreams();
  const kernel = await createTestKernel({
    plugins: [
      storage,
      mockCapability(LIVE_STREAMS_CAPABILITY, live),
      { manifest, definition: devices },
    ],
    config: { node: { "jhin.devices": tools } },
  });
  const { client } = connectInMemory(kernel, { log: storage.storage.log, streams: live });
  stops.push(async () => {
    client.close();
    await kernel.stop();
  });
  return { client };
}

function watch(client: RpcClient, stream: string) {
  const events: StoredEvent[] = [];
  const waiters: { test: () => boolean; resolve: () => void }[] = [];
  const subscription = client.subscribe(stream, { after: 0 }, (event) => {
    events.push(event);
    for (const waiter of waiters.filter((item) => item.test())) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  });
  const until = (test: () => boolean) =>
    test() ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ test, resolve }));
  return { events, subscription, until };
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("expected the call to fail");
}

describe("jhin.devices", () => {
  it("lists simulators and emulators, the ones not running too", async () => {
    const tools = fakeTools();
    const { client } = await node({ adb: tools.adb, emulator: tools.emulator, xcrun: tools.xcrun });
    const listed = await client.call<{
      hosts: DeviceState["hosts"];
      devices: DeviceState["devices"];
    }>("device.list", {});
    expect(listed.hosts[0]?.platforms).toEqual([
      { platform: "ios", available: true },
      { platform: "android", available: true },
    ]);
    expect(listed.devices).toEqual([
      expect.objectContaining({
        id: "SIM-1",
        platform: "ios",
        name: "iPhone 15",
        version: "iOS 17.2",
        booted: false,
      }),
      expect.objectContaining({ id: "Pixel_7_API_34", platform: "android", booted: false }),
    ]);
    const ambiguous = await rejection(client.call("device.open", { threadId: "t1" }));
    expect(ambiguous.message).toBe(
      "Both iOS and Android devices are available; pass platform or deviceId.",
    );
  });

  it("boots an AVD for a thread, shows it in the panel's state and powers it off", async () => {
    const tools = fakeTools();
    const { client } = await node({ adb: tools.adb, emulator: tools.emulator, xcrun: tools.xcrun });
    const state = watch(client, DEVICES_STREAM);
    const opened = await client.call<{
      device: { id: string; booted: boolean; version: string };
      control: { command: string; targetArgs: string[] };
      quickStart: string;
    }>("device.open", { threadId: "t1", deviceId: "Pixel_7_API_34" });
    // The AVD became the running emulator's serial.
    expect(opened.device).toMatchObject({
      id: "emulator-5554",
      booted: true,
      version: "Android 14",
    });
    expect(opened.control).toEqual({ command: tools.adb, targetArgs: ["-s", "emulator-5554"] });
    expect(opened.quickStart).toContain(`${tools.adb} -s emulator-5554 shell input tap <x> <y>`);
    const latest = () =>
      (
        state.events.findLast((event) => event.type === DeviceEvents.state)?.payload as
          | { state: DeviceState }
          | undefined
      )?.state;
    await state.until(
      () => latest()?.sessions.some((session) => session.deviceId === "emulator-5554") === true,
    );

    const shot = await client.call<{ screenshot: { width: number; height: number } }>(
      "device.screenshot",
      { threadId: "t1" },
    );
    expect(shot.screenshot).toMatchObject({ width: 2, height: 3 });

    // Watching the device's stream gives its screen.
    const screen = watch(client, deviceStream("local", "emulator-5554"));
    await screen.until(() => screen.events.some((event) => event.type === DeviceEvents.screen));
    screen.subscription.dispose();

    await client.call("device.close", { threadId: "t1", shutdown: true });
    await state.until(
      () =>
        latest()?.sessions.length === 0 &&
        latest()?.devices.every((device) => !device.booted) === true,
    );
    const gone = await rejection(client.call("device.screenshot", { threadId: "t1" }));
    expect(gone.message).toBe("No device is open in this thread. Call device_open first.");
  });

  it("boots an iOS simulator through simctl", async () => {
    const tools = fakeTools();
    const { client } = await node({ adb: tools.adb, emulator: tools.emulator, xcrun: tools.xcrun });
    const opened = await client.call<{
      device: { id: string; booted: boolean };
      quickStart: string;
    }>("device.open", { threadId: "t2", platform: "ios" });
    expect(opened.device).toMatchObject({ id: "SIM-1", booted: true });
    expect(opened.quickStart).toContain(`${tools.xcrun} simctl launch SIM-1 <bundle-id>`);
  });

  it("says why a platform is unavailable", async () => {
    const { client } = await node({
      androidSdk: Path.join(Os.tmpdir(), "jhin-no-sdk"),
      adb: Path.join(Os.tmpdir(), "jhin-no-adb"),
    });
    const listed = await client.call<{ hosts: DeviceState["hosts"] }>("device.list", {});
    expect(listed.hosts[0]?.platforms.find((each) => each.platform === "android")).toEqual({
      platform: "android",
      available: false,
      reason: "Android platform tools (adb) were not found in the Android SDK.",
    });
  });
  it("finds a running emulator by its AVD name", async () => {
    const tools = fakeTools();
    Fs.writeFileSync(Path.join(tools.dir, "running"), "emulator-5554 Pixel_7_API_34\n");
    const { client } = await node({ adb: tools.adb, emulator: tools.emulator, xcrun: tools.xcrun });
    const opened = await client.call<{ device: { id: string } }>("device.open", {
      threadId: "t3",
      deviceId: "Pixel_7_API_34",
    });
    expect(opened.device.id).toBe("emulator-5554");
  });

  it("reports an emulator that does not start as a failed boot", async () => {
    const tools = fakeTools();
    const failing = Path.join(tools.dir, "failing-emulator");
    Fs.writeFileSync(
      failing,
      `#!/bin/sh\ncase "$1" in -list-avds) echo Pixel_7_API_34;; *) exit 1;; esac\n`,
      { mode: 0o755 },
    );
    const { client } = await node({ adb: tools.adb, emulator: failing, xcrun: tools.xcrun });
    const failed = await rejection(
      client.call("device.open", { threadId: "t4", deviceId: "Pixel_7_API_34" }),
    );
    expect(failed.code).toBe("DEVICE_BOOT_FAILED");
    expect(failed.message).toBe(
      "Device Pixel_7_API_34 failed to boot: The simulator or emulator could not start. Check its configuration on the environment server.",
    );
  });
});
