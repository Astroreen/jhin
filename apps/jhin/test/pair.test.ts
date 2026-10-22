import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { formatPairOutput, pairingNotes, reachableBaseUrl } from "../src/pair.ts";
import { seedToken } from "./support/token.ts";

const BIN = Path.resolve(import.meta.dirname, "../bin/jhin.js");

let serve: ChildProcess.ChildProcess | undefined;
afterEach(async () => {
  if (serve === undefined || serve.exitCode !== null) return;
  const exited = new Promise((resolve) => serve!.once("exit", resolve));
  serve.kill("SIGTERM");
  await exited;
  serve = undefined;
});

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

describe("jhin pair", () => {
  // Spawns a node and two CLI processes; the limit bounds the run, nothing waits on time.
  it(
    "finds the running node, prints T3's block with a QR code, and the code pairs once with its grants",
    { timeout: 60_000 },
    async () => {
      const home = newHome();
      await startServe(home);
      const runtime = JSON.parse(Fs.readFileSync(runtimeFile(home), "utf8")) as {
        url: string;
        pid: number;
      };
      expect(runtime.pid).toBe(serve!.pid);
      expect(Fs.statSync(runtimeFile(home)).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(runtime)).not.toContain("t".repeat(64));

      const result = await jhin(
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
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const lines = result.stdout.split("\n");
      expect(lines[0]).toMatch(/^Pairing with .+ \(http:\/\/127\.0\.0\.1:\d+\)\.$/);
      expect(result.stdout).toMatch(/[█▀▄]/u);
      const pairingUrl = /^Pairing URL: (\S+)$/m.exec(result.stdout)![1]!;
      const code = /^Code: (\S+)$/m.exec(result.stdout)![1]!;
      expect(pairingUrl).toBe(`${runtime.url}/pair#token=${code}`);
      expect(code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/);
      const expires = Date.parse(/^Expires: (\S+)$/m.exec(result.stdout)![1]!);
      expect(expires).toBeGreaterThan(Date.now() + 9 * 60_000);
      expect(result.stdout).toContain("Note: This URL is only reachable from this machine.");

      const paired = await fetch(`${runtime.url}/auth/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      expect(paired.status).toBe(200);
      expect(await paired.json()).toMatchObject({ permissions: ["threads.read", "example.*"] });
      const again = await fetch(`${runtime.url}/auth/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      expect(again.status).not.toBe(200);

      // The node never logs the code.
      expect(Fs.readFileSync(Path.join(home, "logs", "node.log"), "utf8")).not.toContain(code);

      const json = await jhin("pair", "--home", home, "--json");
      expect(json.status).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({
        label: "jhin pair",
        permissions: ["*"],
        url: expect.stringMatching(/\/pair#token=/),
      });

      const exited = new Promise((resolve) => serve!.once("exit", resolve));
      serve!.kill("SIGTERM");
      await exited;
      expect(Fs.existsSync(runtimeFile(home))).toBe(false);
    },
  );

  it("says so when no node runs from the home, and when the recorded one is gone", async () => {
    const home = newHome();
    const none = await jhin("pair", "--home", home);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("No running Jhin node found.");
    expect(none.stderr).toContain(runtimeFile(home));
    expect(none.stderr).toContain("Start one with `jhin serve`.");

    // A dead node's file: its process is gone.
    const dead = ChildProcess.spawnSync(process.execPath, ["-e", "0"]);
    Fs.mkdirSync(Path.dirname(runtimeFile(home)), { recursive: true });
    Fs.writeFileSync(
      runtimeFile(home),
      JSON.stringify({ url: "http://127.0.0.1:9", pid: dead.pid, instance: "x", startedAt: 0 }),
    );
    expect((await jhin("pair", "--home", home)).stderr).toContain("No running Jhin node found.");
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
