import * as Fs from "node:fs";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { HostProcess, tempDir, writePlugin } from "./support/harness.ts";

const SECRETS = Path.resolve(import.meta.dirname, "../../../plugins/secrets");

// Recognisable values, looked for everywhere they must not be (security.md D1033).
const CLEAR = "clear-key-3b1d77f0";
const CLEAR_A = "clear-env-a-9c2e41aa";
const NEW_B = "new-env-b-51f0c8d3";
const PROJECT = "project-secret-0e7d2c19";
const TOKEN = "token-t-7a90be22";
const VALUES = [CLEAR, CLEAR_A, NEW_B, PROJECT, TOKEN];

/** A plugin with secrets in its config, and a check that tells whether a value arrived. */
function writeVault(home: string): void {
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
        env: z.record(z.string(), z.string().meta({ writeOnly: true })).optional(),
        // Secret as a whole, as the agents' environments are.
        tokens: z.record(z.string(), z.string()).optional().meta({ writeOnly: true }),
        project: z.string().optional().meta({ writeOnly: true }),
      }),
    );
    context.commands.register({
      name: "acme.vault.matches",
      description: "Whether the effective value at a path is the one expected",
      input: z.object({ path: z.array(z.string()), expected: z.string() }),
      output: z.boolean(),
      handler: ({ path, expected }) => {
        let value: unknown = context.config.get("acme.vault");
        for (const key of path) value = (value as Record<string, unknown> | undefined)?.[key];
        return value === expected;
      },
    });
  },
});
`,
    },
  );
}

let host: HostProcess | undefined;
afterEach(async () => {
  await host?.stop();
  host = undefined;
});

describe("config secrets in the secret store (security.md D1025–D1027)", () => {
  it("moves secrets out of the config files, resolves them for plugins, and never lets them out", async () => {
    const home = tempDir("home");
    writeVault(home);
    const config = Path.join(home, "config.jsonc");
    // A config written before the store: its secrets in clear keep working (D1027).
    Fs.writeFileSync(
      config,
      `{
  // The keychain is the machine's own: tests keep the key in a file.
  "jhin.secrets": { "keychain": "off" },
  "acme.vault": {
    "user": "me",
    "key": "${CLEAR}",
    "env": { "A": "${CLEAR_A}" },
    "tokens": { "T": "${TOKEN}" }
  }
}
`,
    );
    const cwd = tempDir("cwd");
    Fs.mkdirSync(Path.join(cwd, ".jhin"));
    const projectConfig = Path.join(cwd, ".jhin", "config.jsonc");
    Fs.writeFileSync(projectConfig, `{ "acme.vault": { "project": "${PROJECT}" } }\n`);
    host = new HostProcess({ home, cwd, distribution: [SECRETS] });
    const { inspection } = await host.ready();
    const results: unknown[] = [];
    const run = async (command: string, input: unknown = {}) => {
      const result = await host!.execute(command, input);
      results.push(result);
      return result;
    };
    const matches = async (path: string[], expected: string) =>
      (await run("acme.vault.matches", { path, expected })).value;

    expect(await matches(["key"], CLEAR)).toBe(true);

    // The settings form sends markers back with a new value: all of them go to the store.
    const saved = await run("host.config.patch", {
      layer: "node",
      section: "acme.vault",
      values: { key: "••••••", env: { A: "••••••", B: NEW_B } },
    });
    expect(saved.value).toMatchObject({ applied: true });
    const file = Fs.readFileSync(config, "utf8");
    for (const value of [CLEAR, CLEAR_A, NEW_B]) expect(file).not.toContain(value);
    expect(file.match(/"\$secret:[0-9a-f]{32}"/g)).toHaveLength(3);
    // The comment above the section stays.
    expect(file).toContain("// The keychain is the machine's own");
    expect(await matches(["key"], CLEAR)).toBe(true);
    expect(await matches(["env", "A"], CLEAR_A)).toBe(true);
    expect(await matches(["env", "B"], NEW_B)).toBe(true);

    // What is left in clear in both files, moved by the migration; only where it was is returned.
    const migrated = await run("host.config.secrets.migrate", {});
    expect(migrated.value).toEqual({
      moved: [
        { layer: "node", section: "acme.vault", path: ["tokens", "T"] },
        { layer: "project", section: "acme.vault", path: ["project"] },
      ],
    });
    expect(Fs.readFileSync(projectConfig, "utf8")).toMatch(
      /^\{ "acme\.vault": \{ "project": "\$secret:[0-9a-f]{32}" \} \}/,
    );
    expect(await matches(["project"], PROJECT)).toBe(true);
    expect(await matches(["tokens", "T"], TOKEN)).toBe(true);
    expect((await run("secrets.status")).value).toEqual({
      state: "ready",
      key: "file",
      keychain: null,
      configSecrets: 5,
      openRefs: 0,
    });

    // host.config.get redacts as before: no value, and no reference either.
    const read = await run("host.config.get", { section: "acme.vault" });
    expect(read.value.value).toEqual({
      user: "me",
      key: "••••••",
      env: { A: "••••••", B: "••••••" },
      tokens: "••••••",
      project: "••••••",
    });
    expect(JSON.stringify(read.value)).not.toContain("$secret:");

    // A reference copied into a field that is no secret does not resolve there (D1025).
    const reference = /"key": "(\$secret:[0-9a-f]{32})"/.exec(Fs.readFileSync(config, "utf8"))?.[1];
    expect(reference).toBeDefined();
    await run("host.config.patch", {
      layer: "node",
      section: "acme.vault",
      values: { user: reference },
    });
    expect((await run("host.config.get", { section: "acme.vault" })).value.value.user).toBe(
      undefined,
    );
    expect(await matches(["user"], CLEAR)).toBe(false);

    // A removed secret leaves the store.
    await run("host.config.edit", {
      layer: "node",
      section: "acme.vault",
      edits: [{ path: ["env"] }],
    });
    expect((await run("secrets.status")).value.configSecrets).toBe(3);
    expect(await matches(["key"], CLEAR)).toBe(true);

    // Nothing that left the node, nor its log, holds a value: results, kernel events, files.
    const received = JSON.stringify(host.received);
    await host.stop();
    host = undefined;
    const log = Fs.readFileSync(inspection.logFile, "utf8");
    expect(received).toContain("host.config.changed");
    for (const value of VALUES) {
      expect(JSON.stringify(results)).not.toContain(value);
      expect(received).not.toContain(value);
      expect(log).not.toContain(value);
      expect(Fs.readFileSync(config, "utf8")).not.toContain(value);
      expect(Fs.readFileSync(projectConfig, "utf8")).not.toContain(value);
      expect(
        Fs.readFileSync(Path.join(home, "data", "jhin.secrets", "store.json"), "utf8"),
      ).not.toContain(value);
    }
  });

  it("resolves the references after a restart, once the store is active", async () => {
    const home = tempDir("home");
    writeVault(home);
    const config = Path.join(home, "config.jsonc");
    Fs.writeFileSync(
      config,
      `{ "jhin.secrets": { "keychain": "off" }, "acme.vault": { "key": "${CLEAR}" } }\n`,
    );
    const cwd = tempDir("cwd");
    host = new HostProcess({ home, cwd, distribution: [SECRETS] });
    await host.ready();
    expect((await host.execute("host.config.secrets.migrate", { layer: "node" })).value).toEqual({
      moved: [{ layer: "node", section: "acme.vault", path: ["key"] }],
    });
    await host.stop();
    expect(Fs.readFileSync(config, "utf8")).not.toContain(CLEAR);

    host = new HostProcess({ home, cwd, distribution: [SECRETS] });
    await host.ready();
    expect(
      (await host.execute("acme.vault.matches", { path: ["key"], expected: CLEAR })).value,
    ).toBe(true);
  });

  it("seals numbers and booleans too, and gives them back with their types (D1373)", async () => {
    const home = tempDir("home");
    writePlugin(
      Path.join(home, "plugins", "typed"),
      { id: "acme.typed" },
      {
        "index.ts": `
