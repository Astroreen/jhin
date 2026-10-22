import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Http from "node:http";
import type { AddressInfo } from "node:net";
import * as Os from "node:os";
import * as Path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { renderTerminalQrCode } from "@jhin/qr-code";

import {
  discoverNode,
  formatPairOutput,
  localUrl,
  pairingNotes,
  parsePairFlags,
  reachableBaseUrl,
} from "../src/pair.ts";
import { seedToken } from "./support/token.ts";

const BIN = Path.resolve(import.meta.dirname, "../bin/jhin.js");

let serve: ChildProcess.ChildProcess | undefined;
async function stopServe(): Promise<void> {
  if (serve === undefined || serve.exitCode !== null) return;
  const exited = new Promise((resolve) => serve!.once("exit", resolve));
  serve.kill("SIGTERM");
  await exited;
}

/** Starts `jhin serve` on a free port and resolves once it prints its RPC URL. */
function startServe(home: string): Promise<void> {
  serve = ChildProcess.spawn(process.execPath, [BIN, "serve", "--home", home, "--cwd", home], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stderr = "";
    serve!.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
      if (/rpc: ws:\/\/\S+/.test(stderr)) resolve();
    });
    serve!.once("exit", (code) => reject(new Error(`jhin serve exited with ${code}:\n${stderr}`)));
  });
}

function jhin(...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  // Asynchronous: the node answering `jhin pair` runs in another process of this test.
  return new Promise((resolve) => {
    ChildProcess.execFile(
      process.execPath,
      [BIN, ...args],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({ status: error === null ? 0 : Number(error.code ?? 1), stdout, stderr }),
    );
  });
}

function newHome(): string {
  const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-pair-"));
  Fs.mkdirSync(Path.join(home, ".jhin"));
  Fs.writeFileSync(
    Path.join(home, ".jhin", "config.jsonc"),
    '{ "jhin.http": { "port": 0 }, "jhin.threads": { "defaultAgent": "jhin.agent-fake" } }',
  );
  seedToken(home);
  return home;
}

const runtimeFile = (home: string) => Path.join(home, "data", "jhin.http", "runtime.json");

function writeRuntime(home: string, state: { url: string; pid: number; instance: string }): void {
  Fs.mkdirSync(Path.dirname(runtimeFile(home)), { recursive: true });
  Fs.writeFileSync(runtimeFile(home), JSON.stringify({ ...state, startedAt: 0 }));
}

