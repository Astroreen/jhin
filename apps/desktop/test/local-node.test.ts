import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { cliEntry, startLocalNode } from "../src/local-node.ts";

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