import { definePlugin, z } from "@jhin/sdk";
export default definePlugin({
  activate(context) {
    context.config.define(
      "acme.typed",
      z.object({
        pin: z.number().optional().meta({ writeOnly: true }),
        debug: z.boolean().optional().meta({ writeOnly: true }),
        note: z.string().optional().meta({ writeOnly: true }),
      }),
    );
    context.commands.register({
      name: "acme.typed.read",
      description: "The effective section, as plugins read it",
      input: z.object({}),
      output: z.unknown(),
      handler: () => context.config.get("acme.typed"),
    });
  },
});
`,
      },
    );
    const config = Path.join(home, "config.jsonc");
    // A number written before the store, in clear: the migration moves it.
    Fs.writeFileSync(
      config,
      `{ "jhin.secrets": { "keychain": "off" }, "acme.typed": { "pin": 731942 } }\n`,
    );
    const cwd = tempDir("cwd");
    host = new HostProcess({ home, cwd, distribution: [SECRETS] });
    await host.ready();
    expect((await host.execute("host.config.secrets.migrate", { layer: "node" })).value).toEqual({
      moved: [{ layer: "node", section: "acme.typed", path: ["pin"] }],
    });
    // A string that looks like the store's tag is kept as itself.
    const tagged = "\u0000json:42";
    const saved = await host.execute("host.config.patch", {
      layer: "node",
      section: "acme.typed",
      values: { pin: "••••••", debug: true, note: tagged },
    });
    expect(saved.value).toMatchObject({ applied: true });
    const file = JSON.parse(Fs.readFileSync(config, "utf8")) as {
      "acme.typed": Record<string, unknown>;
    };
    expect(file["acme.typed"]).toEqual({
      pin: expect.stringMatching(/^\$secret:[0-9a-f]{32}$/),
      debug: expect.stringMatching(/^\$secret:[0-9a-f]{32}$/),
      note: expect.stringMatching(/^\$secret:[0-9a-f]{32}$/),
    });
    const read = async () => (await host!.execute("acme.typed.read")).value;
    expect(await read()).toEqual({ pin: 731942, debug: true, note: tagged });
    // Redacted on the way out, as every secret (D417).
    expect(
      JSON.stringify((await host.execute("host.config.get", { section: "acme.typed" })).value),
    ).not.toContain("731942");

    await host.stop();
    host = new HostProcess({ home, cwd, distribution: [SECRETS] });
    await host.ready();
    expect(await read()).toEqual({ pin: 731942, debug: true, note: tagged });
  });

  it("keeps nothing in the store when the file cannot be written", async () => {
    const home = tempDir("home");
    writeVault(home);
    Fs.writeFileSync(
      Path.join(home, "config.jsonc"),
      `{ "jhin.secrets": { "keychain": "off" } }\n`,
    );
    const cwd = tempDir("cwd");
    const dir = Path.join(cwd, ".jhin");
    Fs.mkdirSync(dir);
    host = new HostProcess({ home, cwd, distribution: [SECRETS] });
    await host.ready();
    // The project directory cannot take the new file.
    Fs.chmodSync(dir, 0o500);
    try {
      const failed = await host.execute("host.config.patch", {
        layer: "project",
        section: "acme.vault",
        values: { key: NEW_B },
      });
      expect(failed.error).toBeDefined();
    } finally {
      Fs.chmodSync(dir, 0o700);
    }
    expect((await host.execute("secrets.status")).value.configSecrets).toBe(0);
  });

  it("leaves a reference with no store out, and keeps saving in clear without one", async () => {
    const home = tempDir("home");
    writeVault(home);
    const config = Path.join(home, "config.jsonc");
    Fs.writeFileSync(
      config,
      `{ "acme.vault": { "key": "$secret:${"0".repeat(32)}", "user": "me" } }\n`,
    );
    host = new HostProcess({ home, cwd: tempDir("cwd") });
    await host.ready();
    const read = await host.execute("host.config.get", { section: "acme.vault" });
    expect(read.value.value).toEqual({ user: "me" });
    const migrate = await host.execute("host.config.secrets.migrate", {});
    expect(migrate.error).toMatchObject({ code: "SECRET_STORE_UNAVAILABLE" });
    await host.execute("host.config.patch", {
      layer: "node",
      section: "acme.vault",
      values: { key: NEW_B },
    });
    expect(Fs.readFileSync(config, "utf8")).toContain(NEW_B);
  });
});
