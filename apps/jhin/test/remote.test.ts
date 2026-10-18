import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { connectWebSocket, createRpcClient } from "@jhin/rpc";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { readToken } from "./support/token.ts";

const BIN = Path.resolve(import.meta.dirname, "../bin/jhin.js");

let serve: ChildProcess.ChildProcess | undefined;
afterEach(async () => {
  if (serve === undefined || serve.exitCode !== null) return;
  const exited = new Promise((resolve) => serve!.once("exit", resolve));
  serve.kill("SIGTERM");
  await exited;
  serve = undefined;
});

/** Starts `jhin serve` and resolves with the RPC URL it prints. */
function startServe(home: string): Promise<string> {
  serve = ChildProcess.spawn(process.execPath, [BIN, "serve", "--home", home, "--cwd", home], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stderr = "";
    serve!.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
      const match = /rpc: (ws:\/\/\S+)/.exec(stderr);
      if (match !== null) resolve(match[1]!);
    });
    serve!.once("exit", (code) => reject(new Error(`jhin serve exited with ${code}:\n${stderr}`)));
  });
}

function jhin(...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = ChildProcess.spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("a running node", () => {
  // Spawns a node and three CLI processes; the limit bounds the run, nothing waits on time.
  it(
    "serves RPC, carries the request's traceId into plugin logs, and answers the remote CLI",
    { timeout: 30_000 },
    async () => {
      const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-remote-"));
      Fs.mkdirSync(Path.join(home, ".jhin"));
      Fs.writeFileSync(Path.join(home, ".jhin", "config.jsonc"), '{ "jhin.http": { "port": 0 } }');
      const url = await startServe(home);
      const token = readToken(home);

      const client = createRpcClient({ connect: () => connectWebSocket(url, token) });
      const result = await client.call("example.greet", { name: "Ada" }, { trace: "trace-e2e-1" });
      client.close();
      expect(result).toEqual({ message: "Hello, Ada!", count: 1 });

      const lines = Fs.readFileSync(Path.join(home, "logs", "node.log"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toContainEqual(
        expect.objectContaining({ msg: "greeted", plugin: "jhin.example", traceId: "trace-e2e-1" }),
      );

      // The CLI reads the token from the same home and talks to the running node.
      const remote = jhin("example.greet", "--name", "Bo", "--url", url, "--home", home);
      expect(remote.status).toBe(0);
      expect(JSON.parse(remote.stdout)).toEqual({ message: "Hello, Bo!", count: 2 });
      const inspection = JSON.parse(jhin("inspect", "--url", url, "--home", home).stdout);
      expect(inspection.nodeId).toBe(Fs.readFileSync(Path.join(home, "node-id"), "utf8").trim());

      const refused = jhin("example.greet", "--name", "Eve", "--url", url, "--token", "wrong");
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("UNAUTHENTICATED");
    },
  );
});
