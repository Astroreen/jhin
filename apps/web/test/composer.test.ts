import { describe, expect, it } from "vite-plus/test";

import {
  buildPromptHistory,
  createDrafts,
  stepPromptHistory,
  type PromptHistoryPosition,
} from "../src/lib/composer.ts";

/** A Storage over a map, as `localStorage` would be. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

describe("prompt history", () => {
  const entries = buildPromptHistory([
    { id: "1", text: "first" },
    { id: "2", text: "  " },
    { id: "3", text: "second" },
    { id: "4", text: "second" },
    { id: "5", text: "third" },
  ]);

  it("skips blank prompts and collapses repeats to the newest", () => {
    expect(entries).toEqual([
      { id: "1", prompt: "first" },
      { id: "4", prompt: "second" },
      { id: "5", prompt: "third" },
    ]);
  });

  it("walks back from an empty composer and forward to empty again", () => {
    let position: PromptHistoryPosition | null = null;
    let prompt = "";
    const step = (direction: "backward" | "forward") => {
      const next = stepPromptHistory({ direction, entries, position, currentPrompt: prompt });
      if (next !== null) {
        position = next.position;
        prompt = next.prompt;
      }
      return next;
    };

    expect(step("backward")?.prompt).toBe("third");
    expect(step("backward")?.prompt).toBe("second");
    expect(step("backward")?.prompt).toBe("first");
    expect(step("backward")).toBeNull();
    expect(step("forward")?.prompt).toBe("second");
    expect(step("forward")?.prompt).toBe("third");
    expect(step("forward")).toEqual({ position: null, prompt: "" });
    expect(step("forward")).toBeNull();
  });

  it("does not browse over a prompt being written or edited", () => {
    expect(
      stepPromptHistory({ direction: "backward", entries, position: null, currentPrompt: "draft" }),
    ).toBeNull();
    // A recalled prompt that was edited is a draft now.
    expect(
      stepPromptHistory({
        direction: "backward",
        entries,
        position: { entryId: "5", recalled: "third" },
        currentPrompt: "third, edited",
      }),
    ).toBeNull();
  });
});

describe("drafts", () => {
  const attachment = {
    kind: "image" as const,
    name: "a.png",
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,AAAA",
  };

  it("loads what the device kept and ignores unreadable storage", () => {
    const kept = createDrafts(
      memoryStorage({
        "jhin.drafts.v1": JSON.stringify({ t1: { prompt: "hello", attachments: [] } }),
      }),
    );
    expect(kept.get("t1")).toEqual({ prompt: "hello", attachments: [] });
    expect(createDrafts(memoryStorage({ "jhin.drafts.v1": "{nope" })).get("t1")).toBeUndefined();
  });

  it("keeps text and images per key and forgets empty drafts", () => {
    const drafts = createDrafts(memoryStorage());
    drafts.set("t1", { prompt: "", attachments: [attachment] });
    drafts.set("t2", { prompt: "other", attachments: [] });
    expect(drafts.get("t1")).toEqual({ prompt: "", attachments: [attachment] });
    drafts.set("t1", { prompt: "", attachments: [] });
    expect(drafts.get("t1")).toBeUndefined();
    expect(drafts.get("t2")?.prompt).toBe("other");
  });
});
