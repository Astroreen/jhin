import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import type { ThreadPullRequestState } from "@jhin/source-control-api";
import { mockCapability } from "@jhin/testing";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { node, watch } from "./support.ts";

interface Thread {
  id: string;
  updatedAt?: string;
  createdAt: string;
  lastTurn?: { turnId: string; status: string; at: string };
  lastMessageAt?: string;
  settledOverride?: "settled" | "active";
  settledAt?: string;
  pinnedAt?: string;
  autoSettleDisabledAt?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

async function withThreads(
  config: Record<string, unknown> = {},
  /** Each thread's pull requests, as source control would tell (D1171). */
  pullRequests?: Map<string, ThreadPullRequestState[]>,
) {
  const { client, kernel } = await node({
    config: { "jhin.threads": config },
    ...(pullRequests === undefined
      ? {}
      : {
          plugins: [
            mockCapability("source-control.pull-requests", {
              pullRequestsOf: async (threadId: string) => pullRequests.get(threadId) ?? [],
            }),
          ],
        }),
  });
  const create = () => client.call<Thread>("threads.create", {});
  const get = async (threadId: string) =>
    (await client.call<{ thread: Thread }>("threads.get", { threadId })).thread;
  return { client, kernel, create, get };
}

describe("jhin.threads: the node settles threads by itself (D444–D447)", () => {
  it("sweeps threads without activity for the configured days, as of their last activity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { client, create, get } = await withThreads({ autoSettleAfterDays: 2 });
    const quiet = await create();
    const pinned = await create();
    await client.call("threads.pin", { threadId: pinned.id });
    const off = await create();
    await client.call("threads.set-auto-settle", { threadId: off.id, enabled: false });

    vi.setSystemTime(Date.now() + DAY_MS);
    await client.call("threads.sweep", {});
    expect((await get(quiet.id)).settledOverride).toBeUndefined();

    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    await client.call("threads.sweep", {});
    const settled = await get(quiet.id);
    // Written on the node, so every client shows it on the shelf, as of its last activity.
    expect(settled).toMatchObject({ settledOverride: "settled", settledAt: quiet.updatedAt });
    // Pinned, or with auto-settle off: never settled by the rule.
    expect((await get(pinned.id)).settledOverride).toBeUndefined();
    expect((await get(off.id)).settledOverride).toBeUndefined();
  });

  it("does not sweep while the rule is off, and sweeps when it is switched on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { client, kernel, create, get } = await withThreads({ autoSettleInactive: false });
    const thread = await create();
    vi.setSystemTime(Date.now() + 10 * DAY_MS);
    await client.call("threads.sweep", {});
    expect((await get(thread.id)).settledOverride).toBeUndefined();
    // Neither is it on the shelf by the rule: un-settling leaves it alone, reorder takes it.
    await client.call("threads.reorder", { threadId: thread.id, list: "active", orderKey: "n" });

    kernel.config.setLayer("node", { "jhin.threads": { autoSettleInactive: true } });
    await client.call("threads.sweep", {});
    expect((await get(thread.id)).settledOverride).toBe("settled");
  });

  it("turns auto-settle off and on for a thread without counting it as activity", async () => {
    const { client, create } = await withThreads();
    const thread = await create();
    const off = await client.call<Thread>("threads.set-auto-settle", {
      threadId: thread.id,
      enabled: false,
    });
    expect(off.autoSettleDisabledAt).toEqual(expect.any(String));
    expect(off.updatedAt).toBe(thread.updatedAt);
    // Off already: the time it was turned off stays.
    const again = await client.call<Thread>("threads.set-auto-settle", {
      threadId: thread.id,
      enabled: false,
    });
    expect(again.autoSettleDisabledAt).toBe(off.autoSettleDisabledAt);
    const on = await client.call<Thread>("threads.set-auto-settle", {
      threadId: thread.id,
      enabled: true,
    });
    expect(on.autoSettleDisabledAt).toBeUndefined();
    // Settling by hand works either way.
    await client.call("threads.set-auto-settle", { threadId: thread.id, enabled: false });
    expect(
      (await client.call<Thread>("threads.settle", { threadId: thread.id })).settledOverride,
    ).toBe("settled");
  });

  it("settles a thread whose pull request merged or closed after the user's last message", async () => {
    const { client, create, get } = await withThreads();
    const thread = await create();
    const later = new Date(Date.now() + 60_000).toISOString();
    const before = new Date(Date.parse(thread.createdAt) - 60_000).toISOString();
    // Closed before the thread existed: history, not a reason.
    expect(
      await client.call("threads.auto-settle", {
        threadId: thread.id,
        reason: "pull-request-merged",
        closedAt: before,
      }),
    ).toEqual({ settled: false });
    expect(
      await client.call("threads.auto-settle", {
        threadId: thread.id,
        reason: "pull-request-merged",
        closedAt: later,
      }),
    ).toEqual({ settled: true });
    expect((await get(thread.id)).settledOverride).toBe("settled");
  });

