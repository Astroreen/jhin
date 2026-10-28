// Forgejo and Gitea through `tea api` follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/source-control-forgejo (ForgejoCli.ts: `tea api`; ForgejoSourceControlProvider.ts:
// getPull's reference and its message; ForgejoPullRequestProvider.ts: the list, the pull
// request, its statuses, comments and reviews, the viewer; forgejoPullRequestJson.ts and
// forgejoPullRequests.ts: states, drafts, statuses as checks, mergeability, review states).
// docs/plans/source-control.md D278, D1441–D1443.
import * as Fs from "node:fs/promises";

import type { PullRequest } from "@jhin/source-control-api";

import {
  ForgeUnavailable,
  PULL_REQUEST,
  json,
  matchesHead,
  numberedReference,
  rollup,
  runCli,
  text,
  viewerOf,
  type CheckWord,
  type Forge,
  type ForgePullRequest,
  type Viewers,
} from "./forge.ts";
import type { ForgeSite } from "./forges.ts";
import type { Remark, WatchRead } from "./pr-watch.ts";

const TEA_SIGNED_OUT = /tea login|no login|token is required|401|unauthorized/i;
const SIGNED_OUT = "tea is not signed in to this server: run `tea login add` on this node";

type Raw = Record<string, unknown>;

const stamp = (value: unknown) => {
  const at = text(value);
  return at === undefined || at === "" ? undefined : at;
};

function forgejoRequest(raw: Raw, checks: readonly CheckWord[]): ForgePullRequest | undefined {
  const number = raw["number"];
  const url = text(raw["html_url"]);
  if (typeof number !== "number" || url === undefined) return undefined;
  const head = raw["head"] as
    | {
        ref?: unknown;
        sha?: unknown;
        repo?: { full_name?: unknown; owner?: { login?: unknown } } | null;
      }
    | undefined;
  const base = raw["base"] as { ref?: unknown; repo?: { full_name?: unknown } | null } | undefined;
  const title = text(raw["title"]) ?? `#${number}`;
  const merged = raw["merged"] === true;
  const updated = text(raw["updated_at"]);
  const mergedAt = stamp(raw["merged_at"]);
  const closedAt = stamp(raw["closed_at"]);
  const from = text(head?.repo?.full_name);
  const into = text(base?.repo?.full_name);
  const owner = text(head?.repo?.owner?.login);
  const sha = text(head?.sha);
  return {
    pr: {
      number,
      title,
      url,
      state: merged ? "merged" : text(raw["state"]) === "closed" ? "closed" : "open",
      isDraft: raw["draft"] === true || /^(\[WIP\]|WIP:)/i.test(title),
      headBranch: text(head?.ref) ?? "",
      baseBranch: text(base?.ref) ?? "",
      ...(sha === undefined || sha === "" ? {} : { headSha: sha }),
      ...(updated ? { updatedAt: updated } : {}),
      ...(merged && mergedAt ? { mergedAt } : {}),
      ...(!merged && closedAt ? { closedAt } : {}),
      checks: rollup(checks),
      ...forgejoDetails(raw),
    },
    ...(from !== undefined && into !== undefined
      ? { crossRepository: from.toLowerCase() !== into.toLowerCase() }
      : {}),
    ...(owner === undefined ? {} : { headOwner: owner }),
  };
}

/** T3's row details of a Forgejo pull request (D1449), straight from its JSON. */
function forgejoDetails(raw: Raw): Partial<PullRequest> {
  const user = raw["user"] as
    | { login?: unknown; full_name?: unknown; avatar_url?: unknown }
    | null
    | undefined;
  const login = text(user?.login);
  const count = (key: string) => {
    const value = raw[key];
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
  };
  const additions = count("additions");
  const deletions = count("deletions");
  const changedFiles = count("changed_files");
  return {
    ...(login === undefined
      ? {}
      : {
          author: {
            login,
            name: text(user?.full_name) || null,
            avatarUrl: text(user?.avatar_url) ?? null,
          },
        }),
    ...(additions === undefined ? {} : { additions }),
    ...(deletions === undefined ? {} : { deletions }),
    ...(changedFiles === undefined ? {} : { changedFiles }),
    // T3: Forgejo says mergeable or nothing; it never says conflicting.
    ...(raw["mergeable"] === undefined
      ? {}
      : { mergeability: raw["mergeable"] === true ? "mergeable" : "unknown" }),
  };
}

