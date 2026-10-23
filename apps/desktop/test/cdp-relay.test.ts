// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/preview/CdpRelay.test.ts.
import { describe, expect, it, vi } from "vite-plus/test";

import { createCdpRelayConnection, type CdpRelayTarget } from "../src/preview/cdp-relay.ts";

const makeTarget = (
  send: CdpRelayTarget["send"],
  setDownloadDirectory: CdpRelayTarget["setDownloadDirectory"] = () => {},
): CdpRelayTarget => ({
  send,
  targetId: async () => "GUEST-TARGET",
  url: () => "http://localhost:4719/",
  title: () => "Fixture",
  userAgent: () => "Electron",
  setDownloadDirectory,
});

/** What the relay writes to the node, and waits until something it expects is written. */
function recorder() {
  const written: Array<Record<string, unknown>> = [];
  const waiters: Array<{ test: () => boolean; resolve: () => void }> = [];
  const write = (raw: string) => {
    written.push(JSON.parse(raw));
    for (const waiter of waiters.filter((each) => each.test())) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  const until = (test: () => boolean) =>
    test() ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ test, resolve }));
  /** Resolves once the replies to `ids` are written. */
  const answered = (...ids: number[]) =>
    until(() => ids.every((id) => written.some((message) => message["id"] === id)));
  return { written, write, until, answered };
}

describe("CDP relay", () => {
  it("announces only the tab's page, under its real target id", async () => {
    const { written, write, until, answered } = recorder();
    const relay = createCdpRelayConnection(makeTarget(vi.fn()), write);
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(JSON.stringify({ id: 2, method: "Target.createTarget", params: {} }));
    await answered(1, 2);
    await until(() => written.some((m) => m["method"] === "Target.attachedToTarget"));
    const attach = written.findIndex((message) => message["id"] === 1);
    expect(written.slice(attach, attach + 2)).toEqual([
      { id: 1, result: {} },
      {
        method: "Target.attachedToTarget",
        params: expect.objectContaining({
          sessionId: "jhin-preview-page",
          targetInfo: expect.objectContaining({ targetId: "GUEST-TARGET", type: "page" }),
        }),
      },
    ]);
    expect(written).toContainEqual({
      id: 2,
      error: expect.objectContaining({ message: expect.stringContaining("createTarget") }),
    });
  });

  it("forwards page commands to the tab and lets a slow one finish last", async () => {
    const pending: Array<() => void> = [];
    const send = vi.fn(
      (method: string) =>
        new Promise<unknown>((resolve) => pending.push(() => resolve({ method }))),
    );
    const { written, write, answered } = recorder();
    const relay = createCdpRelayConnection(makeTarget(send), write);
    relay.receive(
      JSON.stringify({ id: 5, method: "Page.captureScreenshot", sessionId: "jhin-preview-page" }),
    );
    relay.receive(JSON.stringify({ id: 6, method: "DOM.enable", sessionId: "iframe-session" }));
    pending[1]!();
    await answered(6);
    expect(written).toEqual([
      { id: 6, result: { method: "DOM.enable" }, sessionId: "iframe-session" },
    ]);
    pending[0]!();
    await answered(5);
    expect(send).toHaveBeenNthCalledWith(1, "Page.captureScreenshot", {}, undefined);
    expect(send).toHaveBeenNthCalledWith(2, "DOM.enable", {}, "iframe-session");
    expect(written.at(-1)).toEqual({
      id: 5,
      result: { method: "Page.captureScreenshot" },
      sessionId: "jhin-preview-page",
    });
  });

  it("resumes paused child frames, so cross-site iframes run", async () => {
    const send = vi.fn(async () => ({}));
    const { write, answered } = recorder();
    const relay = createCdpRelayConnection(makeTarget(send), write);
    relay.receive(
      JSON.stringify({
        id: 1,
        method: "Runtime.runIfWaitingForDebugger",
        sessionId: "jhin-preview-page",
      }),
    );
    relay.receive(
      JSON.stringify({
        id: 2,
        method: "Runtime.runIfWaitingForDebugger",
        sessionId: "iframe-session",
      }),
    );
    await answered(1, 2);
    expect(send.mock.calls).toEqual([["Runtime.runIfWaitingForDebugger", {}, "iframe-session"]]);
  });

  it("routes tab events to the page session once the page is announced", async () => {
    const { written, write, until } = recorder();
    const relay = createCdpRelayConnection(makeTarget(vi.fn()), write);
    relay.event("Page.loadEventFired", {}, undefined);
    expect(written).toEqual([]);
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    await until(() => written.some((m) => m["method"] === "Target.attachedToTarget"));
    // Electron passes an empty session id for the page's own events.
    relay.event("Page.loadEventFired", { timestamp: 1 }, "");
    relay.event("Runtime.consoleAPICalled", {}, "iframe-session");
    expect(written.slice(-2)).toEqual([
      { method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "jhin-preview-page" },
      { method: "Runtime.consoleAPICalled", params: {}, sessionId: "iframe-session" },
    ]);
  });
});

