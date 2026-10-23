import type { NodeTarget } from "@jhin/client-api";
import { describe, expect, it } from "vite-plus/test";

import { appendToDraft, restoreIntoDraft, type ComposerDraft } from "../src/lib/composer.ts";
import { editFromHere } from "../src/plugins/chat/history.tsx";
import type { ComposerHandle } from "../src/plugins/chat/services.ts";

/** An uploaded image (D293). */
const image = (name: string, sizeBytes = 10) => ({
  kind: "image" as const,
  id: `att-${name}`,
  name,
  mimeType: "image/png",
  sizeBytes,
});
/** 80 MiB of images: as much as one message takes. */
const ten = Array.from({ length: 10 }, (_, index) => image(`i${index}`, 8 * 1024 * 1024));

describe("Edit from here: the message back in the composer (D223)", () => {
  it("puts the message after the draft, a blank line between, images after the draft's", () => {
    expect(
      restoreIntoDraft(
        { prompt: "typed", attachments: [image("a")] },
        { prompt: "sent", attachments: [image("b")] },
      ),
    ).toEqual({ prompt: "typed\n\nsent", attachments: [image("a"), image("b")] });
    expect(restoreIntoDraft(undefined, { prompt: "sent", attachments: [] })).toEqual({
      prompt: "sent",
      attachments: [],
    });
    expect(
      restoreIntoDraft({ prompt: "  ", attachments: [] }, { prompt: "sent", attachments: [] }),
    ).toEqual({ prompt: "sent", attachments: [] });
    expect(
      restoreIntoDraft({ prompt: "typed", attachments: [] }, { prompt: "", attachments: [] }),
    ).toEqual({ prompt: "typed", attachments: [] });
  });

  it("refuses when the images do not fit, and appending never drops anything", () => {
    const message = { prompt: "x", attachments: [image("b")] };
    expect(restoreIntoDraft({ prompt: "", attachments: ten }, message)).toBeUndefined();
    expect(appendToDraft({ prompt: "", attachments: ten }, message).attachments).toHaveLength(11);
  });
});

/** The command's services, with a node that records the calls it gets. */
function setup(options: {
  draft?: ComposerDraft;
  open?: string;
  confirm?: boolean | "none";
  gone?: boolean;
}) {
  const calls: { method: string; params: unknown }[] = [];
  const stored = new Map<string, ComposerDraft>();
  const restored: ComposerDraft[] = [];
  const toasts: string[] = [];
  const key = "a|thread|t1";
  if (options.draft !== undefined) stored.set(key, options.draft);
  const composer: ComposerHandle = { current: undefined };
  if (options.open !== undefined) {
    composer.current = {
      draftKey: options.open,
      draft: () => options.draft,
      restore: (draft) => restored.push(draft),
      focus: () => undefined,
      insert: () => undefined,
      insertContext: () => "not-now",
      removeContext: () => false,
      insertCitation: () => "not-now",
      toggleModelPicker: () => undefined,
      cycleRuntimeMode: () => undefined,
      togglePlanMode: () => undefined,
      sendAlternate: async () => false,
      steerNext: () => false,
      editLatest: () => false,
      resume: () => false,
    };
  }
  const services = {
    threads: {
      call: async <T>(_target: NodeTarget, method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === "threads.turn" && options.gone === true) {
          throw Object.assign(new Error("The thread shows no turn u2"), { code: "TURN_NOT_FOUND" });
        }
        if (method === "threads.turn") {
          return { input: { text: "sent", attachments: [image("p")] } } as T;
        }
        return {} as T;
      },
    },
    drafts: {
      get: (draftKey: string) => stored.get(draftKey),
      set: (draftKey: string, draft: ComposerDraft) => void stored.set(draftKey, draft),
    },
    composer,
    dialogs:
      options.confirm === "none"
        ? undefined
        : { confirm: async () => (options.confirm as boolean | undefined) ?? true },
    toasts: {
      show: (toast: { title: string }) => {
        toasts.push(toast.title);
        return toast.title;
      },
    },
  };
  const run = (confirmed?: boolean) =>
    editFromHere(services, {
      node: "a",
      threadId: "t1",
      turnId: "u2",
      ...(confirmed === undefined ? {} : { confirmed }),
    });
  return { run, calls, stored, restored, toasts, key, composer };
}