/** T3's status of a commit status: success, failure (and error), else pending. */
const statusWord = (word: string | undefined): CheckWord =>
  word === "success" ? "success" : word === "failure" || word === "error" ? "failure" : "pending";

/** T3's review states: Forgejo's words as GitHub's. */
const reviewState = (state: string | undefined) =>
  state === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : state === "COMMENT" ? "COMMENTED" : state;

/** A comment, review or review comment as a remark; `kind` keeps the ids of each apart. */
function forgejoRemark(raw: Raw, kind: "comment" | "review" | "line"): Remark | undefined {
  const id = raw["id"];
  const body = text(raw["body"]) ?? "";
  const createdAt = text(raw["created_at"]) ?? text(raw["submitted_at"]);
  if (typeof id !== "number" || createdAt === undefined) return undefined;
  const state = kind === "review" ? reviewState(text(raw["state"])) : undefined;
  // A review with no text says its state; a comment with none says nothing.
  if (body.trim() === "" && state === undefined) return undefined;
  const edited = text(raw["updated_at"]);
  const path = kind === "line" ? text(raw["path"]) : undefined;
  const url = text(raw["html_url"]);
  return {
    id: `${kind}:${id}`,
    author: text((raw["user"] as { login?: unknown } | null | undefined)?.login) ?? null,
    body,
    createdAt,
    ...(edited !== undefined && edited !== createdAt ? { editedAt: edited } : {}),
    ...(path === undefined ? {} : { path }),
    ...(state === undefined ? {} : { reviewState: state }),
    ...(url === undefined ? {} : { url }),
  };
}

/** Pages T3 follows at most when listing. */
const MAX_PAGES = 10;