describe("jhin pair against a running node", () => {
  const home = newHome();
  let runtime: { url: string; pid: number };
  let output: { status: number; stdout: string; stderr: string };
  let code: string;
  let asJson: { status: number; stdout: string };

  // Spawns a node and CLI processes; the limit bounds the run, nothing waits on time.
  beforeAll(async () => {
    await startServe(home);
    runtime = JSON.parse(Fs.readFileSync(runtimeFile(home), "utf8"));
    output = await jhin(
      "pair",
      "--home",
      home,
      "--label",
      "Phone",
      "--ttl",
      "10",
      "--permission",
      "threads.read",
      "--permission",
      "example.*",
    );
    code = /^Code: (\S+)$/m.exec(output.stdout)?.[1] ?? "";
    asJson = await jhin("pair", "--home", home, "--json");
  }, 60_000);
  afterAll(stopServe);

  it("finds the node by its runtime.json, which holds no token", () => {
    expect(runtime.pid).toBe(serve!.pid);
    expect(Fs.statSync(runtimeFile(home)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(runtime)).not.toContain("t".repeat(64));
  });

  it("prints T3's block with a QR code and the loopback note", () => {
    expect(output.stderr).toBe("");
    expect(output.status).toBe(0);
    expect(output.stdout.split("\n")[0]).toMatch(
      /^Pairing with .+ \(http:\/\/127\.0\.0\.1:\d+\)\.$/,
    );
    // The QR code printed is the encoder's for the pairing URL, module for module.
    const pairingUrl = /^Pairing URL: (\S+)$/m.exec(output.stdout)![1]!;
    expect(output.stdout).toContain(`\n${renderTerminalQrCode(pairingUrl)}\n`);
    expect(code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/);
    expect(/^Pairing URL: (\S+)$/m.exec(output.stdout)![1]).toBe(
      `${runtime.url}/pair#token=${code}`,
    );
    const expires = Date.parse(/^Expires: (\S+)$/m.exec(output.stdout)![1]!);
    expect(expires).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(output.stdout).toContain("Note: This URL is only reachable from this machine.");
  });

  it("gives a code that pairs once, with the grants asked for", async () => {
    const pair = () =>
      fetch(`${runtime.url}/auth/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
    const paired = await pair();
    expect(paired.status).toBe(200);
    expect(await paired.json()).toMatchObject({ permissions: ["threads.read", "example.*"] });
    expect((await pair()).status).toBe(401);
  });

  it("prints the link as JSON, with every grant of the token by default", () => {
    const json = asJson;
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      label: "jhin pair",
      permissions: ["*"],
      url: expect.stringMatching(/\/pair#token=/),
    });
  });

  it("logs no code, and removes runtime.json when the node stops", async () => {
    await stopServe();
    expect(Fs.existsSync(runtimeFile(home))).toBe(false);
    // Read after the node exited: every log line is written.
    expect(Fs.readFileSync(Path.join(home, "logs", "node.log"), "utf8")).not.toContain(code);
  });
});

describe("jhin pair's flags (security.md D1185, D1189)", () => {
  /** The options as `jhin`'s argv parser gives them: the last value, or `true` without one. */
  const flags = (...argv: string[]) => {
    const options = new Map<string, string | true>();
    for (let index = 0; index < argv.length; index += 1) {
      const key = argv[index]!.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) options.set(key, true);
      else {
        options.set(key, next);
        index += 1;
      }
    }
    return { argv, options };
  };
  const refusal = (hasUrl: boolean, ...argv: string[]) => {
    const { options } = flags(...argv);
    const parsed = parsePairFlags(argv, options, hasUrl);
    return "error" in parsed ? parsed.error : undefined;
  };

  it("refuses a flag without its value instead of pairing with every permission", () => {
    expect(refusal(false, "--permission")).toContain("needs a value");
    expect(refusal(false, "--permission", "--json")).toContain("needs a value");
    expect(refusal(false, "--permission=")).toContain("needs a value");
    expect(refusal(false, "--ttl")).toContain("needs a value");
    expect(refusal(false, "--label")).toContain("needs a value");
    for (const ttl of ["Infinity", "-3", "soon"]) {
      expect(refusal(false, "--ttl", ttl)).toContain("--ttl takes minutes");
    }
  });

  it("refuses what would publish or pair somewhere else than asked", () => {
    expect(refusal(true, "--tailscale")).toContain("takes no --url or --base-url");
    expect(refusal(false, "--tailscale", "--base-url", "https://x.example")).toContain(
      "takes no --url or --base-url",
    );
    expect(refusal(false, "--tailscale", "--tailscale-serve-port", "70000")).toContain(
      "takes a port",
    );
    expect(refusal(false, "--tailscale", "--tailscale-serve-port")).toContain("needs a value");
    expect(refusal(false, "--tailscale-serve-port", "8443")).toContain("needs --tailscale");
    expect(refusal(false, "--tailscale", "yes")).toContain("takes no value");
  });

  it("reads repeated permissions, minutes and the Tailscale port", () => {
    const argv = [
      "--permission",
      "threads.read",
      "--permission=git.*",
      "--ttl",
      "10",
      "--tailscale",
      "--tailscale-serve-port",
      "8443",
    ];
    expect(parsePairFlags(argv, flags(...argv).options, false)).toEqual({
      permissions: ["threads.read", "git.*"],
      ttlMinutes: 10,
      tailscale: true,
      servePort: 8443,
    });
  });

  it("exits 2 on a refused flag", async () => {
    const refused = await jhin("pair", "--home", newHome(), "--permission");
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("--permission needs a value");
  });
});

describe("finding the running node (security.md D1184)", () => {
  it("says so when no node runs from the home, and when the recorded one is gone", async () => {
    const home = newHome();
    const none = await jhin("pair", "--home", home);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("No running Jhin node found.");
    expect(none.stderr).toContain(runtimeFile(home));
    expect(none.stderr).toContain("Start one with `jhin serve`.");

    // A dead node's file: its process is gone.
    const dead = ChildProcess.spawnSync(process.execPath, ["-e", "0"]);
    writeRuntime(home, { url: "http://127.0.0.1:9", pid: dead.pid!, instance: "x" });
    expect((await jhin("pair", "--home", home)).stderr).toContain("No running Jhin node found.");
  });

  it("trusts a live process only when its address answers with the same instance", async () => {
    const home = newHome();
    const server = Http.createServer((request, response) => {
      if (request.url === "/.well-known/jhin") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ instance: "the-listener" }));
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // A live pid (this test's), but another listener on the recorded address.
      writeRuntime(home, { url, pid: process.pid, instance: "a-node-long-gone" });
      await expect(discoverNode(home)).rejects.toMatchObject({ code: "NO_RUNNING_NODE" });
      writeRuntime(home, { url, pid: process.pid, instance: "the-listener" });
      await expect(discoverNode(home)).resolves.toMatchObject({ url, instance: "the-listener" });
    } finally {
      server.close();
    }
    // Nothing answers at all.
    writeRuntime(home, { url, pid: process.pid, instance: "the-listener" });
    await expect(discoverNode(home)).rejects.toMatchObject({ code: "NO_RUNNING_NODE" });
    // A file without an instance is never trusted, even with nothing to compare against.
    Fs.writeFileSync(runtimeFile(home), JSON.stringify({ url, pid: process.pid, startedAt: 0 }));
    await expect(discoverNode(home)).rejects.toMatchObject({ code: "NO_RUNNING_NODE" });
  });

  it("probes a wildcard listener over loopback", () => {
    expect(localUrl("http://0.0.0.0:7777")).toBe("http://127.0.0.1:7777");
    expect(localUrl("http://[::]:7777")).toBe("http://127.0.0.1:7777");
    expect(localUrl("http://100.64.0.5:7777")).toBe("http://100.64.0.5:7777");
  });
});

describe("the pairing block", () => {
  it("is T3's, with notes for a link only this machine or a plain-HTTP path reaches", () => {
    const output = formatPairOutput({
      nodeLabel: "studio",
      origin: "http://0.0.0.0:7777",
      pairingUrl: "http://192.168.1.20:7777/pair#token=ABCDEFGHJKMN",
      code: "ABCDEFGHJKMN",
      expiresAt: Date.UTC(2026, 9, 22, 12, 5),
      notes: pairingNotes("http://192.168.1.20:7777/pair#token=ABCDEFGHJKMN"),
    });
    expect(output.split("\n")[0]).toBe("Pairing with studio (http://0.0.0.0:7777).");
    expect(output).toContain("Pairing URL: http://192.168.1.20:7777/pair#token=ABCDEFGHJKMN\n");
    expect(output).toContain("Code: ABCDEFGHJKMN\nExpires: 2026-10-22T12:05:00.000Z\n");
    expect(output).toContain("\nNote: This URL is plain HTTP:");
    expect(pairingNotes("https://studio.tail1234.ts.net/pair#token=X")).toEqual([]);
    expect(pairingNotes("http://localhost:7777/pair#token=X")[0]).toContain(
      "only reachable from this machine",
    );
  });

  it("names a wildcard listener by this machine's first external address", () => {
    const interfaces = {
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      eth0: [
        { address: "fe80::1", family: "IPv6", internal: false },
        { address: "192.168.1.20", family: "IPv4", internal: false },
      ],
    } as unknown as NodeJS.Dict<Os.NetworkInterfaceInfo[]>;
    expect(reachableBaseUrl("http://0.0.0.0:7777", interfaces)).toBe("http://192.168.1.20:7777");
    expect(reachableBaseUrl("http://[::]:7777", { lo: interfaces["lo"]! })).toBe(
      "http://localhost:7777",
    );
    expect(reachableBaseUrl("http://100.64.0.5:7777", interfaces)).toBe("http://100.64.0.5:7777");
  });
});
