// The device hub end to end against fakes (D1206–D1209): a fake npm installs a fake hub and a
// fake agent-device, the node's own HTTP and auth plugins serve the proxy. CI has no emulators.
// Cases follow T3 Code's DeviceHubProxy.test.ts and LocalDeviceHost.test.ts (MIT, see
// THIRD_PARTY_NOTICES.md) where they apply.
import * as Fs from "node:fs";
import * as Http from "node:http";
import * as Net from "node:net";
import * as Path from "node:path";

import { DEVICES_STREAM, DeviceEvents, type DeviceState } from "@jhin/preview-api";
import { LIVE_STREAMS_CAPABILITY, createLiveStreams } from "@jhin/rpc";
import type { PluginDefinition } from "@jhin/sdk";
import {
  connectInMemory,
  createTestKernel,
  memoryStoragePlugin,
  mockCapability,
  type TestKernel,
} from "@jhin/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { WebSocket } from "ws";

import auth from "../../auth-token/src/index.ts";
import http from "../../http/src/index.ts";
import devices from "../src/index.ts";
import { fakeTools, type FakeTools } from "./fakes.ts";

const manifest = (dir: string) =>
  JSON.parse(Fs.readFileSync(new URL(`../../${dir}/package.json`, import.meta.url), "utf8")).jhin;
const real = (dir: string, definition: PluginDefinition) => ({
  manifest: manifest(dir),
  definition,
});

const OWNER = { id: "owner", permissions: ["*"] };
const READER = { id: "client:reader", permissions: ["devices.read"] };

let running: TestKernel | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function startNode(tools: FakeTools, settings: Record<string, unknown> = {}) {
  const storage = memoryStoragePlugin();
  const live = createLiveStreams();
  const kernel = await createTestKernel({
    plugins: [
      mockCapability("host.paths", {
        home: tools.home,
        dataDir: (id: string) => {
          Fs.mkdirSync(Path.join(tools.home, "data", id), { recursive: true });
          return Path.join(tools.home, "data", id);
        },
      }),
      storage,
      mockCapability(LIVE_STREAMS_CAPABILITY, live),
      real("http", http),
      real("auth-token", auth),
      real("devices", devices),
    ],
    config: {
      node: {
        "jhin.http": { port: 0 },
        "jhin.devices": {
          adb: tools.adb,
          xcrun: Path.join(tools.dir, "no-xcrun"),
          npm: tools.npm,
          hub: true,
          // The agents' tools are allowed unless a test says otherwise (D1329).
          agentAccess: true,
          ...settings,
        },
      },
    },
  });
  running = kernel;
  expect(kernel.inspect().plugins.filter((plugin) => plugin.status !== "active")).toEqual([]);
  const { url } = (await kernel.commands.execute("http.info", {})) as { url: string };
  const { token } = (await kernel.commands.execute("auth.token.show", {})) as { token: string };
  const { client } = connectInMemory(kernel, { log: storage.storage.log, streams: live });
  /** Resolves once the `devices` stream's state passes `test`. */
  const until = (test: (state: DeviceState) => boolean) =>
    new Promise<DeviceState>((resolve) => {
      const subscription = client.subscribe(DEVICES_STREAM, { after: 0 }, (event) => {
        if (event.type !== DeviceEvents.state) return;
        const state = (event.payload as { state: DeviceState }).state;
        if (!test(state)) return;
        subscription.dispose();
        resolve(state);
      });
    });
  const call = <T>(name: string, input: unknown, caller = OWNER) =>
    kernel.commands.execute(name, input, { caller }) as Promise<T>;
  return { kernel, url, token, until, call, client };
}

type Access = {
  path: string;
  query: Record<string, string>;
  socketQuery: Record<string, string>;
  expiresAt: number;
};

