import { describe, expect, it } from "vite-plus/test";

import {
  buildPromptHistory,
  createDrafts,
  fitAttachments,
  newThreadDraftKey,
  nodeDraftKey,
  threadDraftKey,
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
    id: "att-1",
    name: "a.png",
    mimeType: "image/png",
    sizeBytes: 3,
    previewUrl: "data:image/png;base64,AAAA",
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

  it("merges the drafts of two tabs instead of one overwriting the other", () => {
    const storage = memoryStorage();
    const a = createDrafts(storage);
    const b = createDrafts(storage);
    a.set("t1", { prompt: "from a", attachments: [] });
    b.set("t2", { prompt: "from b", attachments: [] });
    a.flush();
    b.flush();

    const later = createDrafts(storage);
    expect(later.get("t1")?.prompt).toBe("from a");
    expect(later.get("t2")?.prompt).toBe("from b");

    // A draft emptied in a tab that has it is removed for all.
    a.set("t1", { prompt: "", attachments: [] });
    a.flush();
    expect(createDrafts(storage).get("t1")).toBeUndefined();
    expect(createDrafts(storage).get("t2")?.prompt).toBe("from b");
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

describe("attachments of one message", () => {
  const image = (name: string, sizeBytes: number) => ({ kind: "image", name, sizeBytes });
  const file = (name: string, sizeBytes: number) => ({ kind: "file", name, sizeBytes });

  it("keeps what fits in count and image bytes, in order, and names the rest", () => {
    const limit = { count: 4, totalImageBytes: 100 };
    const kept = [image("a", 30)];
    const result = fitAttachments(
      kept,
      [image("b", 40), image("c", 60), file("big", 500), image("d", 25)],
      limit,
    );
    // Files do not count towards the images' bytes.
    expect(result.kept.map((item) => item.name)).toEqual(["a", "b", "big", "d"]);
    expect(result.dropped.map((item) => item.name)).toEqual(["c"]);

    const full = fitAttachments(result.kept, [file("e", 1)], limit);
    expect(full.dropped.map((item) => item.name)).toEqual(["e"]);
  });
});

describe("drafts shared through their thread's node (D486)", () => {
  it("sends text typed here once saved, and not a text taken from another device", () => {
    const sent: unknown[] = [];
    const drafts = createDrafts(memoryStorage(), {
      send: (key, prompt, at) => sent.push({ key, prompt, at: typeof at }),
    });
    drafts.set("k", { prompt: "hello", attachments: [] });
    // The same text again (a composer mounting): nothing new to share.
    drafts.set("k", { prompt: "hello", attachments: [] });
    drafts.flush();
    expect(sent).toEqual([{ key: "k", prompt: "hello", at: "number" }]);

    const seen: string[] = [];
    drafts.follow("k", (draft) => seen.push(draft.prompt));
    const later = (drafts.get("k")?.at ?? 0) + 1;
    expect(drafts.take("k", "from the phone", later)).toBe(true);
    // Older than what is here: ignored.
    expect(drafts.take("k", "stale", 1)).toBe(false);
    drafts.flush();
    expect(seen).toEqual(["from the phone"]);
    expect(drafts.get("k")).toMatchObject({ prompt: "from the phone", at: later });
    expect(sent).toHaveLength(1);

    // Cleared here: the empty text is shared too, so the old one does not come back.
    drafts.set("k", { prompt: "", attachments: [] });
    drafts.flush();
    expect(sent.at(-1)).toEqual({ key: "k", prompt: "", at: "number" });
  });

  it("maps a draft key to its node and the node's key", () => {
    expect(nodeDraftKey(threadDraftKey({ node: "ws://a" }, "t1"))).toEqual({
      target: { node: "ws://a" },
      key: "thread:t1",
    });
    expect(nodeDraftKey(newThreadDraftKey({ node: "ws://a", remote: "n2" }, "p1"))).toEqual({
      target: { node: "ws://a", remote: "n2" },
      key: "project:p1",
    });
    expect(nodeDraftKey("nonsense")).toBeUndefined();
  });
});
