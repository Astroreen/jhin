import * as Os from "node:os";
import * as Path from "node:path";

import { z } from "@jhin/sdk";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CODEX_AGENT_ID, Config, createCodexRuntime, expandHome } from "../src/index.ts";
import { fakeCodex, node, stopAll, type Scenario } from "./support.ts";

afterEach(async () => {
  vi.useRealTimers();
  await stopAll();
});

const threads = {
  get: async () => undefined,
  set: async () => {},
  delete: async () => {},
};

function runtime(scenario: Scenario, config: Record<string, unknown> = {}) {
  const fake = fakeCodex(scenario);
  return {
    fake,
    codex: createCodexRuntime({
      threads,
      config: () => Config.parse({ ...fake.config, ...config }),
    }),
  };
}

const model = (slug: string, extra: Record<string, unknown> = {}) => ({
  id: slug,
  model: slug,
  displayName: slug,
  description: `${slug} model`,
  hidden: false,
  isDefault: false,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [],
  ...extra,
});

describe("jhin.agent-codex: status", () => {
  it("is available when signed in, with Codex's models and T3's preferred default", async () => {
    const { codex, fake } = runtime({
      models: [
        [model("gpt-5.6-terra"), model("gpt-6-luna", { isDefault: true })],
        [model("gpt-5.6-sol")],
      ],
    });
    expect(await codex.status!()).toEqual({
      available: true,
      message: "Signed in as dev@example.com",
      version: "0.200.0",
    });
    expect(codex.models?.map((entry) => entry.id)).toEqual([
      "gpt-5.6-terra",
      "gpt-6-luna",
      "gpt-5.6-sol",
    ]);
    expect(codex.models?.[0]).toEqual({
      id: "gpt-5.6-terra",
      name: "GPT-5.6-Terra",
      description: "gpt-5.6-terra model",
    });
    expect(codex.defaultModel).toBe("gpt-5.6-sol");
    expect(fake.received("model/list").map((call) => call.params)).toEqual([{}, { cursor: "1" }]);
    // The probe ran in the node's temporary folder and ended its Codex.
    expect(fake.log()[0]).toMatchObject({ started: ["app-server"] });
  });

  it("asks Codex for its models before a first turn that names none", async () => {
    const { codex, fake } = runtime({ models: [[model("gpt-6.1-sol", { isDefault: true })]] });
    const turn = codex.startTurn({
      threadId: "thread-1",
      turnId: "turn-1",
      input: { text: "hi" },
      history: [],
      cwd: process.cwd(),
    });
    for await (const _ of turn.items) void _;
    expect(fake.received("turn/start")[0]?.params).toMatchObject({ model: "gpt-6.1-sol" });
    codex.dispose();
  });

  it("describes a model's efforts and service tiers, and a turn's choices reach Codex", async () => {
    const { codex, fake } = runtime(
      {
        models: [
          [
            model("gpt-6.1-sol", {
              isDefault: true,
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "high" },
                { reasoningEffort: "xhigh" },
              ],
              serviceTiers: [{ id: "fast", name: "Fast", description: "Faster replies" }],
            }),
            model("gpt-6-astra", {
              supportedReasoningEfforts: [
                { reasoningEffort: "medium" },
                { reasoningEffort: "high" },
              ],
              defaultReasoningEffort: "high",
              additionalSpeedTiers: ["fast", "ultrafast"],
              defaultServiceTier: "fast",
            }),
          ],
        ],
      },
      { effort: "low" },
    );
    await codex.status!();
    expect(codex.models?.[0]?.options).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
          { id: "xhigh", label: "Extra High" },
        ],
      },
      {
        id: "serviceTier",
        label: "Service Tier",
        type: "select",
        options: [
          { id: "default", label: "Standard", isDefault: true },
          { id: "fast", label: "Fast", description: "Faster replies" },
        ],
      },
    ]);
    // T3 defaults the gpt-6-astra family to medium, and keeps the catalog's default tier.
    expect(codex.models?.[1]?.options).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
        ],
      },
      {
        id: "serviceTier",
        label: "Service Tier",
        type: "select",
        options: [
          { id: "default", label: "Standard" },
          { id: "fast", label: "Fast", isDefault: true },
          { id: "ultrafast", label: "ultrafast", description: "Even faster, more expensive" },
        ],
      },
    ]);

    const run = async (turnId: string, extra: Record<string, unknown>) => {
      const turn = codex.startTurn({
        threadId: "thread-1",
        turnId,
        input: { text: "hi" },
        history: [],
        cwd: process.cwd(),
        ...extra,
      });
      for await (const _ of turn.items) void _;
    };
    await run("turn-1", {
      model: "gpt-6.1-sol",
      modelOptions: [
        { id: "reasoningEffort", value: "xhigh" },
        { id: "serviceTier", value: "fast" },
      ],
    });
    // A choice the model does not offer is dropped: the config's effort, no tier.
    await run("turn-2", {
      model: "gpt-6.1-sol",
      modelOptions: [{ id: "reasoningEffort", value: "minimal" }],
    });
    // A model Codex did not list takes no options.
    await run("turn-3", {
      model: "custom-slug",
      modelOptions: [{ id: "serviceTier", value: "fast" }],
    });
    const [first, second, third] = fake.received("turn/start").map((call) => call.params);
    expect(first).toMatchObject({
      effort: "xhigh",
      serviceTier: "fast",
      collaborationMode: { settings: { reasoning_effort: "xhigh" } },
    });
    expect(second).toMatchObject({ effort: "low" });
    expect(second).not.toHaveProperty("serviceTier");
    expect(third).toMatchObject({ model: "custom-slug", effort: "low" });
    expect(third).not.toHaveProperty("serviceTier");
    codex.dispose();
  });

  it("falls back to Codex's own default, and the config's wins", async () => {
    const first = runtime({ models: [[model("a"), model("b", { isDefault: true })]] });
    await first.codex.status!();
    expect(first.codex.defaultModel).toBe("b");
    const second = runtime({ models: [[model("a")]] }, { defaultModel: "mine" });
    await second.codex.status!();
    expect(second.codex.defaultModel).toBe("mine");
  });

  it("shows the bundled models again once the config names another Codex", async () => {
    const fake = fakeCodex({ models: [[model("gpt-6.1-sol")]] });
    let config = Config.parse(fake.config);
    const codex = createCodexRuntime({ threads, config: () => config });
    await codex.status!();
    expect(codex.defaultModel).toBe("gpt-6.1-sol");
    config = Config.parse({ ...fake.config, homePath: "/other/home" });
    expect(codex.models?.map((entry) => entry.id)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    expect(codex.defaultModel).toBe("gpt-6-astra");
  });

  it("names the plan of a ChatGPT account without an email, and an API key", async () => {
    const plan = runtime({
      account: { account: { type: "chatgpt", email: null, planType: "pro" } },
    });
    expect(await plan.codex.status!()).toMatchObject({
      available: true,
      message: "ChatGPT Pro 20x Subscription",
    });
    const key = runtime({ account: { account: { type: "apiKey" }, requiresOpenaiAuth: true } });
    expect(await key.codex.status!()).toMatchObject({ available: true, message: "OpenAI API Key" });
  });

  it("is unavailable when Codex is not signed in", async () => {
    const { codex, fake } = runtime({ account: { account: null, requiresOpenaiAuth: true } });
    expect(await codex.status!()).toEqual({
      available: false,
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
      version: "0.200.0",
    });
    expect(fake.received("model/list")).toEqual([]);
    expect(codex.models?.map((entry) => entry.id)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
  });

  it("is unavailable when Codex does not start", async () => {
    const missing = Path.join(Os.tmpdir(), "jhin-no-such-codex");
    const codex = createCodexRuntime({
      threads,
      config: () => Config.parse({ binaryPath: missing }),
    });
    expect(await codex.status!()).toEqual({
      available: false,
      message: `Could not start Codex CLI (\`${missing}\`). Check the Codex executable in the node's settings. Make sure the configured executable exists and can be run.`,
    });
  });

  it("is unavailable when Codex does not answer in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { codex } = runtime({ hangOnInitialize: true });
    const status = codex.status!();
    vi.advanceTimersByTime(20_000);
    expect(await status).toEqual({
      available: false,
      message: "Timed out while checking Codex app-server provider status.",
    });
  });

  it("is unavailable when Codex fails a request after starting", async () => {
    const { codex } = runtime({ errors: { "account/read": [{ message: "boom" }] } });
    expect(await codex.status!()).toEqual({
      available: false,
      message: "Codex app-server provider probe failed: boom.",
    });
  });

  it("is listed among the node's agents", async () => {
    const fake = fakeCodex({});
    const { client } = await node(fake);
    const agents = await client.call<{ agentId: string; name: string }[]>("agents.list", {});
    expect(agents.find((agent) => agent.agentId === CODEX_AGENT_ID)).toMatchObject({
      name: "Codex",
    });
  });
});

describe("the jhin.agent-codex section on the settings page (config-ui.md)", () => {
  const schema = z.toJSONSchema(Config, { io: "input", unrepresentable: "any" }) as {
    title?: string;
    description?: string;
    properties: Record<string, { title?: string; description?: string; writeOnly?: boolean }>;
  };

  it("titles and describes the section and every field", () => {
    expect(schema).toMatchObject({ title: "Codex", description: expect.any(String) });
    for (const [key, field] of Object.entries(schema.properties)) {
      expect({ key, title: field.title, description: field.description }).toEqual({
        key,
        title: expect.any(String),
        description: expect.any(String),
      });
    }
  });

  it("marks the environment a secret, so the page hides its values (D83)", () => {
    expect(schema.properties["env"]?.writeOnly).toBe(true);
  });

  it("expands ~ in CODEX_HOME, as a shell would", () => {
    expect(expandHome("~/.codex_work")).toBe(Path.join(Os.homedir(), ".codex_work"));
    expect(expandHome("/abs")).toBe("/abs");
    expect(expandHome("")).toBeUndefined();
  });
});
