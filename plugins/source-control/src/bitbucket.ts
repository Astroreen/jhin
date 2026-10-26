// Bitbucket Cloud through its REST API follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/source-control-bitbucket (BitbucketApi.ts: the REST API, its credentials, statuses
// as checks, normalizeChangeRequestId; BitbucketPullRequestApi.ts: listPullRequests with its
// `q` search, the pull request, its statuses, conflicts and comments, the viewer;
// bitbucketPullRequestJson.ts: states, the author, comments), with their messages.
// docs/plans/source-control.md D279, D1441–D1443, D1446.
import { createHash } from "node:crypto";
import * as Fs from "node:fs/promises";

import type { PullRequest } from "@jhin/source-control-api";

import {
  ForgeUnavailable,
  PULL_REQUEST,
  matchesHead,
  numberedReference,
  rollup,
  text,
  viewerOf,
  type CheckWord,
  type Forge,
  type ForgePullRequest,
  type Viewers,
} from "./forge.ts";
import type { ForgeSite } from "./forges.ts";
import type { Remark, WatchRead } from "./pr-watch.ts";

/** Bitbucket's credentials: the config's secrets first (D1446), else the node's environment. */
export interface BitbucketCredentials {
  readonly accessToken?: string;
  readonly email?: string;
  readonly apiToken?: string;
  readonly apiBaseUrl?: string;
}

const NEEDS_TOKEN =
  "Bitbucket needs a token on this node: set it in the source control settings, or JHIN_BITBUCKET_ACCESS_TOKEN (or JHIN_BITBUCKET_EMAIL and JHIN_BITBUCKET_API_TOKEN)";

/** The credentials in force: each from the config when set there, else from the environment. */
export function bitbucketCredentials(
  configured: BitbucketCredentials,
  env: NodeJS.ProcessEnv,
): BitbucketCredentials {
  const pick = (value: string | undefined, key: string) =>
    value !== undefined && value !== "" ? value : env[key] || undefined;
  const accessToken = pick(configured.accessToken, "JHIN_BITBUCKET_ACCESS_TOKEN");
  const email = pick(configured.email, "JHIN_BITBUCKET_EMAIL");
  const apiToken = pick(configured.apiToken, "JHIN_BITBUCKET_API_TOKEN");
  const apiBaseUrl = pick(configured.apiBaseUrl, "JHIN_BITBUCKET_API_BASE_URL");
  return {
    ...(accessToken === undefined ? {} : { accessToken }),
    ...(email === undefined ? {} : { email }),
    ...(apiToken === undefined ? {} : { apiToken }),
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
  };
}

function authorization(credentials: BitbucketCredentials): string {
  if (credentials.accessToken) return `Bearer ${credentials.accessToken}`;
  if (credentials.email && credentials.apiToken) {
    return `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString("base64")}`;
  }
  throw new ForgeUnavailable("signed-out", NEEDS_TOKEN);
}

function statusWord(state: string | undefined): CheckWord {
  switch (state) {
    case "SUCCESSFUL":
      return "success";
    case "FAILED":
      return "failure";
    case "STOPPED":
      return "cancelled";
    case "INPROGRESS":
      return "pending";
    default:
      return "neutral";
  }
}

type Raw = Record<string, unknown>;

/** T3's author of a Bitbucket account: its nickname, else its display name. */
const accountName = (raw: unknown) => {
  const account = raw as { nickname?: unknown; display_name?: unknown } | null | undefined;
  return text(account?.nickname) ?? text(account?.display_name) ?? null;
};

function bitbucketRequest(raw: Raw, checks: readonly CheckWord[]): ForgePullRequest | undefined {
  const number = raw["id"];
  const links = raw["links"] as { html?: { href?: unknown } } | undefined;
  const url = text(links?.html?.href);
  if (typeof number !== "number" || url === undefined) return undefined;
  const source = raw["source"] as
    | {
        branch?: { name?: unknown };
        commit?: { hash?: unknown } | null;
        repository?: { full_name?: unknown };
      }
    | undefined;
  const destination = raw["destination"] as typeof source;
  const state = text(raw["state"]);
  const from = text(source?.repository?.full_name);
  const into = text(destination?.repository?.full_name);
  const updated = text(raw["updated_on"]);
  const sha = text(source?.commit?.hash);
  return {
    pr: {
      number,
      title: text(raw["title"]) ?? `#${number}`,
      url,
      state:
        state === "MERGED"
          ? "merged"
          : state === "DECLINED" || state === "SUPERSEDED"
            ? "closed"
            : "open",
      isDraft: raw["draft"] === true,
      headBranch: text(source?.branch?.name) ?? "",
      baseBranch: text(destination?.branch?.name) ?? "",
      ...(sha === undefined || sha === "" ? {} : { headSha: sha }),
      ...(updated ? { updatedAt: updated } : {}),
      ...(state === "MERGED" && updated ? { mergedAt: updated } : {}),
      ...((state === "DECLINED" || state === "SUPERSEDED") && updated ? { closedAt: updated } : {}),
      checks: rollup(checks),
    },
    ...(from !== undefined && into !== undefined
      ? {
          crossRepository: from.toLowerCase() !== into.toLowerCase(),
          headOwner: from.split("/")[0]!,
        }
      : {}),
  };
}

