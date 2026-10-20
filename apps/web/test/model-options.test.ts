import type { ModelOptionDescriptor } from "@jhin/agent-api";
import { describe, expect, it } from "vite-plus/test";

import {
  createModelOptionsMemory,
  currentOptionValue,
  traitSelectChange,
  traitsTriggerLabel,
  withOptionValue,
  type SelectDescriptor,
} from "../src/lib/model-options.ts";

const effort: SelectDescriptor = {
  type: "select",
  id: "effort",
  label: "Reasoning",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
  ],
  promptInjectedValues: ["ultrathink"],
};
const fast: ModelOptionDescriptor = { type: "boolean", id: "fastMode", label: "Fast Mode" };
const descriptors = [effort, fast];

describe("model options (T3's traits picker, D299)", () => {
  it("reads current values: the choice the model offers, else the default", () => {
    expect(currentOptionValue(effort, undefined)).toBe("medium");
    expect(currentOptionValue(effort, [{ id: "effort", value: "high" }])).toBe("high");
    expect(currentOptionValue(effort, [{ id: "effort", value: "max" }])).toBe("medium");
    expect(currentOptionValue(fast, [{ id: "fastMode", value: true }])).toBe(true);
    expect(currentOptionValue(fast, undefined)).toBeUndefined();
  });

  it("labels the trigger as T3 does", () => {
    expect(traitsTriggerLabel(descriptors, undefined, "")).toBe("Medium");
    expect(
      traitsTriggerLabel(
        descriptors,
        [
          { id: "effort", value: "high" },
          { id: "fastMode", value: true },
        ],
        "",
      ),
    ).toBe("High Fast");
    expect(traitsTriggerLabel([fast], undefined, "")).toBe("Normal");
    expect(traitsTriggerLabel([fast], [{ id: "fastMode", value: true }], "")).toBe("Fast");
    expect(traitsTriggerLabel(descriptors, undefined, "Ultrathink:\nfix it")).toBe("Ultrathink");
  });

  it("writes Ultrathink into the prompt, and takes it out when another effort is picked", () => {
    expect(traitSelectChange(descriptors, undefined, effort, "", "ultrathink")).toEqual({
      prompt: "Ultrathink:\n",
    });
    expect(traitSelectChange(descriptors, undefined, effort, "fix it", "ultrathink")).toEqual({
      prompt: "Ultrathink:\nfix it",
    });
    expect(
      traitSelectChange(descriptors, undefined, effort, "Ultrathink:\nfix it", "high"),
    ).toEqual({
      prompt: "fix it",
      modelOptions: [{ id: "effort", value: "high" }],
    });
    // "ultrathink" in the text itself locks the effort.
    expect(
      traitSelectChange(descriptors, undefined, effort, "please ultrathink about it", "low"),
    ).toBeNull();
  });

  it("keeps every other option's current value when one changes", () => {
    expect(
      withOptionValue(descriptors, [{ id: "fastMode", value: true }], "effort", "low"),
    ).toEqual([
      { id: "effort", value: "low" },
      { id: "fastMode", value: true },
    ]);
  });

  it("remembers options per model on the device and ignores corrupt values", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    } as Storage;
    createModelOptionsMemory(storage).set("acme", "opus", [{ id: "effort", value: "high" }]);
    expect(createModelOptionsMemory(storage).get("acme", "opus")).toEqual([
      { id: "effort", value: "high" },
    ]);
    store.set("jhin.composer.model-options.v1", JSON.stringify({ "a|b": [{ id: 1 }], "c|d": "x" }));
    expect(createModelOptionsMemory(storage).get("a", "b")).toBeUndefined();
    store.set("jhin.composer.model-options.v1", "{");
    expect(createModelOptionsMemory(storage).get("acme", "opus")).toBeUndefined();
  });
});