/** A WebSocket's first message, or how its handshake was refused. */
function connect(url: string, headers: Record<string, string> = {}) {
  const socket = new WebSocket(url, { headers });
  const messages: { data: Buffer; binary: boolean }[] = [];
  const waiters: (() => void)[] = [];
  socket.on("message", (data: Buffer, binary) => {
    messages.push({ data, binary });
    for (const waiter of waiters.splice(0)) waiter();
  });
  const opened = new Promise<number>((resolve) => {
    socket.once("open", () => resolve(101));
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    socket.once("error", () => resolve(0));
  });
  const message = (index: number) =>
    new Promise<{ data: Buffer; binary: boolean }>((resolve) => {
      const check = () => {
        const found = messages[index];
        if (found === undefined) waiters.push(check);
        else resolve(found);
      };
      check();
    });
  return { socket, opened, message };
}

describe("the device hub", () => {
  it("installs and starts on first use, and its proxy lets only authenticated clients through", async () => {
    const tools = fakeTools();
    const node = await startNode(tools);
    const statuses: string[] = [];
    const ready = node.until((state) => {
      const status = state.hostStatuses?.local;
      if (status !== undefined && statuses.at(-1) !== status.status) statuses.push(status.status);
      return status?.status === "ready";
    });
    // A ticket belongs to a caller: in-process code without one gets none.
    await expect(node.kernel.commands.execute("device.hub.access", {})).rejects.toThrow(
      "device.hub.access issues tickets to a caller",
    );
    // Watching alone never installs or starts the hub.
    await expect(node.call("device.hub.access", {}, READER)).rejects.toThrow(
      "The device hub is not running. Open the device to start it.",
    );
    expect(tools.npmCalls()).toEqual([]);
    await node.call("device.open", { threadId: "t1", deviceId: "emulator-5554" });
    const access = await node.call<Access>("device.hub.access", {});
    await ready;
    expect(statuses).toEqual(["installing", "starting", "ready"]);
    expect(access.path).toBe("/device-hub");
    const ticket = access.query.wsTicket!;
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The hub listens on loopback only, started as T3 starts it.
    const hub = tools.hubArgs()!;
    expect(hub.args).toEqual(
      expect.arrayContaining(["--host", "127.0.0.1", "--hide-sidebar", "--platform", "android"]),
    );

    const api = `${node.url}${access.path}/vendor/serve-emu/api/devices`;
    // No credentials, a wrong ticket, a path T3 never forwards.
    expect((await fetch(api)).status).toBe(401);
    expect((await fetch(`${api}?wsTicket=wrong`)).status).toBe(401);
    // A wrong ticket is refused even beside a good token: the ticket is what was sent.
    expect(
      (await fetch(`${api}?wsTicket=wrong`, { headers: { authorization: `Bearer ${node.token}` } }))
        .status,
    ).toBe(401);
    // A redirect inside the hub stays under the node's hub path.
    const moved = await fetch(`${node.url}/device-hub/vendor/serve-emu/health`, {
      headers: { authorization: `Bearer ${node.token}` },
      redirect: "manual",
    });
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("/device-hub/vendor/serve-emu/api/devices");
    // One that leaves the hub is dropped.
    const away = await fetch(`${node.url}/device-hub/vendor/serve-emu/api/accessibility`, {
      headers: { authorization: `Bearer ${node.token}` },
      redirect: "manual",
    });
    expect(away.headers.get("location")).toBeNull();
    // A hub that dies mid-stream ends the client's response instead of leaving it open.
    const feed = await fetch(`${node.url}/device-hub/vendor/serve-sim/helper/SIM-1/stream.mjpeg`, {
      headers: { authorization: `Bearer ${node.token}` },
    });
    expect(feed.status).toBe(200);
    await expect(feed.text()).rejects.toThrow();
    expect(
      (
        await fetch(`${node.url}/device-hub/vendor/serve-sim/api/exec`, {
          headers: { authorization: `Bearer ${node.token}` },
        })
      ).status,
    ).toBe(404);

    // The owner's token reaches the hub; credentials stay at the node.
    const byToken = await fetch(`${api}?device=emulator-5554`, {
      headers: {
        authorization: `Bearer ${node.token}`,
        cookie: "jhin_session=secret",
        referer: `${node.url}/?wsTicket=secret`,
        "x-forwarded-for": "10.0.0.1",
      },
    });
    expect(byToken.status).toBe(200);
    expect(byToken.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(byToken.headers.get("content-encoding")).toBeNull();
    // The hub's cookies and CORS headers never land on the node's origin.
    expect(byToken.headers.get("set-cookie")).toBeNull();
    expect(byToken.headers.get("access-control-allow-origin")).toBeNull();
    expect(byToken.headers.get("content-type")).toBe("application/json");
    const echoed = (await byToken.json()) as { path: string; search: string; headers: object };
    expect(echoed.path).toBe("/vendor/serve-emu/api/devices");
    expect(echoed.search).toBe("?device=emulator-5554");
    expect(echoed.headers).not.toHaveProperty("authorization");
    expect(echoed.headers).not.toHaveProperty("cookie");
    expect(echoed.headers).not.toHaveProperty("referer");
    expect(echoed.headers).not.toHaveProperty("x-forwarded-for");

    // A ticket works in the query and never travels on.
    const byTicket = await fetch(`${api}?device=emulator-5554&wsTicket=${ticket}`);
    expect(byTicket.status).toBe(200);
    expect(((await byTicket.json()) as { search: string }).search).toBe("?device=emulator-5554");

    // Changing a stream needs devices.write.
    const reader = await node.call<Access>("device.hub.access", {}, READER);
    const tune = `${node.url}/device-hub/vendor/serve-emu/api/stream-settings`;
    expect(
      (await fetch(`${tune}?wsTicket=${reader.query.wsTicket}`, { method: "POST", body: "{}" }))
        .status,
    ).toBe(403);
    // The owner's media ticket only watches too: tuning takes the bearer token.
    expect((await fetch(`${tune}?wsTicket=${ticket}`, { method: "POST", body: "{}" })).status).toBe(
      403,
    );
    const tuned = await fetch(tune, {
      method: "POST",
      body: '{"fps":30}',
      headers: { authorization: `Bearer ${node.token}` },
    });
    expect(((await tuned.json()) as { body: string }).body).toBe('{"fps":30}');
    // A screenshot POST reads the screen: watching is enough, as in T3.
    const shot = await fetch(
      `${node.url}/device-hub/vendor/serve-emu/api/screenshot?wsTicket=${reader.query.wsTicket}`,
      { method: "POST", body: "{}" },
    );
    expect(shot.status).toBe(200);
    // An upload past 1 MiB is refused and no longer read.
    const tooLarge = await new Promise<number>((resolve, reject) => {
      const upload = Http.request(
        `${node.url}/device-hub/vendor/serve-emu/api/screenshot?wsTicket=${reader.query.wsTicket}`,
        { method: "POST" },
        (answer) => {
          answer.resume();
          resolve(answer.statusCode ?? 0);
        },
      );
      upload.once("error", reject);
      upload.write(Buffer.alloc(2 * 1024 * 1024));
    });
    expect(tooLarge).toBe(413);

    // The hub decodes before it routes: an encoded path is checked as it will be read.
    const raw = (path: string) =>
      new Promise<number>((resolve, reject) => {
        Http.get(
          `${node.url}${path}`,
          { headers: { authorization: `Bearer ${node.token}` } },
          (answer) => {
            answer.resume();
            resolve(answer.statusCode ?? 0);
          },
        ).once("error", reject);
      });
    expect(
      await raw("/device-hub/vendor/serve-sim/helper/..%2Fapi%2Fexec%2F..%2FSIM-1/config"),
    ).toBe(404);
    expect(await raw("/device-hub/vendor/serve-sim/helper/%2e%2e/config")).toBe(404);
    expect(await raw("/device-hub/vendor/serve-sim/helper/bad%E0%A4%A/config")).toBe(404);
    // An encoded id that stays one segment goes through.
    expect(await raw("/device-hub/vendor/serve-sim/helper/emulator%3A5555/config")).toBe(200);
  });

  it("proxies the hub's WebSockets frame for frame, for a ticket that may drive the device", async () => {
    const tools = fakeTools();
    const node = await startNode(tools);
    const access = await node.call<Access>("device.hub.access", {});
    const ws = `${node.url.replace(/^http/, "ws")}/device-hub/vendor/serve-emu/ws?device=emulator-5554`;

    expect(await connect(ws).opened).toBe(401);
    const reader = await node.call<Access>("device.hub.access", {}, READER);
    expect(await connect(`${ws}&wsTicket=${reader.socketQuery.wsTicket}`).opened).toBe(403);
    // A refused socket does not spend the ticket: it still opens the device list's.
    const list = connect(
      `${node.url.replace(/^http/, "ws")}/device-hub/api/devices/ws?wsTicket=${reader.socketQuery.wsTicket}`,
    );
    expect(await list.opened).toBe(101);
    list.socket.close();
    // A media ticket opens no socket.
    expect(await connect(`${ws}&wsTicket=${access.query.wsTicket}`).opened).toBe(401);

    const client = connect(`${ws}&wsTicket=${access.socketQuery.wsTicket}`, {
      authorization: `Bearer ${node.token}`,
    });
    expect(await client.opened).toBe(101);
    const hello = JSON.parse((await client.message(0)).data.toString()) as {
      url: string;
      headers: object;
    };
    expect(hello.url).toBe("/vendor/serve-emu/ws?device=emulator-5554");
    expect(hello.headers).not.toHaveProperty("authorization");
    client.socket.send(JSON.stringify({ type: "touch", action: "down", x: 0.5, y: 0.5 }));
    const text = await client.message(1);
    expect(text.binary).toBe(false);
    expect(text.data.toString()).toBe('echo:{"type":"touch","action":"down","x":0.5,"y":0.5}');
    client.socket.send(Uint8Array.of(0x83, 1, 2));
    const binary = await client.message(2);
    expect(binary.binary).toBe(true);
    expect([...binary.data]).toEqual([0x83, 1, 2]);

    // A socket ticket opens one socket.
    expect(await connect(`${ws}&wsTicket=${access.socketQuery.wsTicket}`).opened).toBe(401);

    // A client that leaves during the handshake neither crashes the node nor blocks the next.
    const second = await node.call<Access>("device.hub.access", {});
    const port = new URL(node.url).port;
    await new Promise<void>((resolve) => {
      const leaving = Net.connect(Number(port), "127.0.0.1", () => {
        leaving.write(
          [
            `GET /device-hub/vendor/serve-emu/ws?wsTicket=${second.socketQuery.wsTicket} HTTP/1.1`,
            "Host: 127.0.0.1",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
          () => {
            leaving.resetAndDestroy();
            resolve();
          },
        );
      });
    });
    const third = await node.call<Access>("device.hub.access", {});
    const next = connect(`${ws}&wsTicket=${third.socketQuery.wsTicket}`);
    expect(await next.opened).toBe(101);
    next.socket.close();

    // A video feed the ticket opened, running.
    const feed = await fetch(
      `${node.url}/device-hub/vendor/serve-sim/helper/SIM-2/stream.mjpeg?wsTicket=${access.query.wsTicket}`,
    );
    const frames = feed.body!.getReader();
    expect((await frames.read()).done).toBe(false);

    // A rotated owner token closes the owner's sockets and feeds, and its tickets stop working.
    const closed = new Promise<number>((resolve) => client.socket.once("close", resolve));
    await node.kernel.commands.execute("auth.token.rotate", {});
    expect(await closed).toBe(4401);
    await expect(frames.read()).rejects.toThrow();
    expect(
      (await fetch(`${node.url}/device-hub/api/devices?wsTicket=${access.query.wsTicket}`)).status,
    ).toBe(401);
  });

  it("drives the device through agent-device, pinned to it and the thread's session", async () => {
    const tools = fakeTools();
    const node = await startNode(tools);
    await node.call("device.open", { threadId: "t1", deviceId: "emulator-5554" });
    const tapped = await node.call<{ via: string }>("device.tap", { threadId: "t1", x: 10, y: 20 });
    expect(tapped.via).toBe("agent-device");
    await node.call("device.swipe", { threadId: "t1", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
    await node.call("device.type", { threadId: "t1", text: "hello there" });
    await node.call("device.button", { threadId: "t1", button: "home" });
    await node.call("device.button", { threadId: "t1", button: "appSwitcher" });
    await node.call("device.type", { threadId: "t1", text: "--platform ios" });

    const calls = tools.agentCalls();
    // The first command starts the daemon in the plugin's own state folder.
    expect(calls[0]).toEqual(["devices", "--json"]);
    const inputs = calls.slice(1);
    expect(inputs.map((args) => args.slice(args.indexOf("--") + 1))).toEqual([
      ["press", "10", "20"],
      ["swipe", "1", "2", "3", "4"],
      ["type", "hello there"],
      ["home"],
      ["app-switcher"],
      ["type", "--platform ios"],
    ]);
    const pinned = inputs[0]!.slice(0, inputs[0]!.indexOf("--"));
    expect(pinned.slice(0, 4)).toEqual(["--platform", "android", "--serial", "emulator-5554"]);
    expect(pinned[4]).toBe("--config");
    expect(pinned[6]).toBe("--session");
    expect(pinned[7]).toMatch(/^jhin-[0-9a-f]{24}$/);
    expect(pinned[8]).toBe("--json");
    // The endpoint file holds the daemon's token, for its owner only.
    const config = pinned[5]!;
    expect(JSON.parse(Fs.readFileSync(config, "utf8"))).toEqual({
      daemonBaseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      daemonAuthToken: "daemon-token",
    });
    expect(Fs.statSync(config).mode & 0o777).toBe(0o600);
    expect(tools.adbInputs()).toEqual([]);

    // Arguments agent-device does not accept never ran: adb carries the input.
    const rejected = await node.call<{ via: string }>("device.type", {
      threadId: "t1",
      text: "BADARGS",
    });
    expect(rejected.via).toBe("adb");
    expect(tools.adbInputs()).toEqual(["shell input text 'BADARGS'"]);

    // agent-device's own refusal is the command's answer.
    await expect(node.call("device.type", { threadId: "t1", text: "REFUSE" })).rejects.toThrow(
      "Device agent-device type failed: No element at that point.",
    );
  });

  it("falls back to adb only when the daemon was down, and starts it again", async () => {
    const tools = fakeTools();
    const node = await startNode(tools);
    await node.call("device.open", { threadId: "t1", deviceId: "emulator-5554" });
    const first = await node.call<{ via: string }>("device.tap", { threadId: "t1", x: 1, y: 1 });
    expect(first.via).toBe("agent-device");
    const starts = () => tools.agentCalls().filter((args) => args[0] === "devices").length;
    expect(starts()).toBe(1);

    // The daemon dies: its health check fails, so the next start finds it gone and restarts it.
    tools.killDaemon();
    const down = await node.call<{ via: string }>("device.tap", { threadId: "t1", x: 2, y: 2 });
    expect(down.via).toBe("adb");
    expect(tools.adbInputs()).toEqual(["shell input tap 2 2"]);
    expect(starts()).toBe(2);

    tools.reviveDaemon();
    const back = await node.call<{ via: string }>("device.tap", { threadId: "t1", x: 3, y: 3 });
    expect(back.via).toBe("agent-device");
    // A refusal with the daemon alive is not repeated through adb.
    await expect(node.call("device.type", { threadId: "t1", text: "REFUSE" })).rejects.toThrow(
      "No element at that point.",
    );
    expect(tools.adbInputs()).toEqual(["shell input tap 2 2"]);

    // A daemon that dies after carrying an input out: the input is not repeated through adb,
    // and the next one, finding no daemon, goes through adb.
    await expect(node.call("device.type", { threadId: "t1", text: "DIE" })).rejects.toThrow(
      "Device agent-device type failed",
    );
    expect(tools.adbInputs()).toEqual(["shell input tap 2 2"]);
    // The setup says so at once: the tools are no longer ready.
    expect(
      (await node.until((state) => state.setup?.agentToolsReady === false)).setup,
    ).toMatchObject({ agentAccessEnabled: true });
    const after = await node.call<{ via: string }>("device.tap", { threadId: "t1", x: 4, y: 4 });
    expect(after.via).toBe("adb");
    expect(tools.adbInputs()).toEqual(["shell input tap 2 2", "shell input tap 4 4"]);
  });

  it("stops the hub and the agent-device daemon when the plugin goes", async () => {
    const tools = fakeTools();
    const node = await startNode(tools);
    await node.call("device.hub.access", {});
    await node.call("device.open", { threadId: "t1", deviceId: "emulator-5554" });
    await node.call("device.button", { threadId: "t1", button: "back" });
    const port = tools.hubArgs()!.args[tools.hubArgs()!.args.indexOf("--port") + 1];
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);

    await node.kernel.stop();
    running = undefined;
    await expect(fetch(`http://127.0.0.1:${port}/readyz`)).rejects.toThrow();
    expect(tools.agentCalls().at(-1)?.slice(0, 2)).toEqual(["daemon", "stop"]);
  });

  it("stops the hub and drops its tickets when the setting is turned off", async () => {
    const tools = fakeTools();
    const node = await startNode(tools);
    const access = await node.call<Access>("device.hub.access", {});
    const port = tools.hubArgs()!.args[tools.hubArgs()!.args.indexOf("--port") + 1];
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);

    const off = node.until((state) => state.hostStatuses?.local?.status === "idle");
    node.kernel.config.setLayer("node", {
      "jhin.http": { port: 0 },
      "jhin.devices": {
        adb: tools.adb,
        xcrun: Path.join(tools.dir, "no-xcrun"),
        npm: tools.npm,
        hub: false,
      },
    });
    expect((await off).hostStatuses?.local?.detail).toBe(
      "Video and input need the device hub. Turn it on with Devices → Device hub (jhin.devices.hub).",
    );
    await expect(fetch(`http://127.0.0.1:${port}/readyz`)).rejects.toThrow();
    expect(
      (await fetch(`${node.url}/device-hub/api/devices?wsTicket=${access.query.wsTicket}`)).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${node.url}/device-hub/api/devices`, {
          headers: { authorization: `Bearer ${node.token}` },
        })
      ).status,
    ).toBe(503);

    // Off and on again at once: the next request starts the hub after the stop.
    const layer = (hub: boolean) =>
      node.kernel.config.setLayer("node", {
        "jhin.http": { port: 0 },
        "jhin.devices": {
          adb: tools.adb,
          xcrun: Path.join(tools.dir, "no-xcrun"),
          npm: tools.npm,
          hub,
        },
      });
    layer(true);
    const again = await node.call<Access>("device.hub.access", {});
    layer(false);
    layer(true);
    const back = await node.call<Access>("device.hub.access", {});
    expect(back.path).toBe(again.path);
    const newPort = tools.hubArgs()!.args[tools.hubArgs()!.args.indexOf("--port") + 1];
    expect((await fetch(`http://127.0.0.1:${newPort}/readyz`)).status).toBe(200);
  });

  it("falls back to adb when the hub is off, and says why it gives no video", async () => {
    const tools = fakeTools();
    const node = await startNode(tools, { hub: false });
    await node.call("device.open", { threadId: "t1", deviceId: "emulator-5554" });
    await expect(node.call("device.hub.access", {})).rejects.toThrow(
      "Video and input need the device hub. Turn it on with Devices → Device hub (jhin.devices.hub).",
    );
    const tapped = await node.call<{ via: string }>("device.tap", {
      threadId: "t1",
      x: 10.4,
      y: 20,
    });
    expect(tapped.via).toBe("adb");
    await node.call("device.type", { threadId: "t1", text: "it's here" });
    await node.call("device.button", { threadId: "t1", button: "appSwitcher" });
    // `input text` reads `%s` as a space and types no newline: they go in pieces.
    await node.call("device.type", { threadId: "t1", text: "50%s\nok" });
    expect(tools.adbInputs()).toEqual([
      "shell input tap 10 20",
      "shell input text 'it'\\''s%shere'",
      "shell input keyevent 187",
      "shell input text '50'",
      "shell input text '%'",
      "shell input text 's'",
      "shell input keyevent 66",
      "shell input text 'ok'",
    ]);
    expect(tools.npmCalls()).toEqual([]);
  });

  it("falls back to adb when the hub cannot be installed, and reports the failed step", async () => {
    const tools = fakeTools();
    tools.failNpm();
    const node = await startNode(tools);
    const failed = node.until((state) => state.hostStatuses?.local?.status === "failed");
    await expect(node.call("device.hub.access", {})).rejects.toThrow(
      "Device support failed during installing device support.",
    );
    expect((await failed).hostStatuses?.local?.detail).toBe(
      "Device support failed during installing device support.",
    );
    // The next request installs the hub again; then agent-device is the one that fails.
    await node.call("device.open", { threadId: "t1", deviceId: "emulator-5554" });
    await node.call("device.hub.access", {});
    tools.failNpm();
    const tapped = await node.call<{ via: string }>("device.tap", { threadId: "t1", x: 1, y: 2 });
    expect(tapped.via).toBe("adb");
    expect(tools.adbInputs()).toEqual(["shell input tap 1 2"]);
  });

  it("keeps agents to adb until agent access is allowed, then starts their tools (D1328, D1329)", async () => {
    const tools = fakeTools();
    const node = await startNode(tools, { agentAccess: false });
    await node.call("device.open", { threadId: "t1", deviceId: "emulator-5554" });
    const first = await node.call<{ via: string }>("device.tap", { threadId: "t1", x: 1, y: 2 });
    expect(first.via).toBe("adb");
    expect(tools.agentCalls()).toEqual([]);
    const before = await node.until((state) => state.setup !== undefined);
    expect(before.setup).toEqual({
      hubEnabled: true,
      agentAccessEnabled: false,
      onboardingCompleted: false,
      agentToolsReady: false,
    });

    // Allowed: the agent tools install and start at once, and the setup says they are ready.
    const ready = node.until((state) => state.setup?.agentToolsReady === true);
    const layer = (agentAccess: boolean) =>
      node.kernel.config.setLayer("node", {
        "jhin.http": { port: 0 },
        "jhin.devices": {
          adb: tools.adb,
          xcrun: Path.join(tools.dir, "no-xcrun"),
          npm: tools.npm,
          hub: true,
          agentAccess,
          onboardingCompleted: true,
        },
      });
    layer(true);
    expect((await ready).setup).toMatchObject({
      agentAccessEnabled: true,
      onboardingCompleted: true,
    });
    // Ready means started: the daemon was started before any agent asked.
    expect(tools.agentCalls()).toEqual([["devices", "--json"]]);
    const second = await node.call<{ via: string }>("device.tap", { threadId: "t1", x: 1, y: 2 });
    expect(second.via).toBe("agent-device");

    // Taken back: their daemon stops, and agents are back on adb.
    const stopped = node.until(
      (state) => state.setup?.agentAccessEnabled === false && !state.setup.agentToolsReady,
    );
    layer(false);
    // The state says so at once, before the daemon's stop is done.
    expect((await stopped).setup?.hubEnabled).toBe(true);
    await node.until(() =>
      tools.agentCalls().some((args) => args[0] === "daemon" && args[1] === "stop"),
    );
    const third = await node.call<{ via: string }>("device.tap", { threadId: "t1", x: 1, y: 2 });
    expect(third.via).toBe("adb");
  });

  it("starts the agent tools when the hub comes back on with agents allowed, and says when they fail (D1329)", async () => {
    const tools = fakeTools();
    const node = await startNode(tools, { agentAccess: false });
    await node.call("device.open", { threadId: "t1", deviceId: "emulator-5554" });
    await node.until((state) => state.hostStatuses?.local?.status === "ready");
    const layer = (hub: boolean, agentAccess: boolean) =>
      node.kernel.config.setLayer("node", {
        "jhin.http": { port: 0 },
        "jhin.devices": {
          adb: tools.adb,
          xcrun: Path.join(tools.dir, "no-xcrun"),
          npm: tools.npm,
          hub,
          agentAccess,
        },
      });

    // Allowed, and the install of the agent tools fails: the setup shows the failure.
    tools.failNpm();
    const failed = node.until((state) => state.hostStatuses?.local?.status === "failed");
    layer(true, true);
    expect((await failed).hostStatuses?.local?.detail).toBe(
      "Device support failed during installing agent tools.",
    );
    // The hub off and on again with agents still allowed: the tools start at once.
    const off = node.until((state) => state.setup?.hubEnabled === false);
    layer(false, true);
    await off;
    const ready = node.until((state) => state.setup?.agentToolsReady === true);
    layer(true, true);
    expect((await ready).setup).toMatchObject({ hubEnabled: true, agentAccessEnabled: true });
  });

  it("starts the agent tools when access is allowed before any device was opened (D1329)", async () => {
    const tools = fakeTools();
    const node = await startNode(tools, { hub: false, agentAccess: false });
    // Both turned on in one change, with no device opened yet: the tools start at once.
    const ready = node.until((state) => state.setup?.agentToolsReady === true);
    node.kernel.config.setLayer("node", {
      "jhin.http": { port: 0 },
      "jhin.devices": {
        adb: tools.adb,
        xcrun: Path.join(tools.dir, "no-xcrun"),
        npm: tools.npm,
        hub: true,
        agentAccess: true,
      },
    });
    expect((await ready).setup).toMatchObject({ hubEnabled: true, agentAccessEnabled: true });
    expect(tools.agentCalls()).toEqual([["devices", "--json"]]);
  });

  it("does not start the agent tools when access is taken back before their turn (D1329)", async () => {
    const tools = fakeTools();
    const node = await startNode(tools, { agentAccess: false });
    await node.call("device.open", { threadId: "t1", deviceId: "emulator-5554" });
    await node.until((state) => state.hostStatuses?.local?.status === "ready");
    const layer = (agentAccess: boolean) =>
      node.kernel.config.setLayer("node", {
        "jhin.http": { port: 0 },
        "jhin.devices": {
          adb: tools.adb,
          xcrun: Path.join(tools.dir, "no-xcrun"),
          npm: tools.npm,
          hub: true,
          agentAccess,
        },
      });
    // On, then off before the start's turn: the start asks again and does not run.
    layer(true);
    layer(false);
    // The hub's own queue: once this answers, the start and the stop have had their turns.
    await node.call("device.hub.access", {});
    expect(tools.agentCalls().filter((args) => args[0] === "devices")).toEqual([]);
    const state = await node.until((each) => each.setup?.agentAccessEnabled === false);
    expect(state.setup?.agentToolsReady).toBe(false);
  });

  it("lets agents use agent-device on a node that turned the hub on before agent access existed (D1329)", async () => {
    const tools = fakeTools();
    const node = await startNode(tools, { agentAccess: undefined });
    await node.call("device.open", { threadId: "t1", deviceId: "emulator-5554" });
    const tapped = await node.call<{ via: string }>("device.tap", { threadId: "t1", x: 1, y: 2 });
    expect(tapped.via).toBe("agent-device");
    const state = await node.until((each) => each.setup !== undefined);
    expect(state.setup?.agentAccessEnabled).toBe(true);
  });
});
