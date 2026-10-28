import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { SERVE_READY, SERVE_STOP, type ServeReady } from "@jhin/node-host/running";
import { describe, expect, it } from "vite-plus/test";

const BIN = Path.resolve(import.meta.dirname, "../bin/jhin.js");

describe("jhin serve with an IPC channel (desktop.md D1687, D1688)", () => {
  // Boots the whole distribution once; the limit bounds the run, nothing waits on time.
  it(
    "says it is ready with its endpoints, and stops on the stop message",
    { timeout: 60_000 },
    async () => {
      const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-serve-ipc-"));
      Fs.mkdirSync(Path.join(home, ".jhin"));
      Fs.writeFileSync(Path.join(home, ".jhin", "config.jsonc"), '{ "jhin.http": { "port": 0 } }');
      const serve = ChildProcess.spawn(
        process.execPath,
        [BIN, "serve", "--home", home, "--cwd", home],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      let stderr = "";
      serve.stderr!.on("data", (chunk) => (stderr += String(chunk)));
      const exited = new Promise<number | null>((resolve) => serve.once("exit", resolve));
      const ready = await new Promise<ServeReady>((resolve, reject) => {
        serve.on("message", (message) => {
          if ((message as { type?: unknown }).type === SERVE_READY) resolve(message as ServeReady);
        });
        serve.once("exit", (code) => reject(new Error(`exited with ${code}:\n${stderr}`)));
      });
      expect(ready).toMatchObject({
        type: SERVE_READY,
        nodeId: Fs.readFileSync(Path.join(home, "node-id"), "utf8").trim(),
        rpc: expect.stringMatching(/^ws:\/\/.+\/rpc$/),
        logs: expect.stringContaining(home),
        problems: [],
      });
      // The lines say the same for people reading them.
      expect(stderr).toContain(`rpc: ${ready.rpc}\n`);
      expect(ready.ui).toBeUndefined();

      serve.send({ type: SERVE_STOP });
      expect(await exited).toBe(0);
    },
  );
});
