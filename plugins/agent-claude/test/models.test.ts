import { describe, expect, it } from "vite-plus/test";

import {
  applyUltrathinkPrefix,
  claudeProfile,
  compileClaudeSelection,
  manifestContextWindow,
  withOptions,
} from "../src/models.ts";

describe("jhin.agent-claude: model options (D298, T3's manifest)", () => {
  it("gives models their profile's options by id or alias", () => {
    expect(withOptions({ id: "opus", name: "Opus" }).options?.map((option) => option.id)).toEqual([
      "effort",
      "fastMode",
    ]);
    expect(withOptions({ id: "claude-sonnet-5-5", name: "Sonnet" }).options).toHaveLength(1);
    expect(withOptions({ id: "acme-model", name: "Other" }).options).toBeUndefined();
    expect(claudeProfile("claude-sonnet-4-6[1m]")).toBe(claudeProfile("sonnet-4.6"));
  });

  it("applies the effort map, fast mode and Ultracode as T3 does", () => {
    expect(
      compileClaudeSelection(
        "claude-opus-5-5",
        [
          { id: "effort", value: "high" },
          { id: "fastMode", value: true },
        ],
        undefined,
      ),
    ).toEqual({
      model: "claude-opus-5-5",
      effort: "high",
      settings: { fastMode: true },
      thinking: true,
      ultrathink: false,
    });
    expect(
      compileClaudeSelection("claude-opus-5-5", [{ id: "effort", value: "ultracode" }], undefined),
    ).toMatchObject({ effort: "xhigh", settings: { fastMode: false, ultracode: true } });
    const ultrathink = compileClaudeSelection(
      "claude-fable-5-1",
      [{ id: "effort", value: "ultrathink" }],
      undefined,
    );
    expect(ultrathink.effort).toBeUndefined();
    expect(ultrathink.ultrathink).toBe(true);
    // Sonnet 4.6 knows no "max": T3 maps it to high.
    expect(
      compileClaudeSelection("claude-sonnet-4-6", [{ id: "effort", value: "max" }], undefined)
        .effort,
    ).toBe("high");
  });

  it("falls back to the config's effort, and to Claude Code's own default without one", () => {
    // An effort the model does not offer is not sent (T3 resolves it against the descriptor).
    expect(compileClaudeSelection("claude-sonnet-4-6", [], "xhigh").effort).toBeUndefined();
    expect(compileClaudeSelection("claude-opus-5-5", [], "low").effort).toBe("low");
    expect(
      compileClaudeSelection("claude-opus-5-5", [{ id: "effort", value: "max" }], "low").effort,
    ).toBe("max");
    expect(compileClaudeSelection("claude-opus-5-5", undefined, undefined).effort).toBeUndefined();
    // Options a model does not declare are dropped; an unknown model takes a known effort only.
    expect(
      compileClaudeSelection("claude-sonnet-5-5", [{ id: "fastMode", value: true }], undefined)
        .settings,
    ).toEqual({});
    expect(compileClaudeSelection("acme-model", [{ id: "effort", value: "high" }], "max")).toEqual({
      model: "acme-model",
      effort: "max",
      settings: {},
      thinking: true,
      ultrathink: false,
    });
  });

  it("names the context window in the model id and knows its size", () => {
    expect(
      compileClaudeSelection("claude-opus-4-6", [{ id: "contextWindow", value: "200k" }], undefined)
        .model,
    ).toBe("claude-opus-4-6");
    // Opus 4.6 defaults to 1M, Sonnet 4.6 to 200k.
    expect(compileClaudeSelection("claude-opus-4-6", [], undefined).model).toBe(
      "claude-opus-4-6[1m]",
    );
    expect(compileClaudeSelection("claude-sonnet-4-6", [], undefined).model).toBe(
      "claude-sonnet-4-6",
    );
    expect(manifestContextWindow("claude-sonnet-4-6")).toBe(200_000);
    expect(manifestContextWindow("claude-sonnet-4-6[1m]")).toBe(1_000_000);
    expect(manifestContextWindow("claude-sonnet-4-6", [{ id: "contextWindow", value: "1m" }])).toBe(
      1_000_000,
    );
    expect(manifestContextWindow("claude-opus-5-5")).toBe(1_000_000);
    expect(manifestContextWindow("acme-model")).toBeUndefined();
  });

  it("switches Haiku 4.5's thinking off on request", () => {
    expect(
      compileClaudeSelection("claude-haiku-4-5", [{ id: "thinking", value: false }], undefined),
    ).toMatchObject({ settings: { alwaysThinkingEnabled: false }, thinking: false });
  });

  it("writes Ultrathink before a message, never before a slash command", () => {
    expect(applyUltrathinkPrefix("fix it")).toBe("Ultrathink:\nfix it");
    expect(applyUltrathinkPrefix("Ultrathink:\nfix it")).toBe("Ultrathink:\nfix it");
    expect(applyUltrathinkPrefix("/review now")).toBe("/review now");
    expect(applyUltrathinkPrefix("  ")).toBe("");
    expect(applyUltrathinkPrefix("/home/ada/app.ts is broken")).toBe(
      "Ultrathink:\n/home/ada/app.ts is broken",
    );
  });
});