export function forgejoForge(teaPath: () => string, site: ForgeSite, viewers: Viewers): Forge {
  const tea = async (
    endpoint: string,
    init: { method?: string; body?: unknown; empty?: boolean } = {},
  ) => {
    const result = await runCli(
      teaPath(),
      [
        "api",
        ...(init.method === undefined ? [] : ["--method", init.method]),
        ...(init.body === undefined ? [] : ["--data", "@-"]),
        endpoint,
      ],
      {
        cwd: site.cwd,
        ...(init.body === undefined ? {} : { input: JSON.stringify(init.body) }),
        missing: "Forgejo or Gitea CLI (tea) is not installed on this node",
        signedOut: SIGNED_OUT,
        signedOutPattern: TEA_SIGNED_OUT,
      },
    );
    // A merge answers nothing on success.
    if (init.empty === true && result.stdout.trim() === "") return null;
    const answer = json(result, "tea");
    // tea exits 0 on an HTTP error and prints the server's error body.
    const message = text((answer as { message?: unknown } | null)?.message);
    if (
      message !== undefined &&
      !Array.isArray(answer) &&
      (answer as { number?: unknown; id?: unknown }).number === undefined &&
      (answer as { id?: unknown }).id === undefined
    ) {
      if (TEA_SIGNED_OUT.test(message)) throw new ForgeUnavailable("signed-out", SIGNED_OUT);
      throw new ForgeUnavailable("failed", message);
    }
    return answer;
  };
  const list = async (endpoint: string) => {
    const answer = await tea(endpoint);
    if (!Array.isArray(answer)) throw new ForgeUnavailable("failed", "tea answered no list");
    return answer as Raw[];
  };
  const statusesOf = async (repository: string, sha: string | undefined) =>
    sha === undefined ? [] : list(`/repos/${repository}/statuses/${sha}?sort=recentupdate`);
  const checksOf = async (repository: string, sha: string | undefined) =>
    (await statusesOf(repository, sha).catch(() => [] as Raw[])).map((status) =>
      statusWord(text(status["status"])),
    );
  const full = async (repository: string, raw: Raw) => {
    const head = raw["head"] as { sha?: unknown } | undefined;
    const found = forgejoRequest(raw, await checksOf(repository, text(head?.sha)));
    if (found === undefined) throw new ForgeUnavailable("failed", "tea answered no pull request");
    return found;
  };
  /** The repository's pull requests, newest first, up to `max`, a page of 50 at a time. */
  const pulls = async (max: number) => {
    const values: Raw[] = [];
    const size = Math.min(max, 50);
    for (let page = 1; page <= MAX_PAGES && values.length < max; page += 1) {
      const found = await list(
        `/repos/${site.repository}/pulls?state=all&sort=recentupdate&limit=${size}&page=${page}`,
      );
      values.push(...found);
      // A short page is the last (tea gives no link header to follow, as T3 reads it).
      if (found.length < size) break;
    }
    return values.slice(0, max);
  };
  const forge: Forge = {
    kind: "forgejo",
    name: "Forgejo",
    terminology: PULL_REQUEST,
    find: async (head) => {
      const values = await list(
        `/repos/${site.repository}/pulls?state=all&sort=recentupdate&limit=50`,
      );
      const match = values.find((value) => {
        const found = forgejoRequest(value, []);
        return (
          found !== undefined && found.pr.headBranch === head.branch && matchesHead(found, head)
        );
      });
      return match === undefined ? null : (await full(site.repository, match)).pr;
    },
    at: async (url) => {
      const { repository = site.repository, number } = numberedReference(url, forge, 2, site.host);
      return (await full(repository, (await tea(`/repos/${repository}/pulls/${number}`)) as Raw))
        .pr;
    },
    // T3's getPull: a number or a pull request URL (D1443).
    resolve: async (reference) => {
      const { repository = site.repository, number } = numberedReference(
        reference,
        forge,
        2,
        site.host,
      );
      const raw = (await tea(`/repos/${repository}/pulls/${number}`)) as Raw;
      const found = await full(repository, raw);
      const head = raw["head"] as { repo?: { full_name?: unknown } | null } | undefined;
      const from = text(head?.repo?.full_name);
      return {
        ...found,
        pullRefs: true,
        ...(found.crossRepository === true && from !== undefined ? { headRepository: from } : {}),
      };
    },
    // T3 searches no text on Forgejo: words are matched here, as on Azure DevOps (D1288).
    list: async ({ query: words, limit }) => {
      const trimmed = words?.trim().toLowerCase() ?? "";
      return (await pulls(trimmed === "" ? limit : Math.max(limit, 100)))
        .map((value) => forgejoRequest(value, [])?.pr)
        .filter((pr): pr is PullRequest => pr !== undefined)
        .filter(
          (pr) =>
            trimmed === "" ||
            // Every word in the title, in any order, or the number.
            trimmed.split(/\s+/).every((word) => pr.title.toLowerCase().includes(word)) ||
            String(pr.number) === trimmed.replace(/^#/, ""),
        )
        .slice(0, limit);
    },
    create: async ({ base, head, title, bodyFile }) => {
      const answer = await tea(`/repos/${site.repository}/pulls`, {
        method: "POST",
        body: {
          base,
          head: head.owner === undefined ? head.branch : `${head.owner}:${head.branch}`,
          title,
          body: await Fs.readFile(bodyFile, "utf8"),
        },
      });
      return (await full(site.repository, answer as Raw)).pr;
    },
    // What a watch reads (D1442): the pull request, its head's statuses, its comments,
    // reviews and their comments on lines, and the node's account.
    watch: async (url) => {
      const { repository = site.repository, number } = numberedReference(url, forge, 2, site.host);
      const path = `/repos/${repository}/pulls/${number}`;
      const raw = (await tea(path)) as Raw;
      const found = forgejoRequest(raw, []);
      if (found === undefined) throw new ForgeUnavailable("failed", "tea answered no pull request");
      const [statuses, comments, reviews, viewer] = await Promise.all([
        statusesOf(repository, found.pr.headSha),
        list(`/repos/${repository}/issues/${number}/comments`),
        list(`${path}/reviews`),
        viewerOf(viewers, `tea\u0000${site.host}`, async () => {
          const user = (await tea("/user")) as { login?: unknown } | null;
          return text(user?.login) ?? null;
        }),
      ]);
      const shown = reviews.filter((review) => {
        const state = text(review["state"]);
        return state !== "PENDING" && state !== "REQUEST_REVIEW";
      });
      const lines = await Promise.all(
        shown
          .filter((review) => Number(review["comments_count"] ?? 0) > 0)
          .map((review) => list(`${path}/reviews/${String(review["id"])}/comments`)),
      );
      const author = (raw["user"] as { login?: unknown } | null | undefined)?.login;
      return {
        state: found.pr.state,
        headSha: found.pr.headSha ?? null,
        baseBranch: found.pr.baseBranch,
        checks: statuses.map((status) => {
          const link = text(status["target_url"]);
          return {
            name: text(status["context"]) || "check",
            status: statusWord(text(status["status"])),
            ...(link ? { url: link } : {}),
          };
        }),
        // T3: Forgejo says mergeable or nothing; it never says conflicting.
        mergeability: (raw["mergeable"] === true
          ? "mergeable"
          : "unknown") as WatchRead["mergeability"],
        author: text(author) ?? null,
        viewer,
        remarks: [
          ...comments.map((item) => forgejoRemark(item, "comment")),
          ...shown.map((item) => forgejoRemark(item, "review")),
          ...lines.flat().map((item) => forgejoRemark(item, "line")),
        ]
          .filter((item) => item !== undefined)
          .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
      };
    },
    templatePaths: [
      ".forgejo/pull_request_template.md",
      ".gitea/pull_request_template.md",
      ".github/pull_request_template.md",
      "docs/pull_request_template.md",
    ],
    // T3's Forgejo `changeRequestActions` that Jhin runs (D1661).
    actions: ["merge", "close", "reopen", "update-branch"],
    updateMethods: ["merge", "rebase"],
    // T3's Forgejo merge capabilities: the repository's `allow_*` flags (D1450).
    mergeMethods: async (url) => {
      const { repository = site.repository } = numberedReference(url, forge, 2, site.host);
      const raw = ((await tea(`/repos/${repository}`)) ?? {}) as Raw;
      return [
        ...(raw["allow_merge_commits"] !== false ? (["merge"] as const) : []),
        ...(raw["allow_squash_merge"] !== false ? (["squash"] as const) : []),
        ...(raw["allow_rebase"] !== false ? (["rebase"] as const) : []),
      ];
    },
    // T3's `POST pulls/<n>/merge`, `PATCH pulls/<n>` and `POST pulls/<n>/update` (D1451, D1661).
    act: async (url, action, method, update) => {
      const { repository = site.repository, number } = numberedReference(url, forge, 2, site.host);
      const path = `/repos/${repository}/pulls/${number}`;
      if (action === "merge") {
        await tea(`${path}/merge`, { method: "POST", body: { Do: method }, empty: true });
      } else if (action === "update-branch") {
        await tea(`${path}/update?style=${update ?? "merge"}`, { method: "POST", empty: true });
      } else if (action === "close" || action === "reopen") {
        await tea(path, {
          method: "PATCH",
          body: { state: action === "close" ? "closed" : "open" },
        });
      } else {
        throw new ForgeUnavailable("failed", `Forgejo does not expose ${action} through its API.`);
      }
    },
  };
  return forge;
}
