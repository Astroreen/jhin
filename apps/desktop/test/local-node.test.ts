import * as Fs from "node:fs";
import * as Http from "node:http";
import * as Net from "node:net";
import * as Os from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  attachRunningNode,
  cliEntry,
  freePortAbove,
  portInUse,
  startLocalNode,
  startOnFreePort,
  watchAttachedNode,
  type PortChoice,
} from "../src/local-node.ts";

const CLI = Path.join(import.meta.dirname, "fixtures", "fake-cli.mjs");
const PATHS = { cli: CLI, plugin: "/nowhere" };
const previous = process.env["FAKE_CLI"];
afterEach(() => {
  if (previous === undefined) delete process.env["FAKE_CLI"];
  else process.env["FAKE_CLI"] = previous;
});

const home = () => Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-desktop-node-"));

describe("startLocalNode (D512)", () => {
  it("resolves with the address the node prints and the token of its home", async () => {
    process.env["FAKE_CLI"] = "ready";
    const node = await startLocalNode(PATHS, home());
    expect(node).toMatchObject({ url: "http://127.0.0.1:7777/", token: "secret" });
    await node.stop();
  });

  it("passes the port the app chose (D1487)", async () => {
    process.env["FAKE_CLI"] = "ready";
    const node = await startLocalNode(PATHS, home(), undefined, 7790);
    expect(node.url).toBe("http://127.0.0.1:7790/");
    await node.stop();
  });

  it("rejects with the node's output when it exits first", async () => {
    process.env["FAKE_CLI"] = "exit";
    await expect(startLocalNode(PATHS, home())).rejects.toThrow(
      /exited with 3:\nconfig file not applied/,
    );
  });

  it("stops a node without a token and says where it looked", async () => {
    process.env["FAKE_CLI"] = "no-token";
    await expect(startLocalNode(PATHS, home())).rejects.toThrow(
      /no access token at .*jhin\.auth-token/,
    );
  });

  it("stops a node that does not serve the web client and shows its problems", async () => {
    process.env["FAKE_CLI"] = "no-ui";
    await expect(startLocalNode(PATHS, home())).rejects.toThrow(
      /does not serve the web client:\nfailed jhin\.http: Port 7777/,
    );
  });

  it("kills a node that ignores SIGTERM, and tells nobody it stopped", async () => {
    process.env["FAKE_CLI"] = "stuck";
    // The grace period ends at once: SIGKILL follows SIGTERM.
    const node = await startLocalNode(PATHS, home(), (kill) => {
      kill();
      return () => undefined;
    });
    const exits: string[] = [];
    node.onExit((output) => exits.push(output));
    await node.stop();
    expect(exits).toEqual([]);
  });

  it("reports a node that exits by itself to its listeners", async () => {
    process.env["FAKE_CLI"] = "ready";
    const node = await startLocalNode(PATHS, home());
    const exited = new Promise<string>((resolve) => node.onExit(resolve));
    const [pid] = (await import("node:child_process"))
      .execFileSync(
        "pgrep",
        ["-f", "--", `fake-cli.mjs serve --ui --plugin-dir /nowhere --home ${node.home}`],
        {
          encoding: "utf8",
        },
      )
      .trim()
      .split("\n")
      .map(Number);
    process.kill(pid!, "SIGKILL");
    expect(await exited).toContain("ui: http://127.0.0.1:7777/");
  });
});

describe("cliEntry (D942)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) Fs.rmSync(dir, { recursive: true, force: true });
  });
  const manifest = (content: unknown) => {
    const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-cli-entry-"));
    dirs.push(dir);
    Fs.writeFileSync(Path.join(dir, "package.json"), JSON.stringify(content));
    return Path.join(dir, "package.json");
  };

  it("runs the bin the manifest names, in the workspace and packed", () => {
    const workspace = manifest({ bin: { jhin: "./bin/jhin.js" } });
    expect(cliEntry(workspace)).toBe(Path.join(Path.dirname(workspace), "bin", "jhin.js"));
    const packed = manifest({ bin: { jhin: "./dist/main.js" } });
    expect(cliEntry(packed)).toBe(Path.join(Path.dirname(packed), "dist", "main.js"));
  });

  it("fails clearly without a jhin bin", () => {
    expect(() => cliEntry(manifest({ bin: "./x.js" }))).toThrow('names no "jhin" bin');
  });
});