describe("CDP relay extra sessions", () => {
  it("gives a second page session the page's commands and events", async () => {
    const send = vi.fn(async () => ({}));
    const { written, write, until, answered } = recorder();
    const relay = createCdpRelayConnection(makeTarget(send), write);
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(JSON.stringify({ id: 2, method: "Target.attachToBrowserTarget" }));
    await answered(1, 2);
    await until(() => written.some((m) => m["method"] === "Target.attachedToTarget"));
    const browserSession = (written.find((m) => m["id"] === 2)!["result"] as { sessionId: string })
      .sessionId;
    relay.receive(
      JSON.stringify({
        id: 3,
        method: "Target.attachToTarget",
        params: { targetId: "GUEST-TARGET", flatten: true },
        sessionId: browserSession,
      }),
    );
    relay.receive(
      JSON.stringify({
        id: 4,
        method: "Target.attachToTarget",
        params: { targetId: "SOMETHING-ELSE" },
        sessionId: browserSession,
      }),
    );
    await answered(3, 4);
    const extra = (written.find((m) => m["id"] === 3)!["result"] as { sessionId: string })
      .sessionId;
    expect(written.find((m) => m["id"] === 4)).toHaveProperty("error");
    relay.receive(JSON.stringify({ id: 5, method: "Page.startScreencast", sessionId: extra }));
    await answered(5);
    expect(send).toHaveBeenLastCalledWith("Page.startScreencast", {}, undefined);
    written.length = 0;
    relay.event("Page.screencastFrame", { data: "x" }, undefined);
    expect(written.map((m) => m["sessionId"])).toEqual(["jhin-preview-page", extra]);
  });
});

describe("CDP relay detached sessions", () => {
  // Jhin's own case (D1322): a session the relay invented and then detached is gone.
  it("answers a detached session's commands as not found, without reaching the page", async () => {
    const send = vi.fn(async () => ({}));
    const { written, write, answered } = recorder();
    const relay = createCdpRelayConnection(makeTarget(send), write);
    relay.receive(JSON.stringify({ id: 1, method: "Target.attachToBrowserTarget" }));
    await answered(1);
    const browser = (written.find((m) => m["id"] === 1)!["result"] as { sessionId: string })
      .sessionId;
    relay.receive(
      JSON.stringify({ id: 2, method: "Target.detachFromTarget", params: { sessionId: browser } }),
    );
    relay.receive(JSON.stringify({ id: 3, method: "Runtime.evaluate", sessionId: browser }));
    await answered(2, 3);
    expect(written.find((m) => m["id"] === 3)).toMatchObject({
      error: { message: `Session with given id not found: ${browser}` },
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("CDP relay downloads", () => {
  it("applies the server's download directory and reports downloads on the root session", async () => {
    const send = vi.fn(async () => ({}));
    const directories: Array<string | null> = [];
    const { written, write, until, answered } = recorder();
    const relay = createCdpRelayConnection(
      makeTarget(send, (directory) => directories.push(directory)),
      write,
    );
    relay.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    relay.receive(
      JSON.stringify({
        id: 2,
        method: "Browser.setDownloadBehavior",
        params: {
          behavior: "allowAndName",
          browserContextId: "jhin-preview",
          downloadPath: "/srv/artifacts",
          eventsEnabled: true,
        },
      }),
    );
    await answered(1, 2);
    await until(() => written.some((m) => m["method"] === "Target.attachedToTarget"));
    expect(directories).toEqual(["/srv/artifacts"]);
    expect(send).toHaveBeenCalledWith(
      "Browser.setDownloadBehavior",
      { behavior: "allowAndName", downloadPath: "/srv/artifacts", eventsEnabled: true },
      undefined,
    );
    written.length = 0;
    relay.event("Browser.downloadWillBegin", { guid: "g1", suggestedFilename: "r.csv" }, "");
    expect(written).toEqual([
      { method: "Browser.downloadWillBegin", params: { guid: "g1", suggestedFilename: "r.csv" } },
    ]);
  });
});
