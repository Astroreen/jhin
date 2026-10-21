import * as Os from "node:os";
import * as Path from "node:path";

import { z } from "@jhin/sdk";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CODEX_AGENT_ID, Config, createCodexRuntime, expandHome } from "../src/index.ts";
import { BUNDLED_MODELS } from "../src/mapping.ts";
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
            model("gpt-6-luna", {
              supportedReasoningEfforts: [{ reasoningEffort: 7 }],
              serviceTiers: null,
              additionalSpeedTiers: [null],
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
    // Entries that are not ids are skipped: no options at all.
    expect(codex.models?.[1]).not.toHaveProperty("options");
    // T3 defaults the gpt-6-astra family to medium, and keeps the catalog's default tier.
    expect(codex.models?.[2]?.options).toEqual([
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
    // "Standard" goes out as T3 sends it: `default`.
    await run("turn-4", {
      model: "gpt-6.1-sol",
      modelOptions: [{ id: "serviceTier", value: "default" }],
    });
    const [first, second, third, fourth] = fake.received("turn/start").map((call) => call.params);
    expect(first).toMatchObject({
      effort: "xhigh",
      serviceTier: "fast",
      collaborationMode: { settings: { reasoning_effort: "xhigh" } },
    });
    expect(second).toMatchObject({ effort: "low" });
    expect(second).not.toHaveProperty("serviceTier");
    expect(third).toMatchObject({ model: "custom-slug", effort: "low" });
    expect(third).not.toHaveProperty("serviceTier");
    expect(fourth).toMatchObject({ serviceTier: "default" });
    // T3 lists /compact for Codex.
    expect(await codex.commands!({ cwd: process.cwd() })).toEqual({
      commands: [
        { name: "compact", description: "Summarize the conversation and reduce context usage" },
      ],
      skills: [],
    });
    codex.dispose();
  });

  it("lists the skills Codex finds in a folder, and sends a skill as Codex parses it", async () => {
    const cwd = process.cwd();
    const { codex, fake } = runtime({
      skills: [
        { cwd: "/elsewhere", skills: [{ name: "other", path: "/o/SKILL.md", enabled: true }] },
        {
          cwd,
          skills: [
            {
              name: "review",
              path: "/s/review/SKILL.md",
              enabled: true,
              scope: "repo",
              interface: { displayName: "Review", shortDescription: "Reviews a diff" },
            },
            { name: "off", path: "/s/off/SKILL.md", enabled: false },
            { name: "", path: "/s/nameless/SKILL.md", enabled: true },
          ],
        },
      ],
    });
    const listed = await codex.commands!({ cwd });
    expect(listed.skills).toEqual([
      {
        name: "review",
        path: "/s/review/SKILL.md",
        description: "Reviews a diff",
        scope: "repo",
        displayName: "Review",
      },
    ]);
    // Asked again soon: the same answer, without starting Codex again.
    expect(await codex.commands!({ cwd })).toEqual(listed);
    expect(fake.received("skills/list").map((call) => call.params)).toEqual([{ cwds: [cwd] }]);

    const turn = codex.startTurn({
      threadId: "thread-1",
      turnId: "turn-1",
      input: { text: "€review this, costs €5" },
      history: [],
      cwd,
    });
    for await (const _ of turn.items) void _;
    expect(fake.received("turn/start")[0]?.params).toMatchObject({
      input: [{ type: "text", text: "$review this, costs €5" }],
    });
    codex.dispose();
  });

  it("asks for a folder's skills again after a failed ask", async () => {
    const cwd = process.cwd();
    const { codex, fake } = runtime({
      errors: { "skills/list": [{ message: "boom" }] },
      skills: [{ cwd, skills: [{ name: "review", path: "/s/SKILL.md", enabled: true }] }],
    });
    expect((await codex.commands!({ cwd })).skills).toEqual([]);
    expect((await codex.commands!({ cwd })).skills).toEqual([
      { name: "review", path: "/s/SKILL.md" },
    ]);
    expect(fake.received("skills/list")).toHaveLength(2);
  });

  it("adds the config's custom models after Codex's, with the options of its models", async () => {
    const efforts = {
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
    };
    const { codex, fake } = runtime(
      { models: [[model("gpt-6.1-sol", efforts), model("gpt-6-luna")]] },
      { customModels: ["gpt-7", { slug: "gpt-6.1-sol", name: "Sol" }, { slug: "gpt-7" }] },
    );
    await codex.status!();
    expect(codex.models?.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "gpt-6.1-sol", name: "Sol" },
      { id: "gpt-6-luna", name: "GPT-6-Luna" },
      { id: "gpt-7", name: "gpt-7" },
    ]);
    expect(codex.models?.[2]?.options).toEqual(codex.models?.[0]?.options);
    const turn = codex.startTurn({
      threadId: "thread-1",
      turnId: "turn-1",
      input: { text: "hi" },
      history: [],
      cwd: process.cwd(),
      model: "gpt-7",
      modelOptions: [{ id: "reasoningEffort", value: "high" }],
    });
    for await (const _ of turn.items) void _;
    expect(fake.received("turn/start")[0]?.params).toMatchObject({
      model: "gpt-7",
      effort: "high",
    });
    codex.dispose();
  });

  it("offers the custom models before Codex listed any, the first entry of a slug counting", () => {
    const { codex } = runtime(
      {},
      {
        customModels: [
          { slug: "gpt-6-astra", name: "Astra" },
          { slug: "gpt-6-astra", name: "Ignored" },
          "gpt-7",
          { slug: "gpt-7", name: "Ignored too" },
        ],
        defaultModel: "gpt-7",
      },
    );
    const models = codex.models!;
    expect(models.map(({ id, name }) => ({ id, name }))).toEqual([
      ...BUNDLED_MODELS.map(({ id, name }) => ({
        id,
        name: id === "gpt-6-astra" ? "Astra" : name,
      })),
      { id: "gpt-7", name: "gpt-7" },
    ]);
    // No listed model has options yet: none to lend.
    expect(models.at(-1)).not.toHaveProperty("options");
    // The same list while nothing changed.
    expect(codex.models).toBe(models);
    expect(codex.defaultModel).toBe("gpt-7");
  });

  it("checks the custom models it is given", () => {
    expect(Config.parse({}).customModels).toEqual([]);
    expect(
      Config.parse({ customModels: [" gpt-7 ", { slug: "a", name: " A " }] }).customModels,
    ).toEqual(["gpt-7", { slug: "a", name: "A" }]);
    expect(Config.safeParse({ customModels: [""] }).success).toBe(false);
    expect(Config.safeParse({ customModels: [{ slug: "a", name: "" }] }).success).toBe(false);
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