describe("attachRunningNode (D1486)", () => {
  const servers: Http.Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  /** A node of `dir` as `jhin.http` records it: an instance, and the web client or not. */
  async function runningNode(dir: string, ui: boolean, token = "secret"): Promise<string> {
    const server = Http.createServer((request, response) => {
      if (request.url === "/.well-known/jhin") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ instance: "this-node" }));
      } else if (request.url === "/" && ui) {
        response.writeHead(200, { "content-type": "text/html" }).end("<script></script>");
      } else {
        response.writeHead(404).end("Not found");
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as Net.AddressInfo).port}`;
    Fs.mkdirSync(Path.join(dir, "data", "jhin.http"), { recursive: true });
    Fs.writeFileSync(
      Path.join(dir, "data", "jhin.http", "runtime.json"),
      JSON.stringify({ url, pid: process.pid, instance: "this-node", startedAt: 0 }),
    );
    if (token !== "") {
      Fs.mkdirSync(Path.join(dir, "data", "jhin.auth-token"), { recursive: true });
      Fs.writeFileSync(Path.join(dir, "data", "jhin.auth-token", "token"), `${token}\n`);
    }
    return url;
  }

  it("finds nothing in a home no node runs from", async () => {
    await expect(attachRunningNode(home())).resolves.toBeUndefined();
  });

  it("shows the running node's web client with the home's token", async () => {
    const dir = home();
    const url = await runningNode(dir, true);
    await expect(attachRunningNode(dir)).resolves.toEqual({
      url: `${url}/`,
      token: "secret",
      home: dir,
      pid: process.pid,
    });
  });

  it("says so when the running node serves no web client", async () => {
    const dir = home();
    const url = await runningNode(dir, false);
    await expect(attachRunningNode(dir)).rejects.toThrow(
      `A Jhin node of this home already runs at ${url}/ without the web client. Stop it, or start it with \`jhin serve --ui\`.`,
    );
  });

  it("says so when the home has no token for it", async () => {
    const dir = home();
    await runningNode(dir, true, "");
    await expect(attachRunningNode(dir)).rejects.toThrow(/no access token at .*jhin\.auth-token/);
  });

  it("ignores a record whose address answers with another instance", async () => {
    const dir = home();
    await runningNode(dir, true);
    const file = Path.join(dir, "data", "jhin.http", "runtime.json");
    const state = JSON.parse(Fs.readFileSync(file, "utf8"));
    Fs.writeFileSync(file, JSON.stringify({ ...state, instance: "a-node-long-gone" }));
    await expect(attachRunningNode(dir)).resolves.toBeUndefined();
  });
});

describe("watchAttachedNode (D1486)", () => {
  afterEach(() => vi.useRealTimers());

  it("tells once that the node's process is gone", () => {
    vi.useFakeTimers();
    let alive = true;
    const gone: number[] = [];
    watchAttachedNode(
      { pid: 42 },
      () => gone.push(42),
      () => alive,
    );
    vi.advanceTimersByTime(6_000);
    expect(gone).toEqual([]);
    alive = false;
    vi.advanceTimersByTime(2_000);
    vi.advanceTimersByTime(10_000);
    expect(gone).toEqual([42]);
  });
});

describe("another port when the node's is taken (D1487)", () => {
  it("reads the port and address jhin.http could not listen on", () => {
    expect(
      portInUse(
        "The local node does not serve the web client:\n  failed jhin.http: Port 7777 on 127.0.0.1 is in use; set jhin.http.port",
      ),
    ).toEqual({ port: 7777, host: "127.0.0.1" });
    expect(portInUse("The local node exited with 3:\nconfig file not applied")).toBeUndefined();
  });

  it("picks the first port above the taken one that is free", async () => {
    const blockers: Net.Server[] = [];
    const listen = (port: number) =>
      new Promise<number>((resolve) => {
        const server = Net.createServer();
        blockers.push(server);
        server.listen(port, "127.0.0.1", () => resolve((server.address() as Net.AddressInfo).port));
      });
    try {
      const taken = await listen(0);
      // The next one may be taken by someone else too; whatever is picked is free and above.
      const picked = await freePortAbove(taken, "127.0.0.1");
      expect(picked).toBeGreaterThan(taken);
      await expect(listen(picked)).resolves.toBe(picked);
    } finally {
      await Promise.all(
        blockers.map((server) => new Promise((resolve) => server.close(() => resolve(null)))),
      );
    }
  });
});

