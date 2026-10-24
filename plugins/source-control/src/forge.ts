// Forges follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md): packages/shared/src/sourceControl.ts
// (detectSourceControlProviderFromRemoteUrl: which host is which forge), the change request
// terminology of client-runtime's source control clients, and apps/server/src/git/GitManager.ts
// (resolveBranchHeadContext, matchesBranchHeadContext: a fork's pull request is told apart
// from a same-named branch of another repository).
import {
  parsePullRequestUrl,
  type ChangeRequestTerminology,
  type PullRequest,
} from "@jhin/source-control-api";

import { SpawnError, run, type RunResult } from "./git.ts";
import type { WatchRead } from "./pr-watch.ts";

export const FORGE_KINDS = ["github", "gitlab", "azure-devops", "bitbucket", "forgejo"] as const;
export type ForgeKind = (typeof FORGE_KINDS)[number];

/** Why a forge could not answer: its tool is missing, signed out, or it failed. */
export class ForgeUnavailable extends Error {
  readonly kind: "missing" | "signed-out" | "failed";
  constructor(kind: "missing" | "signed-out" | "failed", message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Whose branch a pull request comes from. `owner` is set when the branch is
 * pushed to another repository than the one pull requests go to (a fork):
 * then only a pull request from that owner's repository is the branch's.
 */
export interface HeadContext {
  readonly branch: string;
  /** The fork's owner, when the branch is pushed to a fork. */
  readonly owner?: string;
}

/** The pull request a forge reports, with where its head comes from, to match forks. */
export interface ForgePullRequest {
  readonly pr: PullRequest;
  /** The head's repository is another than the base's. */
  readonly crossRepository?: boolean;
  /** The owner of the head's repository, when the forge says. */
  readonly headOwner?: string;
}

/** Keeps a forge's answers for `head`: its branch, and its repository as the context says. */
export function matchesHead(found: ForgePullRequest, head: HeadContext): boolean {
  if (found.pr.headBranch !== "" && found.pr.headBranch !== head.branch) return false;
  if (head.owner !== undefined) {
    if (found.crossRepository === false) return false;
    return (
      found.headOwner === undefined || found.headOwner.toLowerCase() === head.owner.toLowerCase()
    );
  }
  // Not pushed to a fork: a same-named branch of someone's fork is not this branch.
  return found.crossRepository !== true;
}

/** A pull request to check out, and where its head lives (D902). */
export interface CheckoutTarget extends ForgePullRequest {
  /** `owner/name` of a fork's head repository. */
  readonly headRepository?: string;
  /**
   * The forge publishes `refs/pull/<n>/head` (GitHub, Forgejo): the fallback when the head
   * branch cannot be fetched. Azure DevOps, GitLab and Bitbucket publish none (D1444).
   */
  readonly pullRefs: boolean;
}

/** What the plugin asks of a forge, whichever it is. */
export interface Forge {
  readonly kind: ForgeKind;
  /** "GitHub", "GitLab", … */
  readonly name: string;
  readonly terminology: ChangeRequestTerminology;
  /** The newest pull request of `head`, any state, or `null`. */
  find(head: HeadContext): Promise<PullRequest | null>;
  /** A pull request by its URL. */
  at(url: string): Promise<PullRequest>;
  /** A pull request by its number, URL or head branch, to check out (D902). */
  resolve?(reference: string): Promise<CheckoutTarget>;
  /**
   * The repository's pull requests, any state, most recently updated first;
   * `query` is searched on the forge (T3's `listChangeRequests` with a query,
   * for the composer's `#` menu).
   */
  list?(input: { readonly query?: string; readonly limit: number }): Promise<PullRequest[]>;
  create(input: {
    readonly base: string;
    readonly head: HeadContext;
    readonly title: string;
    readonly bodyFile: string;
  }): Promise<PullRequest>;
  /** Where the forge looks for a pull request's template, relative to the repository. */
  readonly templatePaths: readonly string[];
  /** What a watch reads (D272); forges without it cannot be watched. */
  watch?(url: string): Promise<WatchRead>;
}

export const PULL_REQUEST: ChangeRequestTerminology = {
  singular: "pull request",
  shortLabel: "PR",
};
export const MERGE_REQUEST: ChangeRequestTerminology = {
  singular: "merge request",
  shortLabel: "MR",
};

const labels = (host: string) => host.toLowerCase().split(".");

/**
 * A forge's name as T3's `detectSourceControlProviderFromRemoteUrl` gives it (D1445): GitHub,
 * GitLab and Bitbucket on another host than their own are "… Self-Hosted".
 */
export function forgeName(kind: ForgeKind, host: string): string {
  const name = host.toLowerCase().replace(/:\d+$/, "");
  switch (kind) {
    case "github":
      return name === "github.com" ? "GitHub" : "GitHub Self-Hosted";
    case "gitlab":
      return name === "gitlab.com" ? "GitLab" : "GitLab Self-Hosted";
    case "bitbucket":
      return name === "bitbucket.org" ? "Bitbucket" : "Bitbucket Self-Hosted";
    case "azure-devops":
      return "Azure DevOps";
    case "forgejo":
      return "Forgejo";
  }
}

/**
 * A reference off GitHub (D1443), as T3's `normalizeChangeRequestId` reads one: a number, `#N`
 * or the forge's pull request URL (then with its repository). A head branch is refused.
 */
export function numberedReference(
  reference: string,
  forge: { readonly name: string; readonly terminology: ChangeRequestTerminology },
  /** How many path segments the forge's repository has (`owner/repo`: 2), when fixed. */
  segments?: number,
): { readonly number: number; readonly host?: string; readonly repository?: string } {
  const trimmed = reference.trim().replace(/^#/, "");
  if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) return { number: Number(trimmed) };
  const parsed = parsePullRequestUrl(trimmed);
  if (parsed !== undefined) {
    // The repository goes into an API path with the node's token: decoded `%2F`, `..` or a
    // query would reach elsewhere.
    const parts = parsed.repository.split("/");
    if (
      (segments !== undefined && parts.length !== segments) ||
      parts.some((part) => part === "" || part === "." || part === ".." || /[?#%\\]/.test(part))
    ) {
      throw new ForgeUnavailable("failed", `${trimmed} names no ${forge.name} repository.`);
    }
    return parsed;
  }
  const singular = forge.terminology.singular;
  throw new ForgeUnavailable(
    "failed",
    `Specify a ${singular} number or ${forge.name} ${singular} URL.`,
  );
}

/**
 * Which forge a remote's host is, as T3 Code detects it: a host named in
 * `configured` first, then GitHub (`github.com`, `*.ghe.com`, any `github`
 * label), GitLab, Azure DevOps, Bitbucket and Forgejo or Gitea (Codeberg,
 * any `forgejo` or `gitea` label). `undefined` for any other host.
 */
export function forgeKindOf(
  host: string,
  configured: Readonly<Record<string, ForgeKind>> = {},
): ForgeKind | undefined {
  const name = host.toLowerCase().replace(/:\d+$/, "");
  const chosen = Object.entries(configured).find(([key]) => key.toLowerCase() === name)?.[1];
  if (chosen !== undefined) return chosen;
  const parts = labels(name);
  if (name === "codeberg.org" || parts.includes("forgejo") || parts.includes("gitea")) {
    return "forgejo";
  }
  if (name === "github.com" || name.endsWith(".ghe.com") || parts.includes("github")) {
    return "github";
  }
  if (name === "gitlab.com" || parts.includes("gitlab")) return "gitlab";
  if (
    name === "dev.azure.com" ||
    name.endsWith(".dev.azure.com") ||
    name.endsWith(".visualstudio.com")
  ) {
    return "azure-devops";
  }
  if (name === "bitbucket.org" || parts.includes("bitbucket")) return "bitbucket";
  return undefined;
}

/**
 * Runs a forge's CLI, mapping a missing program and a sign-in refusal to
 * `ForgeUnavailable` with the forge's own words.
 */
export async function runCli(
  program: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly input?: string;
    readonly missing: string;
    readonly signedOut: string;
    readonly signedOutPattern: RegExp;
    readonly timeoutMs?: number;
  },
): Promise<RunResult> {
  let result: RunResult;
  try {
    result = await run(program, args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 30_000,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.input === undefined ? {} : { input: options.input }),
    });
  } catch (error) {
    if (error instanceof SpawnError && (error.code === "ENOENT" || error.code === "EACCES")) {
      throw new ForgeUnavailable("missing", options.missing);
    }
    throw new ForgeUnavailable("failed", (error as Error).message);
  }
  if (result.code !== 0) {
    if (
      options.signedOutPattern.test(result.stderr) ||
      options.signedOutPattern.test(result.stdout)
    ) {
      throw new ForgeUnavailable("signed-out", options.signedOut);
    }
    const line = result.stderr
      .split("\n")
      .map((item) => item.trim())
      .find((item) => item !== "");
    throw new ForgeUnavailable("failed", line ?? `${program} exited with code ${result.code}`);
  }
  return result;
}

/** Parses a CLI's JSON answer. */
export function json(result: RunResult, program: string): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ForgeUnavailable("failed", `${program} answered something that is not JSON`);
  }
}