/** A comment as T3's bitbucketPullRequestJson keeps it: none deleted, pending or empty. */
function bitbucketRemark(raw: Raw): Remark | undefined {
  if (raw["deleted"] === true || raw["pending"] === true) return undefined;
  const body = text((raw["content"] as { raw?: unknown } | undefined)?.raw) ?? "";
  const createdAt = text(raw["created_on"]);
  const id = raw["id"];
  if (body.trim() === "" || createdAt === undefined || typeof id !== "number") return undefined;
  const path = text((raw["inline"] as { path?: unknown } | null | undefined)?.path);
  const edited = text(raw["updated_on"]);
  const url = text((raw["links"] as { html?: { href?: unknown } } | undefined)?.html?.href);
  return {
    id: String(id),
    author: accountName(raw["user"]),
    body,
    createdAt,
    ...(edited !== undefined && edited !== createdAt ? { editedAt: edited } : {}),
    ...(path === undefined ? {} : { path }),
    ...(url === undefined ? {} : { url }),
  };
}

/** T3's search literal: `\` first, then `"`. */
const literal = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

/** Pages T3 follows at most. */
const MAX_PAGES = 10;
const PAGE_SIZE = 50;

export function bitbucketForge(
  site: ForgeSite,
  credentials: () => BitbucketCredentials,
  viewers: Viewers,
): Forge {
  const baseOf = () =>
    (credentials().apiBaseUrl ?? "https://api.bitbucket.org/2.0").replace(/\/+$/, "");
  /** `path` under the API's base, or a `next` link the API gave. */
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const base = baseOf();
    const auth = authorization(credentials());
    // A `next` link is followed only on the API's own origin: the token goes nowhere else.
    if (/^https?:\/\//i.test(path) && new URL(path).origin !== new URL(base).origin) {
      throw new ForgeUnavailable("failed", `Bitbucket answered a link to another host: ${path}`);
    }
    let response: Response;
    try {
      response = await fetch(/^https?:\/\//i.test(path) ? path : `${base}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization: auth,
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(30_000),
        // A redirect would carry the token along: it is refused, not followed.
        redirect: "manual",
      });
    } catch (error) {
      throw new ForgeUnavailable(
        "failed",
        `Bitbucket could not be reached: ${(error as Error).message}`,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ForgeUnavailable(
        "failed",
        `Bitbucket answered a redirect (${response.status}); the node's token is not sent on`,
      );
    }
    if (response.status === 403) {
      throw new ForgeUnavailable(
        "failed",
        "Bitbucket refused this node's token access to the repository (403)",
      );
    }
    if (response.status === 401) {
      throw new ForgeUnavailable(
        "signed-out",
        "Bitbucket refused this node's token: check it in the source control settings (or JHIN_BITBUCKET_ACCESS_TOKEN, or JHIN_BITBUCKET_EMAIL and JHIN_BITBUCKET_API_TOKEN)",
      );
    }
    const answer: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = text(
        (answer as { error?: { message?: unknown } } | undefined)?.error?.message,
      );
      throw new ForgeUnavailable("failed", message ?? `Bitbucket answered ${response.status}`);
    }
    return (answer ?? {}) as Raw;
  };
  /** The values of a paged answer, following `next` up to `max` values or T3's ten pages. */
  const paged = async (path: string, max = Number.POSITIVE_INFINITY) => {
    const values: Raw[] = [];
    let next: string | undefined = path;
    for (let page = 0; next !== undefined && page < MAX_PAGES && values.length < max; page += 1) {
      const answer = await call(next);
      if (Array.isArray(answer["values"])) values.push(...(answer["values"] as Raw[]));
      next = text(answer["next"]);
    }
    return values.slice(0, max);
  };
  /** Which account the credentials are, without them: another token is another viewer. */
  const identity = () => {
    const { accessToken, email, apiToken } = credentials();
    return createHash("sha256")
      .update(`${accessToken ?? ""}\u0000${email ?? ""}\u0000${apiToken ?? ""}`)
      .digest("hex")
      .slice(0, 16);
  };
  const repo = (repository: string) => `/repositories/${repository}`;
  const statusesOf = (repository: string, number: number) =>
    paged(`${repo(repository)}/pullrequests/${number}/statuses?pagelen=${PAGE_SIZE}`);
  const checksOf = async (repository: string, number: number) =>
    (await statusesOf(repository, number).catch(() => [] as Raw[])).map((value) =>
      statusWord(text(value["state"])),
    );
  const full = async (repository: string, raw: Raw) => {
    const number = raw["id"];
    const found = bitbucketRequest(
      raw,
      typeof number === "number" ? await checksOf(repository, number) : [],
    );
    if (found === undefined)
      throw new ForgeUnavailable("failed", "Bitbucket answered no pull request");
    return found;
  };
  const forge: Forge = {
    kind: "bitbucket",
    name: "Bitbucket",
    terminology: PULL_REQUEST,
    find: async (head) => {
      const query = encodeURIComponent(`source.branch.name="${literal(head.branch)}"`);
      const answer = await call(
        `${repo(site.repository)}/pullrequests?q=${query}&state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on&pagelen=10`,
      );
      const values = Array.isArray(answer["values"]) ? (answer["values"] as Raw[]) : [];
      const first = values
        .map((value) => bitbucketRequest(value, []))
        .find((item) => item !== undefined && matchesHead(item, head));
      if (first === undefined) return null;
      return (
        await full(
          site.repository,
          values.find((value) => value["id"] === first.pr.number)!,
        )
      ).pr;
    },
    at: async (url) => {
      const { repository = site.repository, number } = numberedReference(url, forge, 2, site.host);
      return (await full(repository, await call(`${repo(repository)}/pullrequests/${number}`))).pr;
    },
    // T3's normalizeChangeRequestId: a number or a pull request URL, no branch (D1443).
    resolve: async (reference) => {
      const { repository = site.repository, number } = numberedReference(
        reference,
        forge,
        2,
        site.host,
      );
      const raw = await call(`${repo(repository)}/pullrequests/${number}`);
      const found = await full(repository, raw);
      const source = raw["source"] as { repository?: { full_name?: unknown } } | undefined;
      const from = text(source?.repository?.full_name);
      return {
        ...found,
        pullRefs: false,
        ...(found.crossRepository === true && from !== undefined ? { headRepository: from } : {}),
      };
    },
    // T3's listPullRequests: every state, newest first, words in the title or description.
    list: async ({ query: words, limit }) => {
      const trimmed = words?.trim() ?? "";
      const q =
        trimmed === ""
          ? ""
          : `&q=${encodeURIComponent(`(title ~ "${literal(trimmed)}" OR description ~ "${literal(trimmed)}")`)}`;
      const values = await paged(
        `${repo(site.repository)}/pullrequests?state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&pagelen=${Math.min(limit, PAGE_SIZE)}&sort=-updated_on${q}`,
        limit,
      );
      return values
        .map((value) => bitbucketRequest(value, [])?.pr)
        .filter((pr): pr is PullRequest => pr !== undefined);
    },
    create: async ({ base: target, head, title, bodyFile }) => {
      const answer = await call(`${repo(site.repository)}/pullrequests`, {
        method: "POST",
        body: {
          title,
          description: await Fs.readFile(bodyFile, "utf8"),
          source: {
            branch: { name: head.branch },
            ...(head.owner === undefined
              ? {}
              : { repository: { full_name: `${head.owner}/${site.repository.split("/")[1]}` } }),
          },
          destination: { branch: { name: target } },
        },
      });
      return (await full(site.repository, answer)).pr;
    },
    // What a watch reads (D1442): the pull request, its statuses, conflicts, comments and the
    // node's account.
    watch: async (url) => {
      const { repository = site.repository, number } = numberedReference(url, forge, 2, site.host);
      const path = `${repo(repository)}/pullrequests/${number}`;
      const [raw, statuses, conflicts, comments, viewer] = await Promise.all([
        call(path),
        statusesOf(repository, number),
        call(`${path}/conflicts`).then(
          (answer): WatchRead["mergeability"] =>
            Array.isArray(answer["values"]) && answer["values"].length > 0
              ? "conflicting"
              : "mergeable",
          (): WatchRead["mergeability"] => "unknown",
        ),
        paged(`${path}/comments?pagelen=${PAGE_SIZE}`),
        viewerOf(viewers, `bitbucket\u0000${baseOf()}\u0000${identity()}`, async () =>
          accountName(await call("/user")),
        ),
      ]);
      const found = bitbucketRequest(raw, []);
      if (found === undefined)
        throw new ForgeUnavailable("failed", "Bitbucket answered no pull request");
      return {
        state: found.pr.state,
        headSha: found.pr.headSha ?? null,
        baseBranch: found.pr.baseBranch,
        checks: statuses.map((status) => {
          const link = text(status["url"]);
          return {
            name: text(status["name"]) ?? text(status["key"]) ?? "check",
            status: statusWord(text(status["state"])),
            ...(link === undefined ? {} : { url: link }),
          };
        }),
        mergeability: conflicts,
        author: accountName(raw["author"]),
        viewer,
        remarks: comments
          .map(bitbucketRemark)
          .filter((item) => item !== undefined)
          .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
      };
    },
    // Bitbucket has no template files of a pull request.
    templatePaths: [],
  };
  return forge;
}