describe("startOnFreePort (D1487)", () => {
  const busy = (port: number) =>
    new Error(
      `The local node does not serve the web client:\n  failed jhin.http: Port ${port} on 127.0.0.1 is in use`,
    );
  /** A node whose ports in `taken` are in use; records starts and what was kept. */
  function choice(
    taken: readonly number[],
    overrides: Partial<PortChoice<string>> & { configured?: number } = {},
  ) {
    const starts: (number | undefined)[] = [];
    const kept: number[] = [];
    const value: PortChoice<string> = {
      kept: undefined,
      start: (port) => {
        starts.push(port);
        // A configured port wins over the one passed, as the distribution layer is under it.
        const listening = overrides.configured ?? port ?? 7777;
        return taken.includes(listening)
          ? Promise.reject(busy(listening))
          : Promise.resolve(`node on ${listening}`);
      },
      running: () => Promise.resolve(undefined),
      freePortAbove: (from) => {
        let port = from + 1;
        while (taken.includes(port)) port += 1;
        return Promise.resolve(port);
      },
      keep: (port) => void kept.push(port),
      quitting: () => false,
      log: () => undefined,
      ...overrides,
    };
    return { value, starts, kept };
  }

  it("starts on the node's own port, keeping nothing", async () => {
    const { value, starts, kept } = choice([]);
    await expect(startOnFreePort(value)).resolves.toBe("node on 7777");
    expect(starts).toEqual([undefined]);
    expect(kept).toEqual([]);
  });

  it("moves to the next free port when the node's is taken, and keeps it once up", async () => {
    const { value, starts, kept } = choice([7777, 7778]);
    await expect(startOnFreePort(value)).resolves.toBe("node on 7779");
    expect(starts).toEqual([undefined, 7779]);
    expect(kept).toEqual([7779]);
  });

  it("starts on the kept port, and picks again above it when that is taken too", async () => {
    const kept7790 = choice([], { kept: 7790 });
    await expect(startOnFreePort(kept7790.value)).resolves.toBe("node on 7790");
    expect(kept7790.starts).toEqual([7790]);

    const taken = choice([7790], { kept: 7790 });
    await expect(startOnFreePort(taken.value)).resolves.toBe("node on 7791");
    expect(taken.kept).toEqual([7791]);
  });

  it("leaves a configured port's failure to the node's dialog when a port is kept", async () => {
    const { value, starts, kept } = choice([8000], { kept: 7790, configured: 8000 });
    await expect(startOnFreePort(value)).rejects.toThrow("Port 8000 on 127.0.0.1 is in use");
    expect(starts).toEqual([7790]);
    expect(kept).toEqual([]);
  });

  it("keeps nothing when the second start fails too (a configured port, nothing kept)", async () => {
    const { value, starts, kept } = choice([8000], { configured: 8000 });
    await expect(startOnFreePort(value)).rejects.toThrow("Port 8000 on 127.0.0.1 is in use");
    expect(starts).toEqual([undefined, 8001]);
    expect(kept).toEqual([]);
  });

  it("says so when a node of the home took the port meanwhile", async () => {
    const { value, starts } = choice([7777], {
      running: () => Promise.resolve({ url: "http://127.0.0.1:7777" }),
    });
    await expect(startOnFreePort(value)).rejects.toThrow(
      "A Jhin node of this home already runs at http://127.0.0.1:7777. Quit it, or restart the app to show it.",
    );
    expect(starts).toEqual([undefined]);
  });

  it("starts nothing again while the app quits, and passes other failures on", async () => {
    const quitting = choice([7777], { quitting: () => true });
    await expect(startOnFreePort(quitting.value)).rejects.toThrow("Port 7777");
    expect(quitting.starts).toEqual([undefined]);

    const other = choice([], { start: () => Promise.reject(new Error("exited with 3")) });
    await expect(startOnFreePort(other.value)).rejects.toThrow("exited with 3");
  });
});
