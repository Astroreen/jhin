import * as Fs from "node:fs";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { HostProcess, tempDir, writePlugin } from "./support/harness.ts";

const EXAMPLE = Path.resolve(import.meta.dirname, "../../../plugins/example");

const counterIndex = `
import { definePlugin, z } from "@jhin/sdk";
import { label } from "./lib.ts";

export default definePlugin({
  activate(context) {
    context.services.provide("acme.count", { label });
    context.commands.register({
      name: "acme.counter.bump",
      description: "Counts calls",
      input: z.object({}),
      output: z.object({ label: z.string(), count: z.number() }),
      handler: () => {
        const count = (context.state.get<number>("count") ?? 0) + 1;
        context.state.set("count", count);
        return { label, count };
      },
    });
  },
});
`;

const viewIndex = `
import { definePlugin, z } from "@jhin/sdk";

export default definePlugin({
  activate(context) {
    const counter = context.services.get<{ label: string }>("acme.count");
    context.commands.register({
      name: "acme.view.show",
      description: "Shows the counter label",
      input: z.object({}),
      output: z.string(),
      handler: () => "view:" + counter.label,
    });
  },
});
`;

let host: HostProcess | undefined;
afterEach(async () => {
  await host?.stop();
  host = undefined;
});

describe("node host", () => {
  it("hot reloads a user plugin, the files it imports and its dependants, keeping state", async () => {
    const home = tempDir("home");
    const counter = writePlugin(
      Path.join(home, "plugins", "counter"),
      { id: "acme.counter", provides: { "acme.count": "1.0.0" } },
      { "index.ts": counterIndex, "lib.ts": 'export const label = "v1";\n' },
    );
    writePlugin(
      Path.join(home, "plugins", "view"),
      { id: "acme.view", requires: { "acme.count": "^1" } },
      { "index.ts": viewIndex },
    );
    host = new HostProcess({ home, cwd: tempDir("cwd"), watch: true });
    await host.ready();

    expect((await host.execute("acme.counter.bump")).value).toEqual({ label: "v1", count: 1 });
    expect((await host.execute("acme.view.show")).value).toBe("view:v1");

    const reloaded = host.next(
      (message) =>
        message.type === "event" && (message["event"] as any).type === "kernel.plugin.reloaded",
    );
    Fs.writeFileSync(Path.join(counter, "lib.ts"), 'export const label = "v2";\n');
    const event = (await reloaded)["event"] as { payload: { plugin: string; affected: string[] } };

    expect(event.payload).toEqual({
      plugin: "acme.counter",
      affected: ["acme.counter", "acme.view"],
    });
    expect((await host.execute("acme.counter.bump")).value).toEqual({ label: "v2", count: 2 });
    expect((await host.execute("acme.view.show")).value).toBe("view:v2");
  });

  it("lets a user plugin replace a distribution plugin with the same id", async () => {
    const home = tempDir("home");
    const custom = writePlugin(
      Path.join(home, "plugins", "my-example"),
      { id: "jhin.example" },
      {
        "index.ts": `
import { definePlugin, z } from "@jhin/sdk";
export default definePlugin({
  activate(context) {
    context.commands.register({
      name: "example.greet",
      description: "My own greeting",
      input: z.object({ name: z.string() }),
      output: z.object({ message: z.string(), count: z.number() }),
      handler: ({ name }) => ({ message: "Yo " + name, count: 0 }),
    });
  },
});
`,
      },
    );
    host = new HostProcess({ home, cwd: tempDir("cwd"), distribution: [EXAMPLE] });
    const { inspection } = await host.ready();

    const example = inspection.kernel.plugins.find(
      (plugin: { id: string }) => plugin.id === "jhin.example",
    );
    expect(example).toMatchObject({ status: "active", location: custom });
    expect(inspection.shadowed).toEqual([
      { id: "jhin.example", location: EXAMPLE, layer: "distribution", shadowedBy: custom },
    ]);
    expect((await host.execute("example.greet", { name: "Ada" })).value).toEqual({
      message: "Yo Ada",
      count: 0,
    });
  });

  it("reloads a plugin through the host.plugins.reload command", async () => {
    host = new HostProcess({ home: tempDir("home"), cwd: tempDir("cwd"), distribution: [EXAMPLE] });
    await host.ready();
    await host.execute("example.greet", { name: "Ada" });

    const result = await host.execute("host.plugins.reload", { plugin: "jhin.example" });

    expect(result.value).toEqual({ plugin: "jhin.example" });
    // State survived the reload: the counter continues.
    expect((await host.execute("example.greet", { name: "Ada" })).value).toEqual({
      message: "Hello, Ada!",
      count: 2,
    });
  });

  it("applies node config file changes while watching", async () => {
    const home = tempDir("home");
    Fs.mkdirSync(home, { recursive: true });
    Fs.writeFileSync(
      Path.join(home, "config.jsonc"),
      '{ "jhin.example": { "greeting": "Hello" } }',
    );
    host = new HostProcess({ home, cwd: tempDir("cwd"), distribution: [EXAMPLE], watch: true });
    await host.ready();

    const changed = host.next(
      (message) =>
        message.type === "event" && (message["event"] as any).type === "kernel.config.changed",
    );
    Fs.writeFileSync(
      Path.join(home, "config.jsonc"),
      '{\n  // friendlier\n  "jhin.example": { "greeting": "Hi", },\n}',
    );
    await changed;

    expect((await host.execute("example.greet", { name: "Ada" })).value).toEqual({
      message: "Hi, Ada!",
      count: 1,
    });
  });

  it("keeps the previous config when the file becomes invalid, and survives atomic saves", async () => {
    const home = tempDir("home");
    const config = Path.join(home, "config.jsonc");
    host = new HostProcess({ home, cwd: tempDir("cwd"), distribution: [EXAMPLE], watch: true });
    await host.ready();
    const isEvent = (type: string) => (message: { type: string; [key: string]: unknown }) =>
      message.type === "event" && (message["event"] as { type: string }).type === type;

    // The file did not exist when the watch started.
    let changed = host.next(isEvent("kernel.config.changed"));
    Fs.writeFileSync(config, '{ "jhin.example": { "greeting": "Hi" } }');
    await changed;
    expect((await host.execute("example.greet", { name: "A" })).value.message).toBe("Hi, A!");

    const rejected = host.next(isEvent("host.config.rejected"));
    Fs.writeFileSync(config, '{ "jhin.example": { "greeting": ');
    await rejected;
    expect((await host.execute("example.greet", { name: "A" })).value.message).toBe("Hi, A!");

    // Editors often save by renaming a temporary file over the original.
    changed = host.next(isEvent("kernel.config.changed"));
    Fs.writeFileSync(`${config}.tmp`, '{ "jhin.example": { "greeting": "Hey" } }');
    Fs.renameSync(`${config}.tmp`, config);
    await changed;
    expect((await host.execute("example.greet", { name: "A" })).value.message).toBe("Hey, A!");
  });

  it("gives plugins data directories only under <home>/data, by plugin id", async () => {
    const home = tempDir("home");
    writePlugin(
      Path.join(home, "plugins", "paths"),
      { id: "acme.paths", requires: { "host.paths": "^1" } },
      {
        "index.ts": `
import { definePlugin, z } from "@jhin/sdk";
export default definePlugin({
  activate(context) {
    const paths = context.services.get<{ dataDir(plugin: string): string }>("host.paths");
    context.commands.register({
      name: "acme.paths.try",
      description: "Asks for a data directory",
      input: z.object({ plugin: z.string() }),
      output: z.object({ dir: z.string().optional(), error: z.string().optional() }),
      handler: ({ plugin }) => {
        try {
          return { dir: paths.dataDir(plugin) };
        } catch (error) {
          return { error: String(error) };
        }
      },
    });
  },
});
`,
      },
    );
    host = new HostProcess({ home, cwd: tempDir("cwd") });
    await host.ready();

    expect((await host.execute("acme.paths.try", { plugin: "acme.paths" })).value).toEqual({
      dir: Path.join(home, "data", "acme.paths"),
    });
    for (const plugin of ["../escape", "a/b", "/abs", ""]) {
      expect((await host.execute("acme.paths.try", { plugin })).value.error).toContain(
        "needs a plugin id",
      );
    }
    expect(Fs.existsSync(Path.join(home, "escape"))).toBe(false);
  });

  it("patches config keeping comments, refuses older changes, and survives a damaged record of write times", async () => {
    const home = tempDir("home");
    Fs.writeFileSync(
      Path.join(home, "config.jsonc"),
      '{\n  // mine\n  "jhin.example": { "greeting": "Hello" }\n}\n',
    );
    Fs.writeFileSync(Path.join(home, "config-writes.json"), "{ damaged");
    host = new HostProcess({ home, cwd: tempDir("cwd"), distribution: [EXAMPLE] });
    await host.ready();

    const now = Date.now();
    const applied = await host.execute("host.config.patch", {
      layer: "node",
      section: "jhin.example",
      values: { greeting: "Hey" },
      at: now,
    });
    expect(applied.value).toEqual({ applied: true, at: now });
    expect(Fs.readFileSync(Path.join(home, "config.jsonc"), "utf8")).toContain("// mine");
    expect((await host.execute("example.greet", { name: "A" })).value.message).toBe("Hey, A!");

    const stale = await host.execute("host.config.patch", {
      layer: "node",
      section: "jhin.example",
      values: { greeting: "Old" },
      at: now - 1000,
    });
    expect(stale.value).toEqual({ applied: false, at: now - 1000, conflict: { localAt: now } });
  });
});
