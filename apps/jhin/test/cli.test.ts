import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vite-plus/test";

const BIN = Path.resolve(import.meta.dirname, "../bin/jhin.js");

function jhin(home: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = ChildProcess.spawnSync(
    process.execPath,
    [BIN, ...args, "--home", home, "--cwd", home],
    {
      encoding: "utf8",
    },
  );
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function homeWith(
  plugins: Record<string, { manifest: Record<string, unknown>; index: string }>,
): string {
  const home = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-cli-"));
  for (const [dir, plugin] of Object.entries(plugins)) {
    const root = Path.join(home, "plugins", dir);
    Fs.mkdirSync(root, { recursive: true });
    Fs.writeFileSync(
      Path.join(root, "package.json"),
      JSON.stringify({
        type: "module",
        jhin: {
          version: "1.0.0",
          apiVersion: 1,
          side: "server",
          entry: "index.ts",
          ...plugin.manifest,
        },
      }),
    );
    Fs.writeFileSync(Path.join(root, "index.ts"), plugin.index);
  }
  return home;
}

describe("jhin CLI", () => {
  it("inspect prints plugins, services, commands, hooks and an activation error", () => {
    const home = homeWith({
      broken: {
        manifest: { id: "acme.broken" },
        index: `import { definePlugin } from "@jhin/sdk";\nexport default definePlugin({ activate() { throw new Error("config missing"); } });\n`,
      },
      shout: {
        manifest: { id: "acme.shout" },
        index: `import { definePlugin } from "@jhin/sdk";
export default definePlugin({
  activate(context) {
    context.hooks.after("example.greet", (output) => ({ ...output, message: output.message.toUpperCase() }));
  },
});
`,
      },
    });

    const result = jhin(home, "inspect");

    expect(result.status).toBe(0);
    const inspection = JSON.parse(result.stdout);
    const broken = inspection.kernel.plugins.find(
      (plugin: { id: string }) => plugin.id === "acme.broken",
    );
    expect(broken).toMatchObject({ status: "failed", error: { code: "ACTIVATION_FAILED" } });
    expect(broken.error.message).toContain("config missing");
    expect(inspection.kernel.services).toContainEqual({
      capability: "example.greeter",
      plugin: "jhin.example",
    });
    expect(inspection.kernel.hooks).toContainEqual({
      name: "example.greet",
      before: 0,
      around: 0,
      after: 1,
    });
    expect(inspection.kernel.commands.map((command: { name: string }) => command.name)).toEqual(
      expect.arrayContaining(["example.greet", "host.inspect", "host.plugins.reload"]),
    );
    expect(inspection.recentEvents).toContainEqual({
      type: "kernel.plugin.failed",
      payload: expect.objectContaining({ plugin: "acme.broken" }),
    });

    // The hook from the user plugin applies when the command runs.
    const greet = jhin(home, "example.greet", "--name", "Ada");
    expect(JSON.parse(greet.stdout)).toEqual({ message: "HELLO, ADA!", count: 1 });
  });

  it("writes JSON logs with nodeId and plugin fields", () => {
    const home = homeWith({});

    jhin(home, "inspect");

    const nodeId = Fs.readFileSync(Path.join(home, "node-id"), "utf8").trim();
    const lines = Fs.readFileSync(Path.join(home, "logs", "node.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.nodeId === nodeId)).toBe(true);
    expect(lines).toContainEqual(
      expect.objectContaining({ plugin: "jhin.example", msg: "plugin activated" }),
    );
  });

  it("runs commands with flags or JSON input and reports validation errors", () => {
    const home = homeWith({});

    expect(JSON.parse(jhin(home, "example.greet", "--name=Ada").stdout)).toEqual({
      message: "Hello, Ada!",
      count: 1,
    });
    expect(JSON.parse(jhin(home, "example.greet", "--input", '{"name":"Bo"}').stdout)).toEqual({
      message: "Hello, Bo!",
      count: 1,
    });

    const invalid = jhin(home, "example.greet");
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stderr).error.code).toBe("COMMAND_INPUT_INVALID");

    // A string property keeps a numeric-looking value as a string.
    expect(JSON.parse(jhin(home, "example.greet", "--name", "42").stdout).message).toBe(
      "Hello, 42!",
    );

    const badJson = jhin(home, "example.greet", "--input", "{nope");
    expect(badJson.status).toBe(2);
    expect(badJson.stderr).toContain("--input is not valid JSON");

    const unknown = jhin(home, "nope.command");
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("example.greet");
  });
});
