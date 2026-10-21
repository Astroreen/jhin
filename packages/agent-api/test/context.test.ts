import { describe, expect, it } from "vite-plus/test";

import {
  collectContextReferences,
  formatContextReference,
  historyTranscript,
  referencedContext,
  ThreadEvents,
  toKindScopedContextId,
  type ThreadContextRecord,
} from "../src/index.ts";

const thread: ThreadContextRecord = {
  version: 1,
  kind: "thread",
  contextId: toKindScopedContextId("thread", "t-2"),
  label: "Fix the cache",
  nodeId: "node-1",
  threadId: "t-2",
  title: "Fix the cache",
};

describe("message context records (D1006)", () => {
  it("names a record by a reference link, with T3's label rules and ids", () => {
    const reference = formatContextReference({ ...thread, label: "Fix [the]\ncache" });
    expect(reference).toBe("[Fix the cache](jhin-context://v1/thread/thread_t-2)");
    // An id that is not one already gets a slug and a digest.
    expect(toKindScopedContextId("review-comment", "pr-reference:https://x/pull/1")).toMatch(
      /^review-comment_pr-reference-https-x-pull-1-[0-9a-f]{16}$/,
    );
    expect(collectContextReferences(`see ${reference}.`)).toMatchObject([
      { kind: "thread", contextId: "thread_t-2", label: "Fix the cache", start: 4 },
    ]);
  });

  it("sends only the records the text still names", () => {
    const other = { ...thread, contextId: "thread_t-3" };
    expect(referencedContext(`a ${formatContextReference(thread)}`, [thread, other])).toEqual({
      version: 1,
      records: [thread],
    });
    expect(referencedContext("no links", [thread])).toBeUndefined();
  });

  it("gives a joining agent the messages as their agent read them", () => {
    const text = `Look at ${formatContextReference(thread)}`;
    const transcript = historyTranscript([
      {
        seq: 1,
        stream: "s",
        at: "t",
        type: ThreadEvents.turnStarted,
        payload: {
          turnId: "a",
          agentId: "x",
          input: { text, context: { version: 1, records: [thread] } },
        },
      },
    ]);
    expect(transcript).toContain("User: Look at [Thread: Fix the cache; ref=thread_t-2]");
    expect(transcript).toContain("threadId: t-2");
  });
});