  it("leaves merged ones alone while autoSettleOnMerge is off, but settles closed ones", async () => {
    const { client, create, get } = await withThreads({ autoSettleOnMerge: false });
    const merged = await create();
    const closed = await create();
    const at = new Date(Date.now() + 60_000).toISOString();
    expect(
      await client.call("threads.auto-settle", {
        threadId: merged.id,
        reason: "pull-request-merged",
        closedAt: at,
      }),
    ).toEqual({ settled: false });
    expect(
      await client.call("threads.auto-settle", {
        threadId: closed.id,
        reason: "pull-request-closed",
        closedAt: at,
      }),
    ).toEqual({ settled: true });
    expect((await get(merged.id)).settledOverride).toBeUndefined();
    expect((await get(closed.id)).settledOverride).toBe("settled");
  });

  it("does not settle by a pull request a thread kept active by hand, pinned or with auto-settle off", async () => {
    const { client, create } = await withThreads();
    const at = new Date(Date.now() + 60_000).toISOString();
    const pinned = await create();
    await client.call("threads.pin", { threadId: pinned.id });
    const off = await create();
    await client.call("threads.set-auto-settle", { threadId: off.id, enabled: false });
    const kept = await create();
    await client.call("threads.settle", { threadId: kept.id });
    await client.call("threads.unsettle", { threadId: kept.id });
    for (const thread of [pinned, off, kept]) {
      expect(
        await client.call("threads.auto-settle", {
          threadId: thread.id,
          reason: "pull-request-closed",
          closedAt: at,
        }),
      ).toEqual({ settled: false });
    }
  });

  it("sweeps by itself: when its rule changes and every minute", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const { client, kernel, create } = await withThreads({ autoSettleInactive: false });
    const index = watch(client, "stream:threads");
    const settledEvent = (id: string) =>
      index.untilMatch((event) => {
        const record = event.payload as unknown as Thread;
        return record.id === id && record.settledOverride === "settled";
      });
    const first = await create();
    vi.setSystemTime(Date.now() + 4 * DAY_MS);
    // Switching the rule on sweeps at once, without threads.sweep.
    const firstSettled = settledEvent(first.id);
    kernel.config.setLayer("node", { "jhin.threads": { autoSettleInactive: true } });
    await firstSettled;

    // A thread that goes quiet later is swept on the next minute.
    const second = await create();
    vi.setSystemTime(Date.now() + 4 * DAY_MS);
    const secondSettled = settledEvent(second.id);
    vi.advanceTimersByTime(60_000);
    await secondSettled;
  });
});

