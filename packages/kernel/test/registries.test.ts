import { parseConfigText } from "@jhin/kernel";
import { createTestKernel, nextEvent, testManifest } from "../../testing/src/index.ts"; // relative: a package dependency would be a cycle
import { definePlugin, z, type PluginContext } from "@jhin/sdk";
import { describe, expect, it } from "vite-plus/test";

/** Starts a kernel with one plugin and hands its context to the test. */
async function withContext(options: { config?: Record<string, Record<string, unknown>> } = {}) {
  let captured: PluginContext | undefined;
  const kernel = await createTestKernel({
    plugins: [
      {
        manifest: testManifest("app.test"),
        definition: definePlugin({ activate: (context) => void (captured = context) }),
      },
    ],
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  return { kernel, context: captured! };
}

describe("hooks", () => {
  it("runs before hooks, then around hooks outermost-first, then after hooks, by order", async () => {
    const { context } = await withContext();
    const trace: string[] = [];
    context.hooks.after<string, string>("app.send", (output) => `${output}|after:5`, { order: 5 });
    context.hooks.after<string, string>("app.send", (output) => `${output}|after:0`);
    context.hooks.around<string, string>(
      "app.send",
      async (input, next) => {
        trace.push("inner:in");
        const output = await next(`${input}|inner`);
        trace.push("inner:out");
        return output;
      },
      { order: 10 },
    );
    context.hooks.around<string, string>("app.send", async (input, next) => {
      trace.push("outer:in");
      const output = await next(`${input}|outer`);
      trace.push("outer:out");
      return output;
    });
    context.hooks.before<string>("app.send", (input) => `${input}|before:1`, { order: 1 });
    const early = context.hooks.before<string>("app.send", (input) => `${input}|before:-1`, {
      order: -1,
    });

    const result = await context.hooks.run("app.send", "msg", (input: string) => `impl(${input})`);

    expect(result).toBe("impl(msg|before:-1|before:1|outer|inner)|after:0|after:5");
    expect(trace).toEqual(["outer:in", "inner:in", "inner:out", "outer:out"]);

    early.dispose();
    expect(await context.hooks.run("app.send", "msg", (input: string) => input)).not.toContain(
      "before:-1",
    );
  });
});

describe("commands", () => {
  const add = {
    name: "math.add",
    description: "Adds two numbers",
    input: z.object({ a: z.number(), b: z.number() }),
    output: z.object({ sum: z.number() }),
    permissions: ["math.use"],
    handler: ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
  };

  it("validates input and output and exposes JSON schemas", async () => {
    const { kernel, context } = await withContext();
    context.commands.register(add);
    context.commands.register({
      ...add,
      name: "math.broken",
      handler: () => ({ sum: "nope" }) as never,
    });

    expect(await kernel.commands.execute("math.add", { a: 2, b: 3 })).toEqual({ sum: 5 });
    await expect(kernel.commands.execute("math.add", { a: "2" })).rejects.toMatchObject({
      code: "COMMAND_INPUT_INVALID",
    });
    await expect(kernel.commands.execute("math.broken", { a: 1, b: 1 })).rejects.toMatchObject({
      code: "COMMAND_OUTPUT_INVALID",
    });
    await expect(kernel.commands.execute("math.missing", {})).rejects.toMatchObject({
      code: "COMMAND_NOT_FOUND",
    });

    const info = kernel.commands.list().find((command) => command.name === "math.add");
    expect(info).toMatchObject({
      plugin: "app.test",
      permissions: ["math.use"],
      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
    });
  });

  it("checks caller permissions", async () => {
    const { kernel, context } = await withContext();
    context.commands.register(add);

    await expect(
      kernel.commands.execute(
        "math.add",
        { a: 1, b: 1 },
        { caller: { id: "agent", permissions: [] } },
      ),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED", details: { missing: ["math.use"] } });
    expect(
      await kernel.commands.execute(
        "math.add",
        { a: 1, b: 1 },
        { caller: { id: "agent", permissions: ["math.use"] } },
      ),
    ).toEqual({ sum: 2 });
    expect(
      await kernel.commands.execute(
        "math.add",
        { a: 1, b: 1 },
        { caller: { id: "owner", permissions: ["*"] } },
      ),
    ).toEqual({
      sum: 2,
    });
  });

  it("rejects duplicate and unnamespaced commands", async () => {
    const { context } = await withContext();
    context.commands.register(add);

    expect(() => context.commands.register(add)).toThrow(
      expect.objectContaining({ code: "COMMAND_DUPLICATE" }),
    );
    expect(() => context.commands.register({ ...add, name: "add" })).toThrow(
      expect.objectContaining({ code: "COMMAND_NAME_INVALID" }),
    );
  });
});

describe("config", () => {
  const schema = z.object({
    port: z.number().default(7777),
    theme: z.string().default("dark"),
    tags: z.array(z.string()).default([]),
  });

  it("merges layers with later layers winning and applies defaults", async () => {
    const { kernel, context } = await withContext({
      config: {
        distribution: { "app.server": { port: 8000, tags: ["a", "b"] } },
        node: { "app.server": { port: 9000 } },
        project: { "app.server": { tags: ["c"] } },
      },
    });
    context.config.define("app.server", schema);

    expect(context.config.get("app.server")).toEqual({ port: 9000, theme: "dark", tags: ["c"] });
    expect(kernel.config.jsonSchema()).toMatchObject({
      properties: {
        "app.server": { type: "object", properties: { port: { type: "number", default: 7777 } } },
      },
    });
  });

  it("reports invalid values and notifies listeners only on change", async () => {
    const { kernel, context } = await withContext();
    context.config.define("app.server", schema);
    const seen: unknown[] = [];
    context.config.onDidChange("app.server", (value) => seen.push(value));

    kernel.config.setLayer("node", { "app.server": { port: 1 } });
    kernel.config.setLayer("node", { "app.server": { port: 1 } });
    kernel.config.setLayer("node", { "app.server": { port: 1 }, other: true });
    kernel.config.setLayer("node", { "app.server": { port: "bad" } });

    expect(seen).toEqual([{ port: 1, theme: "dark", tags: [] }]);
    expect(() => context.config.get("app.server")).toThrow(
      expect.objectContaining({
        code: "CONFIG_INVALID",
        details: expect.objectContaining({ section: "app.server" }),
      }),
    );
  });

  it("parses JSONC layers with comments and trailing commas", () => {
    expect(parseConfigText('{\n  // the port\n  "app.server": { "port": 1, },\n}')).toEqual({
      "app.server": { port: 1 },
    });
    expect(() => parseConfigText("{ nope")).toThrow(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });
});

describe("events", () => {
  it("delivers namespaced events and survives a throwing listener", async () => {
    const { kernel, context } = await withContext();
    context.events.on("app.ping", () => {
      throw new Error("listener bug");
    });
    const received = nextEvent(kernel, "app.ping");

    context.events.emit("app.ping", { n: 1 });

    expect(await received).toEqual({ n: 1 });
    expect(() => context.events.emit("ping")).toThrow(
      expect.objectContaining({ code: "EVENT_TYPE_INVALID" }),
    );
  });
});
