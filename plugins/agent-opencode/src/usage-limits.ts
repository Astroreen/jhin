// OpenCode Go's usage limits (providers.md D1305). Derived from T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md) at eb7b35ac: packages/provider-opencode/src/server/usageLimits.ts.
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";

import type { AgentUsageLimits, AgentUsageWindow } from "@jhin/agent-api";

/** Where OpenCode Go reports an account's usage. */
export const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
/** A read that takes longer fails (T3's 5 seconds). */
const READ_TIMEOUT_MS = 5_000;

const clampPercent = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;

interface GoWindow {
  readonly percent: number;
  readonly resetsAt: string;
}

function goWindow(value: unknown): GoWindow | undefined {
  const { percent, resetsAt } = (value ?? {}) as { percent?: unknown; resetsAt?: unknown };
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
  if (typeof resetsAt !== "string" || Number.isNaN(Date.parse(resetsAt))) return undefined;
  return { percent, resetsAt: new Date(resetsAt).toISOString() };
}

/** The Go key OpenCode signs in with: its auth file's `opencode-go` API key, else `OPENCODE_API_KEY`. */
async function goApiKey(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const dataHome =
    env.XDG_DATA_HOME || Path.join(env.HOME || env.USERPROFILE || Os.homedir(), ".local", "share");
  let contents = env.OPENCODE_AUTH_CONTENT;
  if (!contents) {
    try {
      contents = await Fs.readFile(Path.join(dataHome, "opencode", "auth.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      contents = "{}";
    }
  }
  const auth = JSON.parse(contents) as { "opencode-go"?: { type?: unknown; key?: unknown } };
  const stored = auth?.["opencode-go"];
  // OpenCode lays stored API credentials over the environment's.
  const key =
    stored?.type === "api" && typeof stored.key === "string" ? stored.key : env.OPENCODE_API_KEY;
  return key?.trim() || undefined;
}

/**
 * The OpenCode Go allowance of the node's OpenCode account, as T3 reads it: none without a
 * Go key, for a key without a Go subscription (403) or for a server the config names (it
 * owns its credentials); a read that fails is `probeFailed`.
 */
export async function readOpenCodeGoUsageLimits(input: {
  readonly enabled: boolean;
  readonly serverUrl: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
}): Promise<AgentUsageLimits> {
  const checkedAt = new Date().toISOString();
  const unsupported: AgentUsageLimits = {
    checkedAt,
    windows: [],
    unavailable: { reason: "unsupported" },
  };
  if (!input.enabled || (input.serverUrl?.trim() ?? "") !== "") return unsupported;
  try {
    const apiKey = await goApiKey(input.env);
    if (apiKey === undefined) return unsupported;
    const response = await (input.fetch ?? fetch)(OPENCODE_GO_USAGE_URL, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    // A valid Zen key can exist without a Go subscription.
    if (response.status === 403) return unsupported;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const usage = ((await response.json()) as { usage?: Record<string, unknown> } | null)?.usage;
    const rolling = goWindow(usage?.rolling);
    const weekly = goWindow(usage?.weekly);
    const monthly = goWindow(usage?.monthly);
    if (rolling === undefined || weekly === undefined || monthly === undefined) {
      throw new Error("unexpected answer");
    }
    const windows: AgentUsageWindow[] = [
      {
        id: "go_rolling",
        kind: "session",
        label: "Go · Session",
        windowDurationMins: 5 * 60,
        usedPercent: clampPercent(rolling.percent),
        resetsAt: rolling.resetsAt,
      },
      {
        id: "go_weekly",
        kind: "weekly",
        label: "Go · Weekly",
        windowDurationMins: 7 * 24 * 60,
        usedPercent: clampPercent(weekly.percent),
        resetsAt: weekly.resetsAt,
      },
      {
        id: "go_monthly",
        kind: "monthly",
        label: "Go · Monthly",
        usedPercent: clampPercent(monthly.percent),
        resetsAt: monthly.resetsAt,
      },
    ];
    return { checkedAt, windows };
  } catch {
    return {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed", message: "OpenCode Go could not read usage." },
    };
  }
}