describe("the thread.edit-from-here command (D223)", () => {
  it('offers T3\'s "Revert files too" and asks the node to restore the files (W3, D257)', async () => {
    const { calls } = setup({ open: "a|thread|t1" });
    const asked: { confirmLabel?: string; alternativeLabel?: string }[] = [];
    const services = {
      threads: {
        call: async <T>(_target: NodeTarget, method: string, params?: unknown) => {
          calls.push({ method, params });
          return (
            method === "threads.turn" ? { input: { text: "sent", attachments: [] } } : {}
          ) as T;
        },
      },
      drafts: { get: () => undefined, set: () => undefined },
      composer: { current: undefined } as unknown as Parameters<typeof editFromHere>[0]["composer"],
      dialogs: {
        confirm: async () => true,
        choose: async (options: { confirmLabel?: string; alternativeLabel?: string }) => {
          asked.push(options);
          return "alternative" as const;
        },
      },
      toasts: undefined,
    };
    expect(await editFromHere(services, { node: "a", threadId: "t1", turnId: "u2" })).toEqual({
      edited: true,
    });
    expect(asked).toMatchObject([
      { confirmLabel: "Revert and keep changes", alternativeLabel: "Revert files too" },
    ]);
    expect(calls.at(-1)).toEqual({
      method: "threads.rollback",
      params: { threadId: "t1", beforeTurnId: "u2", restoreFiles: true },
    });
  });

  it("rolls back to before the turn and puts the message into the composer on screen", async () => {
    const { run, calls, restored } = setup({ open: "a|thread|t1" });
    expect(await run()).toEqual({ edited: true });
    expect(calls.map((call) => [call.method, call.params])).toEqual([
      ["threads.turn", { threadId: "t1", turnId: "u2" }],
      ["threads.rollback", { threadId: "t1", beforeTurnId: "u2" }],
    ]);
    expect(restored).toEqual([{ prompt: "sent", attachments: [image("p")] }]);
  });

  it("puts the message into the stored draft when another thread's composer is on screen", async () => {
    const { run, stored, restored, key } = setup({
      open: "a|thread|other",
      draft: { prompt: "typed", attachments: [] },
    });
    expect(await run()).toEqual({ edited: true });
    expect(restored).toEqual([]);
    expect(stored.get(key)).toEqual({ prompt: "typed\n\nsent", attachments: [image("p")] });
  });

  it("refuses before rewinding when the images do not fit beside what the composer holds", async () => {
    const { run, calls, toasts, stored, key } = setup({
      open: "a|thread|t1",
      draft: { prompt: "", attachments: ten },
    });
    expect(await run()).toEqual({ edited: false });
    expect(calls.map((call) => call.method)).toEqual(["threads.turn"]);
    expect(toasts).toEqual([
      "Make room for this message's attachments in the composer before rewinding.",
    ]);
    expect(stored.get(key)?.attachments).toHaveLength(10);
  });

  it("says so when the turn is gone, and rewinds nothing", async () => {
    const { run, calls, toasts } = setup({ gone: true });
    await expect(run()).rejects.toMatchObject({ code: "TURN_NOT_FOUND" });
    expect(calls.map((call) => call.method)).toEqual(["threads.turn"]);
    expect(toasts).toEqual(["Failed to revert thread state."]);
  });

  it("rewinds nothing when cancelled, or when nobody can be asked unless already confirmed", async () => {
    const cancelled = setup({ confirm: false });
    expect(await cancelled.run()).toEqual({ edited: false });
    expect(cancelled.calls.map((call) => call.method)).toEqual(["threads.turn"]);
    const headless = setup({ confirm: "none" });
    expect(await headless.run()).toEqual({ edited: false });
    expect(await headless.run(true)).toEqual({ edited: true });
    expect(headless.calls.map((call) => call.method)).toContain("threads.rollback");
  });
});
