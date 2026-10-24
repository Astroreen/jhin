import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { parseConfigText } from "@jhin/kernel";
import { MACHINE_KINDS } from "@jhin/host-api";

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

/** The payload of the next `kernel.plugins.updated` event that matches. */
async function pluginsUpdated(host: HostProcess, match: (payload: any) => boolean): Promise<any> {
  const message = await host.next(
    (candidate) =>
      candidate.type === "event" &&
      (candidate["event"] as any).type === "kernel.plugins.updated" &&
      match((candidate["event"] as any).payload),
  );
  return (message["event"] as any).payload;
}

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

  it("follows build output once a plugin's entry switches from source to dist/", async () => {
    const home = tempDir("home");
    const labelPlugin = (label: string) => `
import { definePlugin, z } from "@jhin/sdk";
export default definePlugin({
  activate(context) {
    context.commands.register({
      name: "acme.built.label",
      description: "Where the code runs from",
      input: z.object({}),
      output: z.string(),
      handler: () => "${label}",
    });
  },
});
`;
    const root = writePlugin(
      Path.join(home, "plugins", "built"),
      { id: "acme.built" },
      { "index.ts": labelPlugin("source"), "dist/index.js": labelPlugin("dist-1") },
    );
    host = new HostProcess({ home, cwd: tempDir("cwd"), watch: true });
    await host.ready();
    expect((await host.execute("acme.built.label")).value).toBe("source");

    const manifest = Path.join(root, "package.json");
    const packageJson = JSON.parse(Fs.readFileSync(manifest, "utf8"));
    const update = pluginsUpdated(host, (payload) => payload.changed.includes("acme.built"));
    packageJson.jhin.entry = "dist/index.js";
    Fs.writeFileSync(manifest, JSON.stringify(packageJson));
    await update;
    expect((await host.execute("acme.built.label")).value).toBe("dist-1");

    // A rebuild of dist/ now reloads the plugin: its watcher follows the new entry.
    const reloaded = host.next(
      (message) =>
        message.type === "event" &&
        (message["event"] as any).type === "kernel.plugin.reloaded" &&
        (message["event"] as any).payload.plugin === "acme.built",
    );
    Fs.writeFileSync(Path.join(root, "dist", "index.js"), labelPlugin("dist-2"));
    await reloaded;
    expect((await host.execute("acme.built.label")).value).toBe("dist-2");
  });

  it("re-resolves the plugin graph when a manifest changes on disk, leaving unrelated plugins running", async () => {
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
    host = new HostProcess({ home, cwd: tempDir("cwd"), distribution: [EXAMPLE], watch: true });
    await host.ready();
    expect((await host.execute("acme.counter.bump")).value).toEqual({ label: "v1", count: 1 });
    const manifest = Path.join(counter, "package.json");
    const packageJson = JSON.parse(Fs.readFileSync(manifest, "utf8"));
    const pluginsById = async () =>
      Object.fromEntries(
        (await host!.execute("host.inspect")).value.kernel.plugins.map((plugin: any) => [
          plugin.id,
          plugin,
        ]),
      );

    // A breaking version: the dependant blocks, everything else keeps running.
    let update = pluginsUpdated(host, (payload) => payload.changed.includes("acme.counter"));
    packageJson.jhin.provides["acme.count"] = "2.0.0";
    Fs.writeFileSync(manifest, JSON.stringify(packageJson));
    expect(await update).toEqual({
      added: [],
      removed: [],
      changed: ["acme.counter"],
      stopped: ["acme.view", "acme.counter"],
      started: ["acme.counter"],
      invalid: [],
    });
    let plugins = await pluginsById();
    expect(plugins["acme.view"]).toMatchObject({
      status: "blocked",
      error: { code: "VERSION_MISMATCH" },
    });
    expect(plugins["acme.counter"].provides).toEqual({ "acme.count": "2.0.0" });
    expect(plugins["jhin.example"].status).toBe("active");
    // Scoped state survives the restart.
    expect((await host.execute("acme.counter.bump")).value).toEqual({ label: "v1", count: 2 });

    // An invalid manifest is shown and the plugin keeps its previous one.
    update = pluginsUpdated(host, (payload) => payload.invalid.length > 0);
    Fs.writeFileSync(manifest, '{ "jhin": { "id": ');
    expect(await update).toMatchObject({ changed: [], stopped: [] });
    const inspection = (await host.execute("host.inspect")).value;
    expect(inspection.kernel.invalid).toEqual([
      {
        location: counter,
        error: expect.objectContaining({
          code: "MANIFEST_INVALID",
          details: expect.objectContaining({ kept: "acme.counter" }),
        }),
      },
    ]);
    expect((await host.execute("acme.counter.bump")).value).toEqual({ label: "v1", count: 3 });

    // Fixing it brings the dependant back.
    update = pluginsUpdated(host, (payload) => payload.changed.includes("acme.counter"));
    packageJson.jhin.provides["acme.count"] = "1.1.0";
    Fs.writeFileSync(manifest, JSON.stringify(packageJson));
    expect(await update).toMatchObject({
      started: ["acme.counter", "acme.view"],
      invalid: [],
    });
    plugins = await pluginsById();
    expect(plugins["acme.view"].status).toBe("active");
    expect((await host.execute("acme.view.show")).value).toBe("view:v1");
  });

  it("activates plugins added to a plugin directory and stops removed ones while watching", async () => {
    const home = tempDir("home");
    host = new HostProcess({ home, cwd: tempDir("cwd"), distribution: [EXAMPLE], watch: true });
    await host.ready();

    // Moved in whole, the way a package manager or an editor's "move" ends up.
    const staged = writePlugin(
      Path.join(tempDir("staging"), "counter"),
      { id: "acme.counter", provides: { "acme.count": "1.0.0" } },
      { "index.ts": counterIndex, "lib.ts": 'export const label = "new";\n' },
    );
    const installed = Path.join(home, "plugins", "counter");
    let update = pluginsUpdated(host, (payload) => payload.added.includes("acme.counter"));
    Fs.renameSync(staged, installed);
    expect(await update).toMatchObject({ added: ["acme.counter"], started: ["acme.counter"] });
    expect((await host.execute("acme.counter.bump")).value).toEqual({ label: "new", count: 1 });

    update = pluginsUpdated(host, (payload) => payload.removed.includes("acme.counter"));
    Fs.rmSync(installed, { recursive: true });
    expect(await update).toMatchObject({ removed: ["acme.counter"], stopped: ["acme.counter"] });
    expect((await host.execute("acme.counter.bump")).error).toMatchObject({
      code: "COMMAND_NOT_FOUND",
    });
    expect((await host.execute("example.greet", { name: "Ada" })).value.message).toBe(
      "Hello, Ada!",
    );
  });

  it("tells host.plugins listeners once about a manifest saved together with code", async () => {
    const home = tempDir("home");
    writePlugin(
      Path.join(home, "plugins", "listener"),
      { id: "acme.listener", requires: { "host.plugins": "^1" } },
      {
        "index.ts": `
import { definePlugin, z } from "@jhin/sdk";
export default definePlugin({
  activate(context) {
    const seen: string[] = [];
    const plugins = context.services.get<any>("host.plugins");
    context.subscriptions.add(plugins.onChange(({ id }: { id: string }) => seen.push(id)));
    context.commands.register({
      name: "acme.listener.seen",
      description: "Plugin changes seen so far",
      input: z.object({}),
      output: z.array(z.string()),
      handler: () => seen,
    });
  },
});
`,
      },
    );
    const client = writePlugin(
      Path.join(home, "plugins", "client"),
      { id: "acme.client", side: "client", entry: "index.js" },
      { "index.js": "export default {};\n" },
    );
    host = new HostProcess({ home, cwd: tempDir("cwd"), watch: true });
    await host.ready();

    const update = pluginsUpdated(host, (payload) => payload.changed.includes("acme.client"));
    const manifest = Path.join(client, "package.json");
    const packageJson = JSON.parse(Fs.readFileSync(manifest, "utf8"));
    packageJson.jhin.version = "1.1.0";
    Fs.writeFileSync(manifest, JSON.stringify(packageJson));
    Fs.writeFileSync(Path.join(client, "index.js"), "export default { changed: true };\n");
    await update;

    expect((await host.execute("acme.listener.seen")).value).toEqual(["acme.client"]);
  });

  it("applies plugins added or changed on disk through the host.plugins.rescan command", async () => {
    const cwd = tempDir("cwd");
    host = new HostProcess({ home: tempDir("home"), cwd, distribution: [EXAMPLE] });
    await host.ready();

    // A workspace copy with the same id overrides the distribution plugin (D15).
    const custom = writePlugin(
      Path.join(cwd, ".jhin", "plugins", "my-example"),
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
    const result = await host.execute("host.plugins.rescan");

    expect(result.value).toEqual({
      added: [],
      removed: [],
      changed: ["jhin.example"],
      stopped: ["jhin.example"],
      started: ["jhin.example"],
      invalid: [],
    });
    expect((await host.execute("host.inspect")).value.shadowed).toEqual([
      { id: "jhin.example", location: EXAMPLE, layer: "distribution", shadowedBy: custom },
    ]);
    expect((await host.execute("example.greet", { name: "Ada" })).value.message).toBe("Yo Ada");

    // Without the workspace copy, the distribution plugin comes back.
    Fs.rmSync(custom, { recursive: true });
    expect((await host.execute("host.plugins.rescan")).value).toMatchObject({
      changed: ["jhin.example"],
      started: ["jhin.example"],
    });
    expect((await host.execute("host.inspect")).value.shadowed).toEqual([]);
    expect((await host.execute("example.greet", { name: "Ada" })).value.message).toBe(
      "Hello, Ada!",
    );
  });

  it("tells host.plugins listeners about added, swapped and removed client plugins by their package.json", async () => {
    const home = tempDir("home");
    writePlugin(
      Path.join(home, "plugins", "spy"),
      { id: "acme.spy", requires: { "host.plugins": "^1" } },
      {
        "index.ts": `
import { definePlugin, z } from "@jhin/sdk";
export default definePlugin({
  activate(context) {
    const changes: unknown[] = [];
    context.subscriptions.add(context.services.get<any>("host.plugins").onChange((change: unknown) => changes.push(change)));
    context.commands.register({
      name: "acme.spy.changes",
      description: "host.plugins changes seen so far, then forgets them",
      input: z.object({}),
      output: z.unknown(),
      handler: () => changes.splice(0),
    });
  },
});
`,
      },
    );
    host = new HostProcess({ home, cwd: tempDir("cwd") });
    await host.ready();
    const client = (dir: string) =>
      writePlugin(
        Path.join(home, "plugins", dir),
        { id: "acme.client", side: "client", entry: "index.js" },
        { "index.js": "export default {};\n" },
      );

    const first = client("client-a");
    await host.execute("host.plugins.rescan");
    expect((await host.execute("acme.spy.changes")).value).toEqual([
      { id: "acme.client", files: [Path.join(first, "package.json")] },
    ]);

    // Another folder with the same id, swapped in within one rescan: a change, at the new place.
    Fs.rmSync(first, { recursive: true });
    const second = client("client-b");
    await host.execute("host.plugins.rescan");
    expect((await host.execute("acme.spy.changes")).value).toEqual([
      { id: "acme.client", files: [Path.join(second, "package.json")] },
    ]);

    // Removed: reported with the manifest it had.
    Fs.rmSync(second, { recursive: true });
    await host.execute("host.plugins.rescan");
    expect((await host.execute("acme.spy.changes")).value).toEqual([
      { id: "acme.client", files: [Path.join(second, "package.json")] },
    ]);
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

  it("says which sections a config file change touched (D483)", async () => {
    const home = tempDir("home");
    const file = Path.join(home, "config.jsonc");
    Fs.writeFileSync(file, "{ not json");
    host = new HostProcess({ home, cwd: tempDir("cwd"), distribution: [EXAMPLE], watch: true });
    await host.ready();
    const next = () =>
      host!.next(
        (message) =>
          message.type === "event" && (message["event"] as any).type === "host.config.changed",
      );

    // Refused at start, then fixed: a change from the empty layer in effect.
    let changed = next();
    Fs.writeFileSync(file, '{ "jhin.example": { "greeting": "Hi", "extra": 1 } }');
    expect((await changed)["event"]).toMatchObject({
      payload: { layer: "node", sections: ["jhin.example"] },
    });

    // Keys that only moved are no change; the next event is the real one.
    changed = next();
    const applied = host.next(
      (message) =>
        message.type === "event" && (message["event"] as any).type === "kernel.config.changed",
    );
    Fs.writeFileSync(file, '{ "jhin.example": { "extra": 1, "greeting": "Hi" } }');
    // Applied on its own before the next write, so it is not folded into it.
    await applied;
    Fs.writeFileSync(
      file,
      '{ "jhin.example": { "extra": 1, "greeting": "Hi" }, "jhin.host": { "machine": "laptop" } }',
    );
    expect((await changed)["event"]).toMatchObject({
      payload: { layer: "node", sections: ["jhin.host"] },
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

  it("never returns secrets from host.config.get, and keeps them when the marker comes back (security.md D417)", async () => {
    const home = tempDir("home");
    writePlugin(
      Path.join(home, "plugins", "vault"),
      { id: "acme.vault" },
      {
        "index.ts": `
import { definePlugin, z } from "@jhin/sdk";
export default definePlugin({
  activate(context) {
    context.config.define(
      "acme.vault",
      z.object({
        user: z.string().optional(),
        key: z.string().optional().meta({ writeOnly: true }),
        pin: z.number().meta({ writeOnly: true }).nullable().optional(),
        env: z.record(z.string(), z.string().meta({ writeOnly: true })).optional(),
        keys: z.array(z.string().meta({ writeOnly: true })).optional(),
        project: z.string().optional().meta({ writeOnly: true }),
      }),
    );
    context.config.define(
      "acme.strict",
      z.object({
        token: z
          .string()
          .meta({ writeOnly: true })
          .superRefine((value, ctx) => ctx.addIssue({ code: "custom", message: "refused " + value })),
      }),
    );
  },
});
`,
      },
    );
    Fs.writeFileSync(
      Path.join(home, "config.jsonc"),
      '{ "acme.vault": { "user": "me", "key": "s3cret", "pin": 1234, "env": { "A": "a-value" }, "keys": ["k-one", "k-two"] }, "acme.strict": { "token": "xyz" }, "acme.gone": { "password": "gone-secret" } }\n',
    );
    const cwd = tempDir("cwd");
    Fs.mkdirSync(Path.join(cwd, ".jhin"));
    Fs.writeFileSync(
      Path.join(cwd, ".jhin", "config.jsonc"),
      '{ "acme.vault": { "project": "project-secret" } }\n',
    );
    host = new HostProcess({ home, cwd });
    await host.ready();

    const hidden = {
      user: "me",
      key: "••••••",
      pin: "••••••",
      env: { A: "••••••" },
      // Inside a list, a marker names its secret's place.
      keys: ["••••••#/keys/0", "••••••#/keys/1"],
    };
    const read = await host.execute("host.config.get", { section: "acme.vault" });
    expect(read.value).toMatchObject({
      value: { ...hidden, project: "••••••" },
      layers: { node: hidden, project: { project: "••••••" } },
    });
    expect(JSON.stringify(read.value)).not.toMatch(
      /s3cret|1234|a-value|k-one|k-two|project-secret/,
    );
    // A section no plugin defines shows no value in clear.
    const gone = await host.execute("host.config.get", { section: "acme.gone" });
    expect(gone.value.layers.node).toEqual({ password: "••••••" });
    // A refinement quoting the value it refused does not leak it.
    const strict = await host.execute("host.config.get", { section: "acme.strict" });
    expect(strict.value.error).toEqual(expect.any(String));
    // Even a secret too short to scrub ("xyz") is not quoted: its issue says so instead.
    expect(JSON.stringify(strict.value)).not.toContain("xyz");
    expect(strict.value.issues).toEqual([
      { path: "token", message: "Not valid (a secret, so its message is not shown)" },
    ]);

    // The form sends a whole top-level key back: the markers keep what is stored.
    const saved = await host.execute("host.config.patch", {
      layer: "node",
      section: "acme.vault",
      values: {
        key: "••••••",
        pin: "••••••",
        env: { A: "••••••", B: "b-value" },
        // The second secret moved first and kept, the first replaced.
        keys: ["••••••#/keys/1", "k-three"],
      },
    });
    expect(saved.value).toMatchObject({ applied: true });
    const file = Fs.readFileSync(Path.join(home, "config.jsonc"), "utf8");
    expect(file).toContain('"s3cret"');
    expect(file).toContain('"a-value"');
    expect(file).toContain('"b-value"');
    expect(file).not.toContain("••••••");
    expect(file).toContain("1234");
    expect(file).toMatch(/"k-two",\s*"k-three"/);
    expect(file).not.toContain('"k-one"');

    // A secret only the project file sets is never copied into the node file.
    const project = await host.execute("host.config.patch", {
      layer: "node",
      section: "acme.vault",
      values: { project: "••••••", user: "you" },
    });
    expect(project.value).toMatchObject({ applied: true });
    const after = Fs.readFileSync(Path.join(home, "config.jsonc"), "utf8");
    expect(after).toContain('"you"');
    expect(after).not.toContain("project-secret");

    // A marker where nothing is stored is refused.
    const missing = await host.execute("host.config.patch", {
      layer: "node",
      section: "acme.vault",
      values: { env: { C: "••••••" } },
    });
    expect(missing.error).toMatchObject({ code: "CONFIG_SECRET_MISSING" });
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

    const future = await host.execute("host.config.patch", {
      layer: "node",
      section: "jhin.example",
      values: { greeting: "From the future" },
      at: Date.now() + 2 * 60 * 60 * 1000,
    });
    expect(future.error).toMatchObject({ code: "CONFIG_TIME_IN_FUTURE" });
  });

  it("puts the launcher's settings under the config files (desktop.md D1487)", async () => {
    const home = tempDir("home");
    host = new HostProcess({
      home,
      cwd: tempDir("cwd"),
      distribution: [EXAMPLE],
      config: { "jhin.example": { greeting: "Hi" } },
    });
    await host.ready();
    expect(
      (await host.execute("host.config.get", { section: "jhin.example" })).value.value,
    ).toEqual({ greeting: "Hi" });
    await host.execute("host.config.patch", {
      layer: "node",
      section: "jhin.example",
      values: { greeting: "Hello there" },
    });
    expect(
      (await host.execute("host.config.get", { section: "jhin.example" })).value.value,
    ).toEqual({ greeting: "Hello there" });
  });

  it("reads a config section with what each file sets, and the schema of every section", async () => {
    const home = tempDir("home");
    const cwd = tempDir("cwd");
    Fs.writeFileSync(
      Path.join(home, "config.jsonc"),
      '{\n  // Mine.\n  "jhin.example": {\n    // Said first.\n    "greeting": "Hello"\n  }\n}\n',
    );
    Fs.mkdirSync(Path.join(cwd, ".jhin"));
    Fs.writeFileSync(
      Path.join(cwd, ".jhin", "config.jsonc"),
      '{\n  "jhin.example": {\n    // Not read: the node file has one.\n    "greeting": "Howdy"\n  }\n}\n',
    );
    host = new HostProcess({ home, cwd, distribution: [EXAMPLE] });
    await host.ready();

    const read = await host.execute("host.config.get", { section: "jhin.example" });
    expect(read.value).toEqual({
      value: { greeting: "Howdy" },
      layers: { node: { greeting: "Hello" }, project: { greeting: "Howdy" } },
      // The node file's comment above a key wins over the project file's.
      comments: [
        { path: [], text: "Mine." },
        { path: ["greeting"], text: "Said first." },
      ],
    });
    // A section no plugin defines has no value, and says why.
    const unknown = await host.execute("host.config.get", { section: "acme.none" });
    expect(unknown.value.value).toBeUndefined();
    expect(unknown.value.error).toEqual(expect.any(String));
    expect(unknown.value.error).not.toMatch(/is invalid/);

    // A value the schema refuses says where.
    await host.execute("host.config.patch", {
      layer: "project",
      section: "jhin.example",
      values: { greeting: 1 },
    });
    const invalid = await host.execute("host.config.get", { section: "jhin.example" });
    expect(invalid.value.value).toBeUndefined();
    expect(invalid.value.issues).toEqual([{ path: "greeting", message: expect.any(String) }]);

    const schema = await host.execute("host.config.schema", {});
    // Titles and descriptions come with the schema (D81).
    expect(schema.value.properties["jhin.example"]).toMatchObject({
      title: "Example",
      properties: { greeting: { title: "Greeting", default: "Hello" } },
    });
  });

  it("removes the keys a patch unsets, keeping the file's comments", async () => {
    const home = tempDir("home");
    const config = Path.join(home, "config.jsonc");
    Fs.writeFileSync(
      config,
      '{\n  // mine\n  "jhin.example": {\n    // the greeting\n    "greeting": "Hey"\n  }\n}\n',
    );
    host = new HostProcess({ home, cwd: tempDir("cwd"), distribution: [EXAMPLE] });
    await host.ready();
    expect((await host.execute("example.greet", { name: "A" })).value.message).toBe("Hey, A!");

    const reset = await host.execute("host.config.patch", {
      layer: "node",
      section: "jhin.example",
      values: {},
      unset: ["greeting", "absent"],
    });
    expect(reset.value.applied).toBe(true);
    const text = Fs.readFileSync(config, "utf8");
    expect(text).toContain("// mine");
    expect(text).not.toContain('"greeting"');
    // Back to the schema's default.
    expect((await host.execute("example.greet", { name: "A" })).value.message).toBe("Hello, A!");
  });
  it("edits leaf paths, keeping the comments inside a changed key (D476)", async () => {
    const home = tempDir("home");
    const config = Path.join(home, "config.jsonc");
    Fs.writeFileSync(
      config,
      [
        "{",
        '  "jhin.example": {',
        "    // the greeting",
        '    "greeting": "Hey",',
        '    "nested": {',
        "      // kept: a sibling changes",
        '      "a": 1,',
        '      "b": 2',
        "    },",
        '    "flat": "x"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    host = new HostProcess({ home, cwd: tempDir("cwd"), distribution: [EXAMPLE] });
    await host.ready();

    const edited = await host.execute("host.config.edit", {
      layer: "node",
      section: "jhin.example",
      edits: [
        { path: ["nested", "b"], value: 3 },
        { path: ["nested", "c"], value: [1, 2] },
        // Below a value that is no object: the value becomes one.
        { path: ["flat", "deep"], value: true },
        // Not in the file: nothing to remove, and done.
        { path: ["absent"] },
        { path: ["greeting"] },
      ],
    });
    expect(edited.value).toMatchObject({ applied: true });
    const text = Fs.readFileSync(config, "utf8");
    expect(text).toContain("// kept: a sibling changes");
    expect(text).not.toContain('"greeting"');
    // Keys the schema does not know read back redacted (D417): the file says what is there.
    const nodeLayer = () => parseConfigText(Fs.readFileSync(config, "utf8"))["jhin.example"];
    expect(nodeLayer()).toEqual({
      nested: { a: 1, b: 3, c: [1, 2] },
      flat: { deep: true },
    });
    // The project file's twin of a path is not touched.
    const project = await host.execute("host.config.edit", {
      layer: "project",
      section: "jhin.example",
      edits: [{ path: ["greeting"], value: "Yo" }],
    });
    expect(project.value).toMatchObject({ applied: true });
    expect((await host.execute("example.greet", { name: "A" })).value.message).toBe("Yo, A!");
    // A file without the object the sender's had takes the sender's whole key.
    await host.execute("host.config.edit", {
      layer: "node",
      section: "jhin.example",
      edits: [{ path: ["nested", "b"], value: 4 }],
      values: { nested: { a: 1, b: 4 } },
    });
    await host.execute("host.config.edit", {
      layer: "node",
      section: "jhin.example",
      edits: [{ path: ["other", "b"], value: 4 }],
      values: { other: { a: 1, b: 4 } },
    });
    expect(nodeLayer()).toMatchObject({ nested: { a: 1, b: 4, c: [1, 2] }, other: { a: 1, b: 4 } });
    // A change older than the last one loses (D50).
    const stale = await host.execute("host.config.edit", {
      layer: "node",
      section: "jhin.example",
      edits: [{ path: ["flat"] }],
      at: 1,
    });
    expect(stale.value).toMatchObject({
      applied: false,
      conflict: { localAt: expect.any(Number) },
    });
    // A key that would reach Object.prototype is refused.
    const unsafe = await host.execute("host.config.edit", {
      layer: "node",
      section: "jhin.example",
      edits: [{ path: ["__proto__", "x"], value: 1 }],
    });
    expect(unsafe.error).toBeDefined();
    // Not as a key of the whole values either.
    const unsafeValues = await host.execute("host.config.edit", {
      layer: "node",
      section: "jhin.example",
      edits: [{ path: ["x"], value: 1 }],
      values: JSON.parse('{"__proto__": {"x": 1}}') as Record<string, unknown>,
    });
    // Refused or dropped, it never reaches the file.
    // Zod's record drops the key before the refinement sees it.
    expect(unsafeValues.value).toMatchObject({ applied: true });
    expect(Fs.readFileSync(config, "utf8")).not.toContain("__proto__");
    const unsafeUnset = await host.execute("host.config.patch", {
      layer: "node",
      section: "jhin.example",
      values: {},
      unset: ["__proto__"],
    });
    expect(unsafeUnset.error).toBeDefined();
    // "constructor" is an ordinary key of a record (D480): kept like any other.
    const plain = await host.execute("host.config.edit", {
      layer: "node",
      section: "jhin.example",
      edits: [{ path: ["env", "constructor"], value: "x" }],
    });
    expect(plain.value).toMatchObject({ applied: true });
  });

  it("reports what the node is, with the owner's machine kind over the detected one", async () => {
    const home = tempDir("home");
    Fs.writeFileSync(
      Path.join(home, "config.jsonc"),
      '{\n  "jhin.host": { "machine": "laptop" }\n}\n',
    );
    host = new HostProcess({ home, cwd: tempDir("cwd") });
    await host.ready();

    // Gated like host.inspect: a scoped token needs host.identity to learn the host name.
    const commands = (await host.execute("host.commands.list", {})).value as {
      name: string;
      permissions: string[];
    }[];
    expect(commands.find((command) => command.name === "host.identity")?.permissions).toEqual([
      "host.identity",
    ]);

    const chosen = (await host.execute("host.identity", {})).value;
    expect(chosen).toMatchObject({
      nodeId: expect.any(String),
      hostname: Os.hostname(),
      platform: process.platform,
      arch: process.arch,
      machine: "laptop",
    });
    // Detection says what this machine is, or nothing; never something else.
    const detected: unknown = chosen.detectedMachine;
    expect(detected === undefined || MACHINE_KINDS.includes(detected as never)).toBe(true);

    // The settings page renders the section as a form: a select of titled kinds (D80, D81).
    const schema = (await host.execute("host.config.schema", {})).value;
    expect(schema.properties["jhin.host"]).toMatchObject({
      title: "Host",
      properties: {
        machine: {
          title: "Machine",
          anyOf: expect.arrayContaining([{ type: "string", const: "laptop", title: "Laptop" }]),
        },
      },
    });

    // Unset, the node shows what it detects, else a server.
    await host.execute("host.config.patch", {
      layer: "node",
      section: "jhin.host",
      values: {},
      unset: ["machine"],
    });
    const unset = (await host.execute("host.identity", {})).value;
    expect(unset.machine).toBe(detected ?? "server");

    // A kind the schema does not know chooses nothing.
    await host.execute("host.config.patch", {
      layer: "node",
      section: "jhin.host",
      values: { machine: "toaster" },
    });
    expect((await host.execute("host.identity", {})).value.machine).toBe(detected ?? "server");
  });
});
