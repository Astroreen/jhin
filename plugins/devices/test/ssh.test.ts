// Device hosts over SSH (docs/plans/preview.md, D1494–D1499) against a fake ssh that runs the
// host's side on this machine, with the fake hub, agent-device, npm and adb (D409).
import * as Fs from "node:fs";
import * as Path from "node:path";

import type { DeviceHostStatus, DeviceSummary } from "@jhin/preview-api";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createRemoteHosts, type RemoteHosts } from "../src/remote-hosts.ts";
import { probeSshHost } from "../src/ssh-host.ts";
import { fakeTools, type FakeTools } from "./fakes.ts";

const MAC = { id: "mac", label: "Mac mini", target: "me@mac.test" };
const OWNER = "0123456789abcdef01234567";

let running: RemoteHosts | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

/** The hosts, and a way to wait for a status the node publishes. */
function hosts(tools: FakeTools, overrides: { agentAccess?: boolean } = {}) {
  const seen: Record<string, DeviceHostStatus>[] = [];
  const waiters: {
    test: (status: Record<string, DeviceHostStatus>) => boolean;
    done: () => void;
  }[] = [];
  const remote = createRemoteHosts({
    configs: () => [MAC],
    enabled: () => true,
    agentAccess: () => overrides.agentAccess ?? true,
    owner: () => OWNER,
    isLocal: () => Promise.resolve(false),
    ssh: tools.ssh,
    onChange: () => {
      const statuses = remote.statuses();
      seen.push(statuses);
      for (const waiter of waiters.filter((each) => each.test(statuses))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.done();
      }
    },
    log: () => undefined,
  });
  running = remote;
  const until = (test: (status: Record<string, DeviceHostStatus>) => boolean) =>
    test(remote.statuses())
      ? Promise.resolve()
      : new Promise<void>((done) => waiters.push({ test, done }));
  return { remote, seen, until };
}

describe("device hosts over SSH (D1494–D1499)", () => {
  it("probes a host: its platforms and whether its tools are there (T3's probe)", async () => {
    const tools = fakeTools();
    const probe = await probeSshHost(MAC, OWNER, { ssh: tools.ssh });
    expect(probe.platforms).toContainEqual({ platform: "android", available: true });
    expect(probe).toMatchObject({ hubInstalled: false, agentDeviceInstalled: false });
  });

  it("starts the host's hub from the plugin's lockfile, lists its devices through a tunnel, and drives them", async () => {
    const tools = fakeTools();
    const { remote, seen } = hosts(tools);
    await remote.reconcile();
    expect(remote.summaries()).toEqual([
      { id: "mac", kind: "ssh", label: "Mac mini", platforms: [] },
    ]);

    await remote.refresh();
    expect(remote.statuses().mac?.status).toBe("ready");
    // Installing first, then starting: T3's phases.
    expect(seen.map((each) => each.mac?.status)).toContain("installing");
    // npm ci of the plugin's lockfile ran on the host (D1495), into ~/.jhin/tools there.
    expect(tools.npmCalls()).toContainEqual({ name: "expo-device-hub", version: "0.15.3" });
    expect(
      Fs.existsSync(Path.join(tools.remoteHome, ".jhin", "tools", "expo-device-hub", "0.15.3")),
    ).toBe(true);
    const devices = remote.devices();
    expect(devices).toContainEqual(
      expect.objectContaining({ hostId: "mac", id: "emulator-5554", booted: true }),
    );

    // The hub answers through the tunnel on this node's loopback (D1496).
    const origin = remote.origin("mac")!;
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${origin}/readyz`)).ok).toBe(true);
    const device = devices.find((each) => each.id === "emulator-5554") as DeviceSummary;
    expect([...(await remote.screenshot(device))]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(await remote.boot({ ...device, id: "Pixel_7", booted: false })).toBe("emulator-5556");
    await remote.shutdown(device);
    expect(tools.hubActions()).toEqual(["/api/devices/boot", "/api/devices/shutdown"]);

    // Input runs agent-device's CLI on the host, against its daemon (D1499).
    expect(await remote.input("thread-1", device, { type: "tap", x: 10, y: 20 })).toBe(
      "agent-device",
    );
    const call = tools.agentCalls().find((args) => args.includes("press"))!;
    expect(call).toEqual(
      expect.arrayContaining(["--platform", "android", "--serial", "emulator-5554", "--state-dir"]),
    );
    expect(call.slice(call.indexOf("--") + 1)).toEqual(["press", "10", "20"]);

    // The device tools run on the host too.
    const actions = await remote.actionHost("mac");
    const listed = await actions.run("adb", ["devices"]);
    expect(listed.stdout).toContain("emulator-5554");
  });

  it("falls back to adb on the host when agents may not use agent-device", async () => {
    const tools = fakeTools();
    const { remote } = hosts(tools, { agentAccess: false });
    await remote.reconcile();
    await remote.refresh();
    const device = remote.devices()[0]!;
    expect(await remote.input("thread-1", device, { type: "text", text: "hi there" })).toBe("adb");
    expect(tools.adbInputs()).toEqual(["shell input text 'hi%sthere'"]);
  });

  it("reconnects with T3's backoff once its tunnel goes", async () => {
    const tools = fakeTools();
    const { remote, until } = hosts(tools);
    await remote.reconcile();
    await remote.refresh();
    const [tunnel] = tools.tunnels();
    process.kill(tunnel!, "SIGKILL");
    await until((statuses) => statuses.mac?.detail === "Reconnecting to device host…");
    await until((statuses) => statuses.mac?.status === "ready");
    expect(tools.tunnels().length).toBeGreaterThan(1);
    expect((await fetch(`${remote.origin("mac")!}/readyz`)).ok).toBe(true);
  });

  it("a host that cannot be reached fails alone, with ssh's own words", async () => {
    const tools = fakeTools();
    tools.unreachable();
    const { remote } = hosts(tools);
    await remote.reconcile();
    await remote.refresh();
    expect(remote.devices()).toEqual([]);
    expect(remote.statuses().mac).toBeUndefined();
    await expect(probeSshHost(MAC, OWNER, { ssh: tools.ssh })).rejects.toThrow(
      "Connection refused",
    );
  });

  it("stops the host's hub when it is removed or the node goes", async () => {
    const tools = fakeTools();
    const { remote } = hosts(tools);
    await remote.reconcile();
    await remote.refresh();
    const hub = tools.hubArgs()!;
    const exited = new Promise<void>((resolve) => {
      const check = () => {
        try {
          process.kill(hub.pid, 0);
          return false;
        } catch {
          return true;
        }
      };
      if (check()) resolve();
      else {
        // The stop below runs the script's `stop`, which ends the hub before it answers.
        void remote.stop().then(() => {
          expect(check()).toBe(true);
          resolve();
        });
      }
    });
    await exited;
    running = undefined;
  });
});
