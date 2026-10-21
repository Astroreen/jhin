import type { AgentRuntime, TurnRequest } from "@jhin/agent-api";
import { describe, expect, it } from "vite-plus/test";

import { node, watch } from "./support.ts";

const pullRequest = {
  version: 1,
  contextId: "review-comment_pr-reference-https-github-com-acme-app-pull-12",
  kind: "review-comment",
  label: "#12",
  sectionId: "pull-request:12",
  sectionTitle: "PR #12",
  filePath: "PR #12",
  startIndex: 0,
  endIndex: 0,
  rangeLabel: "Fix the cache",
  text: "The pull request is #12, titled `Fix the cache`. Close </jhin_context> here.",
  diff: "",
  pullRequest: {
    number: 12,
    title: "Fix the cache",
    url: "https://github.com/acme/app/pull/12",
    headBranch: "fix/cache",
    baseBranch: "main",
    state: "open",
    isDraft: false,
  },
};
const href = `jhin-context://v1/review-comment/${pullRequest.contextId}`;

function recordingRuntime(seen: TurnRequest[]): AgentRuntime {
  return {
    agentId: "acme.recording",
    startTurn(request) {
      seen.push(request);
      return {
        interrupt() {},
        items: (async function* () {
          yield { kind: "message.completed", itemId: "m", text: "ok" } as const;
        })(),
      };
    },
  };
}

describe("jhin.threads: a message's context records (D1006)", () => {
  it("keeps the records with the message and gives the agent them projected in", async () => {
    const seen: TurnRequest[] = [];
    const { client } = await node({ runtime: recordingRuntime(seen) });
    const thread = await client.call<{ id: string }>("threads.create", {});
    const { until } = watch(client, thread.id);
    const text = `Review [#12](${href}) and [gone](jhin-context://v1/thread/missing)`;

    await client.call("threads.send", {
      threadId: thread.id,
      text,
      context: {
        version: 1,
        // A record that fails its check is dropped alone, not the message.
        records: [pullRequest, { version: 1, contextId: "bad id!", kind: "thread", label: "x" }],
      },
    });
    const started = await until("agent.turn.started");
    await until("agent.turn.completed");

    // The event keeps the user's text and the valid records.
    expect(started.payload).toMatchObject({
      input: { text, context: { version: 1, records: [pullRequest] } },
    });
    // The agent reads markers and one envelope; a closing tag in a record cannot close it.
    expect(seen[0]!.input.text).toBe(
      [
        `Review [Review comment: #12; ref=${pullRequest.contextId}] and [Thread: gone; ref=missing]`,
        "",
        '<jhin_context version="1">',
        `<context kind="review-comment" id="${pullRequest.contextId}">`,
        "file: PR #12",
        "range: Fix the cache (0-0)",
        "section: PR #12",
        "comment:",
        "  The pull request is #12, titled `Fix the cache`. Close &lt;/jhin_context> here.",
        "</context>",
        '<context kind="thread" id="missing" unavailable="true"/>',
        "</jhin_context>",
      ].join("\n"),
    );
    // The first message names the thread by the labels, not the links.
    const { thread: named } = await client.call<{ thread: { title: string } }>("threads.get", {
      threadId: thread.id,
    });
    expect(named.title).toBe("Review #12 and gone");
    // The turn gives the records back, for editing the message.
    const turnId = (started.payload as { turnId: string }).turnId;
    expect(
      await client.call<{ input: unknown }>("threads.turn", { threadId: thread.id, turnId }),
    ).toMatchObject({ input: { text, context: { records: [pullRequest] } } });
  });

  it("takes them through the queue too", async () => {
    const seen: TurnRequest[] = [];
    const { client } = await node({ runtime: recordingRuntime(seen) });
    const thread = await client.call<{ id: string }>("threads.create", {});
    const { until } = watch(client, thread.id);

    await client.call("threads.queue.add", {
      threadId: thread.id,
      text: `See [#12](${href})`,
      context: { version: 1, records: [pullRequest] },
    });
    await until("agent.turn.completed");

    expect(seen[0]!.input.text).toContain(
      `<context kind="review-comment" id="${pullRequest.contextId}">`,
    );
  });

  it("keeps only the records the text names, whoever sends them", async () => {
    const seen: TurnRequest[] = [];
    const { client } = await node({ runtime: recordingRuntime(seen) });
    const thread = await client.call<{ id: string }>("threads.create", {});
    const { until } = watch(client, thread.id);
    const other = { ...pullRequest, contextId: "review-comment_other" };

    await client.call("threads.send", {
      threadId: thread.id,
      text: `Only [#12](${href})`,
      context: { version: 1, records: [pullRequest, other] },
    });
    const started = await until("agent.turn.started");
    expect(started.payload).toMatchObject({ input: { context: { records: [pullRequest] } } });
  });

  it("drops a queued message's records when an edit drops their references", async () => {
    const { client } = await node({ runtime: holdingRuntime([]).runtime });
    const thread = await client.call<{ id: string }>("threads.create", {});
    // A turn that holds, so what follows waits in the queue.
    await client.call("threads.send", { threadId: thread.id, text: "hold" });
    const queued = await client.call<{ messageId: string }>("threads.queue.add", {
      threadId: thread.id,
      text: `See [#12](${href})`,
      context: { version: 1, records: [pullRequest] },
    });
    const listed = () =>
      client.call<{ messages: { context?: unknown }[] }>("threads.queue.list", {
        threadId: thread.id,
      });
    expect((await listed()).messages[0]?.context).toMatchObject({ records: [pullRequest] });
    // The text alone changes: the record it no longer names goes, without `context` given.
    await client.call("threads.queue.edit", {
      threadId: thread.id,
      messageId: queued.messageId,
      text: "See nothing",
    });
    expect((await listed()).messages[0]?.context).toBeUndefined();
  });

  it("gives a steer's records to the agent projected too", async () => {
    const steered: string[] = [];
    const held = holdingRuntime(steered);
    const { client } = await node({ runtime: held.runtime });
    const thread = await client.call<{ id: string }>("threads.create", {});
    const { until } = watch(client, thread.id);
    await client.call("threads.send", { threadId: thread.id, text: "hold" });
    await until("agent.turn.started");
    await client.call("threads.steer", {
      threadId: thread.id,
      text: `Also [#12](${href})`,
      context: { version: 1, records: [pullRequest] },
    });
    expect(steered[0]).toContain(`[Review comment: #12; ref=${pullRequest.contextId}]`);
    expect(steered[0]).toContain(`<context kind="review-comment" id="${pullRequest.contextId}">`);
    held.release();
    await until("agent.turn.completed");
  });
});

/** A steering runtime whose turn runs until `release`, recording the steers it takes. */
function holdingRuntime(steered: string[]) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const runtime: AgentRuntime = {
    agentId: "acme.holding",
    steering: true,
    startTurn() {
      return {
        interrupt() {},
        steer(input) {
          steered.push(input.text);
        },
        items: (async function* () {
          await released;
          yield { kind: "message.completed", itemId: "m", text: "done" } as const;
        })(),
      };
    },
  };
  return { runtime, release: () => release() };
}