export const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** A check status of the forge's own words, as T3 Code's providers map them. */
export type CheckWord = "success" | "failure" | "cancelled" | "pending" | "skipped" | "neutral";

/** Rolls checks up as T3 does: failing, pending, passing, or nothing to say. */
export function rollup(statuses: readonly CheckWord[]): PullRequest["checks"] {
  const count = (...kinds: CheckWord[]) =>
    statuses.filter((status) => kinds.includes(status)).length;
  const failed = count("failure", "cancelled");
  const pending = count("pending");
  const passed = count("success");
  return {
    state: failed > 0 ? "failing" : pending > 0 ? "pending" : passed > 0 ? "passing" : null,
    passed,
    failed,
    pending,
    total: statuses.length,
  };
}

/** How long the node's forge account is taken as known: a switch of accounts shows within it. */
const VIEWER_TTL_MS = 10 * 60_000;

/** The plugin's answers of who the node's forge account is, by tool and host. */
export type Viewers = Map<string, { readonly at: number; readonly login: Promise<string | null> }>;

/**
 * The node's account on a forge (D272's viewer), asked again once its answer is ten minutes
 * old; a failed answer is asked again next time.
 */
export function viewerOf(
  viewers: Viewers,
  key: string,
  ask: () => Promise<string | null>,
): Promise<string | null> {
  const known = viewers.get(key);
  if (known !== undefined && Date.now() - known.at < VIEWER_TTL_MS) return known.login;
  const asked = ask().catch(() => null);
  viewers.set(key, { at: Date.now(), login: asked });
  void asked.then((value) => {
    if (value === null && viewers.get(key)?.login === asked) viewers.delete(key);
  });
  return asked;
}
