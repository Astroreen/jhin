import * as Fs from "node:fs";
import * as Os from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  Config,
  OPENCODE_GO_USAGE_URL,
  createOpenCodeRuntime,
  readOpenCodeGoUsageLimits,
} from "../src/index.ts";
import { createServerOwner } from "../src/server.ts";
import { memorySessions } from "./support.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) Fs.rmSync(dir, { recursive: true, force: true });
});

/** A data home whose OpenCode auth file holds `auth`. */
function dataHome(auth: unknown): string {
  const dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-opencode-go-"));
  dirs.push(dir);
  Fs.mkdirSync(Path.join(dir, "opencode"));
  Fs.writeFileSync(Path.join(dir, "opencode", "auth.json"), JSON.stringify(auth));
  return dir;
}

const usage = {
  usage: {
    rolling: { percent: 12.5, resetsAt: "2030-01-01T02:00:00Z" },
    weekly: { percent: 40, resetsAt: "2030-01-05T00:00:00Z" },
    monthly: { percent: 101, resetsAt: "2030-02-01T00:00:00Z" },
  },
};

/** A fetch that answers OpenCode Go's usage endpoint and records what it was asked. */
function goServer(answer: () => Response) {
  const asked: { url: string; authorization: string | null }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    asked.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    return answer();
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

describe("jhin.agent-opencode: OpenCode Go usage limits (D1305)", () => {
  it("reads the Go key's session, weekly and monthly allowance", async () => {
    const go = goServer(() => Response.json(usage));
    const limits = await readOpenCodeGoUsageLimits({
      enabled: true,
      serverUrl: undefined,
      env: { XDG_DATA_HOME: dataHome({ "opencode-go": { type: "api", key: " go-key " } }) },
      fetch: go.fetch,
    });
    expect(go.asked).toEqual([{ url: OPENCODE_GO_USAGE_URL, authorization: "Bearer go-key" }]);
    expect(limits).toEqual({
      checkedAt: expect.any(String),
      windows: [
        {
          id: "go_rolling",
          kind: "session",
          label: "Go · Session",
          windowDurationMins: 300,
          usedPercent: 12.5,
          resetsAt: "2030-01-01T02:00:00.000Z",
        },
        {
          id: "go_weekly",
          kind: "weekly",
          label: "Go · Weekly",
          windowDurationMins: 10_080,
          usedPercent: 40,
          resetsAt: "2030-01-05T00:00:00.000Z",
        },
        {
          id: "go_monthly",
          kind: "monthly",
          label: "Go · Monthly",
          usedPercent: 100,
          resetsAt: "2030-02-01T00:00:00.000Z",
        },
      ],
    });
  });

  it("has none without a Go key, without a subscription, or on a configured server", async () => {
    const go = goServer(() => new Response("", { status: 403 }));
    const unsupported = {
      checkedAt: expect.any(String),
      windows: [],
      unavailable: { reason: "unsupported" },
    };
    // No auth file and no OPENCODE_API_KEY: nothing is asked.
    const empty = Fs.mkdtempSync(Path.join(Os.tmpdir(), "jhin-opencode-go-"));
    dirs.push(empty);
    expect(
      await readOpenCodeGoUsageLimits({
        enabled: true,
        serverUrl: undefined,
        env: { XDG_DATA_HOME: empty },
        fetch: go.fetch,
      }),
    ).toEqual(unsupported);
    expect(go.asked).toEqual([]);
    // The environment's key, when the auth file stores none; a Zen key without Go is 403.
    expect(
      await readOpenCodeGoUsageLimits({
        enabled: true,
        serverUrl: undefined,
        env: { XDG_DATA_HOME: empty, OPENCODE_API_KEY: "zen-key" },
        fetch: go.fetch,
      }),
    ).toEqual(unsupported);
    expect(go.asked.map((entry) => entry.authorization)).toEqual(["Bearer zen-key"]);
    expect(
      await readOpenCodeGoUsageLimits({
        enabled: true,
        serverUrl: "http://127.0.0.1:4096",
        env: { OPENCODE_API_KEY: "zen-key" },
        fetch: go.fetch,
      }),
    ).toEqual(unsupported);
    expect(go.asked).toHaveLength(1);
  });

  it("reads the key OpenCode would: its auth content, else the environment's key", async () => {
    const go = goServer(() => Response.json(usage));
    await readOpenCodeGoUsageLimits({
      enabled: true,
      serverUrl: undefined,
      env: {
        OPENCODE_AUTH_CONTENT: JSON.stringify({ "opencode-go": { type: "api", key: "inline" } }),
        OPENCODE_API_KEY: "env-key",
      },
      fetch: go.fetch,
    });
    // A stored entry that is no API key (an OAuth sign-in) leaves the environment's.
    await readOpenCodeGoUsageLimits({
      enabled: true,
      serverUrl: undefined,
      env: {
        XDG_DATA_HOME: dataHome({ "opencode-go": { type: "oauth", access: "x" } }),
        OPENCODE_API_KEY: "env-key",
      },
      fetch: go.fetch,
    });
    expect(go.asked.map((entry) => entry.authorization)).toEqual([
      "Bearer inline",
      "Bearer env-key",
    ]);
    // Disabled: nothing is read.
    expect(
      (
        await readOpenCodeGoUsageLimits({
          enabled: false,
          serverUrl: undefined,
          env: { OPENCODE_API_KEY: "env-key" },
          fetch: go.fetch,
        })
      ).unavailable,
    ).toEqual({ reason: "unsupported" });
    expect(go.asked).toHaveLength(2);
  });

  it("fails a read of a broken auth file, an odd answer or one that never comes", async () => {
    const failed = {
      checkedAt: expect.any(String),
      windows: [],
      unavailable: { reason: "probeFailed", message: "OpenCode Go could not read usage." },
    };
    const go = goServer(() => Response.json({ usage: { rolling: {} } }));
    expect(
      await readOpenCodeGoUsageLimits({
        enabled: true,
        serverUrl: undefined,
        env: { OPENCODE_AUTH_CONTENT: "{not json" },
        fetch: go.fetch,
      }),
    ).toEqual(failed);
    expect(
      await readOpenCodeGoUsageLimits({
        enabled: true,
        serverUrl: undefined,
        env: { OPENCODE_API_KEY: "go-key", XDG_DATA_HOME: dataHome({}) },
        fetch: go.fetch,
      }),
    ).toEqual(failed);
    // A read that is aborted (its 5 s deadline) fails the same way.
    const aborted = (async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof fetch;
    expect(
      await readOpenCodeGoUsageLimits({
        enabled: true,
        serverUrl: undefined,
        env: { OPENCODE_API_KEY: "go-key", XDG_DATA_HOME: dataHome({}) },
        fetch: aborted,
      }),
    ).toEqual(failed);
  });

  it("says a failed read failed, and the runtime reads again on the next look", async () => {
    let answers = 0;
    const go = goServer(() =>
      answers++ === 0 ? new Response("", { status: 500 }) : Response.json(usage),
    );
    const config = Config.parse({ enabled: true });
    const env = { XDG_DATA_HOME: dataHome({ "opencode-go": { type: "api", key: "go-key" } }) };
    const opencode = createOpenCodeRuntime({
      server: createServerOwner({ settings: () => config, env: () => env, idleMs: () => 0 }),
      sessions: memorySessions().store,
      config: () => config,
      env: () => env,
      fetch: go.fetch,
    });
    expect(await opencode.usageLimits!()).toEqual({
      checkedAt: expect.any(String),
      windows: [],
      unavailable: { reason: "probeFailed", message: "OpenCode Go could not read usage." },
    });
    expect((await opencode.usageLimits!())?.windows).toHaveLength(3);
    // Fresh: answered from the last read.
    await opencode.usageLimits!();
    expect(go.asked).toHaveLength(2);
    opencode.dispose();
  });

  it("shares a read between looks, and reads again once a window has reset", async () => {
    let answer!: (response: Response) => void;
    const answers: Response[] = [];
    const go = goServer(() => answers.shift()!);
    const config = Config.parse({ enabled: true });
    const env = { XDG_DATA_HOME: dataHome({ "opencode-go": { type: "api", key: "go-key" } }) };
    const pending = new Promise<Response>((resolve) => (answer = resolve));
    const opencode = createOpenCodeRuntime({
      server: createServerOwner({ settings: () => config, env: () => env, idleMs: () => 0 }),
      sessions: memorySessions().store,
      config: () => config,
      env: () => env,
      fetch: (async (url: string, init?: RequestInit) => {
        if (go.asked.length === 0) {
          await go.fetch(url, init).catch(() => undefined);
          return pending;
        }
        return go.fetch(url, init);
      }) as typeof fetch,
    });
    const first = opencode.usageLimits!();
    const second = opencode.usageLimits!();
    // The rolling window already reset: the next look reads again.
    answer(
      Response.json({
        usage: { ...usage.usage, rolling: { percent: 99, resetsAt: "2000-01-01T00:00:00Z" } },
      }),
    );
    expect(await first).toBe(await second);
    answers.push(Response.json(usage));
    expect((await opencode.usageLimits!())?.windows[0]?.usedPercent).toBe(12.5);
    expect(go.asked).toHaveLength(2);
    opencode.dispose();
  });
});