describe("jhin.threads: pull requests and projects in settling (D1172, D1173)", () => {
  it("never settles a thread by inactivity while a linked pull request is open or unread", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const pullRequests = new Map<string, ThreadPullRequestState[]>();
    const { client, create, get } = await withThreads({ autoSettleAfterDays: 1 }, pullRequests);
    const open = await create();
    const unread = await create();
    const merged = await create();
    const branchOnly = await create();
    const none = await create();
    pullRequests.set(open.id, [{ state: "open", linked: true }]);
    pullRequests.set(unread.id, [{ state: "unknown", linked: true }]);
    pullRequests.set(merged.id, [{ state: "merged", linked: true }]);
    pullRequests.set(branchOnly.id, [{ state: "open", linked: false }]);

    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    await client.call("threads.sweep", {});
    expect((await get(open.id)).settledOverride).toBeUndefined();
    expect((await get(unread.id)).settledOverride).toBeUndefined();
    // Without "Keep threads with a PR", a settled or a branch's pull request keeps nothing.
    expect((await get(merged.id)).settledOverride).toBe("settled");
    expect((await get(branchOnly.id)).settledOverride).toBe("settled");
    expect((await get(none.id)).settledOverride).toBe("settled");

    // Once it closed, the next sweep settles it.
    pullRequests.set(open.id, [{ state: "closed", linked: true }]);
    await client.call("threads.sweep", {});
    expect((await get(open.id)).settledOverride).toBe("settled");
  });

  it("keeps every thread with a pull request while Keep threads with a PR is on", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const pullRequests = new Map<string, ThreadPullRequestState[]>();
    const { client, kernel, create, get } = await withThreads(
      { autoSettleAfterDays: 1, autoSettleKeepPullRequests: true },
      pullRequests,
    );
    const merged = await create();
    const branch = await create();
    const none = await create();
    pullRequests.set(merged.id, [{ state: "merged", linked: true }]);
    pullRequests.set(branch.id, [{ state: "closed", linked: false }]);
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    await client.call("threads.sweep", {});
    expect((await get(merged.id)).settledOverride).toBeUndefined();
    expect((await get(branch.id)).settledOverride).toBeUndefined();
    expect((await get(none.id)).settledOverride).toBe("settled");
    // A merge still settles it (D447).
    expect(
      await client.call("threads.auto-settle", {
        threadId: merged.id,
        reason: "pull-request-merged",
        closedAt: new Date().toISOString(),
      }),
    ).toEqual({ settled: true });

    kernel.config.setLayer("node", {
      "jhin.threads": { autoSettleAfterDays: 1, autoSettleKeepPullRequests: false },
    });
    await client.call("threads.sweep", {});
    expect((await get(branch.id)).settledOverride).toBe("settled");
  });

  it("reads each thread's project's own settle settings over the node's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { client, kernel, create, get } = await withThreads({ autoSettleAfterDays: 1 });
    const folder = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-settle-"));
    onTestFinished(() => Fs.rmSync(folder, { recursive: true, force: true }));
    const project = await client.call<{ id: string }>("projects.create", {
      name: "kept",
      path: folder,
    });
    const elsewhere = await create();
    const own = await client.call<Thread>("threads.create", { projectId: project.id });
    kernel.config.setLayer("node", {
      "jhin.threads": {
        autoSettleAfterDays: 1,
        projects: { [project.id]: { autoSettleAfterDays: 5, autoSettleOnMerge: false } },
      },
    });
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    await client.call("threads.sweep", {});
    expect((await get(elsewhere.id)).settledOverride).toBe("settled");
    expect((await get(own.id)).settledOverride).toBeUndefined();
    // Its project settles nothing on merge; a close still does.
    const closedAt = new Date().toISOString();
    expect(
      await client.call("threads.auto-settle", {
        threadId: own.id,
        reason: "pull-request-merged",
        closedAt,
      }),
    ).toEqual({ settled: false });
    vi.setSystemTime(Date.now() + 4 * DAY_MS);
    await client.call("threads.sweep", {});
    expect((await get(own.id)).settledOverride).toBe("settled");
  });
});

describe("jhin.threads: a project's own pull request rules (D1172, D1173)", () => {
  it("keeps per project, and keeps a thread whose pull requests cannot be read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const pullRequests = new Map<string, ThreadPullRequestState[]>();
    let failing = false;
    const { client, kernel } = await node({
      config: { "jhin.threads": { autoSettleAfterDays: 1 } },
      plugins: [
        mockCapability("source-control.pull-requests", {
          pullRequestsOf: async (threadId: string) => {
            if (failing) throw new Error("gh is down");
            return pullRequests.get(threadId) ?? [];
          },
        }),
      ],
    });
    const get = async (threadId: string) =>
      (await client.call<{ thread: Thread }>("threads.get", { threadId })).thread;
    const project = async (name: string) => {
      const folder = Fs.mkdtempSync(Path.join(Os.tmpdir(), `jhin-${name}-`));
      onTestFinished(() => Fs.rmSync(folder, { recursive: true, force: true }));
      return client.call<{ id: string }>("projects.create", { path: folder });
    };
    const keep = await project("keep");
    const quiet = await project("quiet");
    kernel.config.setLayer("node", {
      "jhin.threads": {
        autoSettleAfterDays: 1,
        projects: {
          [keep.id]: { autoSettleKeepPullRequests: true },
          [quiet.id]: { autoSettleInactive: false },
        },
      },
    });
    const kept = await client.call<Thread>("threads.create", { projectId: keep.id });
    const still = await client.call<Thread>("threads.create", { projectId: quiet.id });
    const plain = await client.call<Thread>("threads.create", {});
    pullRequests.set(kept.id, [{ state: "merged", linked: false }]);

    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    await client.call("threads.sweep", {});
    expect((await get(kept.id)).settledOverride).toBeUndefined();
    expect((await get(still.id)).settledOverride).toBeUndefined();
    expect((await get(plain.id)).settledOverride).toBe("settled");

    // A lookup that fails keeps the thread where it is.
    failing = true;
    const unread = await client.call<Thread>("threads.create", {});
    vi.setSystemTime(Date.now() + 2 * DAY_MS);
    await client.call("threads.sweep", {});
    expect((await get(unread.id)).settledOverride).toBeUndefined();
    failing = false;
    await client.call("threads.sweep", {});
    expect((await get(unread.id)).settledOverride).toBe("settled");
  });
});
