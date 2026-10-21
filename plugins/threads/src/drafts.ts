import { createMemoryStreams, type LiveStreams } from "@jhin/rpc";
import { z, type PluginContext } from "@jhin/sdk";
import type { Json, KeyValueStore } from "@jhin/storage-api";

/** The live stream a node's clients follow for draft changes (docs/plans/config-ui.md D486). */
const DRAFTS_STREAM = "threads/drafts";
const NAMESPACE = "jhin.threads.drafts";

/** A thread's draft (`thread:<id>`), or a new thread's in a project (`project:<id>`). */
const DraftKey = z.string().regex(/^(thread|project):[^\s]{1,200}$/);
const Draft = z.object({
  /** The text; empty when the draft was cleared, kept so an older text cannot come back. */
  prompt: z.string().max(100_000),
  /** When it was typed (ms on the typing device); the later one wins. */
  at: z.number().int().nonnegative(),
});
type Draft = z.output<typeof Draft>;

/**
 * Drafts kept on the node of their thread, so they follow it to every device
 * (D486). Text only: pasted images stay where they were pasted (D54).
 */
export function registerDrafts(
  context: PluginContext,
  kv: KeyValueStore,
  live: LiveStreams | undefined,
): void {
  const streams = createMemoryStreams({ log: context.log });
  /** The set in flight per key, so the next one waits for it. */
  const queues = new Map<string, Promise<void>>();
  // Nothing is kept: a client reads the draft when its composer opens.
  if (live !== undefined) {
    context.subscriptions.add(
      live.serve(DRAFTS_STREAM, streams, { permissions: ["threads.read"] }),
    );
  }
  context.commands.register({
    name: "threads.draft.get",
    description:
      "The draft of a thread (thread:<id>) or of a new thread in a project (project:<id>), as the last device that typed it left it (D486)",
    input: z.object({ key: DraftKey }),
    output: Draft.nullable(),
    permissions: ["threads.read"],
    handler: async ({ key }) => {
      const value = Draft.safeParse(await kv.get(NAMESPACE, key));
      return value.success ? value.data : null;
    },
  });
  context.commands.register({
    name: "threads.draft.set",
    description: "Keeps a draft for every device; an older one than what is kept is ignored (D486)",
    input: z.object({ key: DraftKey }).extend(Draft.shape),
    output: z.object({ applied: z.boolean() }),
    permissions: ["threads.write"],
    // One key's sets run in turn: two read-then-write runs must not interleave,
    // or an older text could be written last.
    handler: ({ key, prompt, at }) => {
      const run = (queues.get(key) ?? Promise.resolve()).then(async () => {
        const kept = Draft.safeParse(await kv.get(NAMESPACE, key));
        if (kept.success && kept.data.at >= at) return { applied: false };
        const draft: Draft = { prompt, at };
        await kv.set(NAMESPACE, key, draft as unknown as Json);
        streams.append(DRAFTS_STREAM, "threads.draft.changed", { key, ...draft });
        streams.clear(DRAFTS_STREAM);
        return { applied: true };
      });
      const settled = run.then(
        () => undefined,
        () => undefined,
      );
      queues.set(key, settled);
      void settled.then(() => {
        if (queues.get(key) === settled) queues.delete(key);
      });
      return run;
    },
  });
}
