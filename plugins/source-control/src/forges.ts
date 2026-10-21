// The forges other than GitHub follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/source-control-gitlab (GitLabCli.ts: `glab mr list --source-branch`, `glab api
// projects/:path/merge_requests`; gitLabMergeRequestJson.ts: states, drafts, the pipeline as a
// check), packages/source-control-azure-devops (AzureDevOpsCli.ts: `az repos pr list|show|
// create`; states), packages/source-control-bitbucket (BitbucketApi.ts: the REST API, its
// credentials, statuses as checks) and packages/source-control-forgejo (ForgejoCli.ts:
// `tea api`; forgejoPullRequests.ts: states, drafts, statuses as checks), with their messages.
import * as Fs from "node:fs/promises";

import {
  parsePullRequestUrl,
  repositoryOfRemote,
  type PullRequest,
} from "@jhin/source-control-api";

import {
  ForgeUnavailable,
  MERGE_REQUEST,
  PULL_REQUEST,
  json,
  matchesHead,
  rollup,
  runCli,
  text,
  type CheckWord,
  type Forge,
  type ForgePullRequest,
  type HeadContext,
} from "./forge.ts";

/** Where a forge's driver works: the repository's folder and its `origin`. */
export interface ForgeSite {
  readonly cwd: string;
  /** The remote pull requests go to (`origin`), as `owner/repo` on `host`. */
  readonly host: string;
  readonly repository: string;
}

/** The newest of `found` that is `head`'s, or `null`. */
const newest = (found: readonly ForgePullRequest[], head: HeadContext): PullRequest | null =>
  found
    .filter((item) => matchesHead(item, head))
    .toSorted((a, b) => (b.pr.updatedAt ?? "").localeCompare(a.pr.updatedAt ?? ""))[0]?.pr ?? null;

const reference = (url: string) => {
  const parsed = parsePullRequestUrl(url);
  if (parsed === undefined) throw new ForgeUnavailable("failed", `${url} is no pull request URL`);
  return parsed;
};

const stamp = (value: unknown) => {
  const at = text(value);
  return at === undefined || at === "" ? {} : { value: at };
};

// --- GitLab (glab) ------------------------------------------------------------------------------

const GITLAB_SIGNED_OUT =
  /glab auth login|not authenticated|401 unauthorized|no token|unauthenticated/i;

function pipelineWord(status: string | undefined): CheckWord {
  switch (status) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    case "canceled":
    case "canceling":
      return "cancelled";
    case "skipped":
      return "skipped";
    case "manual":
    case "scheduled":
      return "neutral";
    default:
      return "pending";
  }
}

function gitlabRequest(raw: Record<string, unknown>): ForgePullRequest | undefined {
  const number = raw["iid"];
  const url = text(raw["web_url"]);
  if (typeof number !== "number" || url === undefined) return undefined;
  const state = text(raw["state"]);
  const pipeline = raw["head_pipeline"] as { status?: unknown } | null | undefined;
  const merged = stamp(raw["merged_at"]).value;
  const closed = stamp(raw["closed_at"]).value;
  const updated = text(raw["updated_at"]);
  const source = raw["source_project_id"];
  const target = raw["target_project_id"];
  return {
    pr: {
      number,
      title: text(raw["title"]) ?? `!${number}`,
      url,
      state:
        state === "merged"
          ? "merged"
          : state === "closed" || state === "locked"
            ? "closed"
            : "open",
      isDraft: raw["draft"] === true || raw["work_in_progress"] === true,
      headBranch: text(raw["source_branch"]) ?? "",
      baseBranch: text(raw["target_branch"]) ?? "",
      ...(updated ? { updatedAt: updated } : {}),
      ...(merged ? { mergedAt: merged } : {}),
      ...(closed ? { closedAt: closed } : {}),
      checks: rollup(pipeline?.status === undefined ? [] : [pipelineWord(text(pipeline.status))]),
    },
    ...(typeof source === "number" && typeof target === "number"
      ? { crossRepository: source !== target }
      : {}),
  };
}

export function gitlabForge(glabPath: () => string, site: ForgeSite): Forge {
  const glab = async (args: readonly string[]) =>
    json(
      await runCli(glabPath(), args, {
        cwd: site.cwd,
        env: { GLAB_NO_PROMPT: "1", NO_COLOR: "1", GLAB_CHECK_UPDATE: "false" },
        missing: "GitLab CLI (glab) is not installed on this node",
        signedOut: "GitLab CLI is not signed in: run `glab auth login` on this node",
        signedOutPattern: GITLAB_SIGNED_OUT,
      }),
      "glab",
    );
  const project = (repository: string) => `projects/${encodeURIComponent(repository)}`;
  const read = async (host: string, repository: string, number: number) => {
    const raw = await glab([
      "api",
      "--hostname",
      host,
      `${project(repository)}/merge_requests/${number}`,
    ]);
    const found = gitlabRequest((raw ?? {}) as Record<string, unknown>);
    if (found === undefined) throw new ForgeUnavailable("failed", "glab answered no merge request");
    return found.pr;
  };
  return {
    kind: "gitlab",
    name: "GitLab",
    terminology: MERGE_REQUEST,
    find: async (head) => {
      const raw = await glab([
        "mr",
        "list",
        // The repository pull requests go to, not whichever glab would pick from the folder.
        ...(site.repository === "" ? [] : ["--repo", `https://${site.host}/${site.repository}`]),
        "--source-branch",
        head.branch,
        "--all",
        "--per-page",
        "20",
        "--output",
        "json",
      ]);
      if (!Array.isArray(raw)) throw new ForgeUnavailable("failed", "glab answered no list");
      return newest(
        raw
          .map((item) => gitlabRequest(item as Record<string, unknown>))
          .filter((item) => item !== undefined),
        head,
      );
    },
    at: async (url) => {
      const { host, repository, number } = reference(url);
      return read(host, repository, number);
    },
    create: async ({ base, head, title, bodyFile }) => {
      if (head.owner !== undefined) {
        throw new ForgeUnavailable(
          "failed",
          "Opening a GitLab merge request from a fork is not supported on this node yet",
        );
      }
      const raw = await glab([
        "api",
        "--hostname",
        site.host,
        "--method",
        "POST",
        `${project(site.repository)}/merge_requests`,
        "--raw-field",
        `source_branch=${head.branch}`,
        "--raw-field",
        `target_branch=${base}`,
        "--raw-field",
        `title=${title}`,
        "--field",
        `description=@${bodyFile}`,
      ]);
      const found = gitlabRequest((raw ?? {}) as Record<string, unknown>);
      if (found === undefined)
        throw new ForgeUnavailable("failed", "glab created no merge request");
      return found.pr;
    },
    templatePaths: [
      ".gitlab/merge_request_templates/Default.md",
      ".gitlab/merge_request_templates/default.md",
    ],
  };
}

// --- Azure DevOps (az) --------------------------------------------------------------------------

const AZURE_SIGNED_OUT = /az login|az devops login|TF400813/i;
const branchOfRef = (ref: string | undefined) => (ref ?? "").replace(/^refs\/heads\//, "");

function azureRequest(raw: Record<string, unknown>): ForgePullRequest | undefined {
  const number = raw["pullRequestId"];
  const repository = raw["repository"] as { webUrl?: unknown } | undefined;
  const web = text(repository?.webUrl);
  if (typeof number !== "number" || web === undefined) return undefined;
  const status = text(raw["status"]);
  const closed = stamp(raw["closedDate"]).value;
  const created = text(raw["creationDate"]);
  return {
    pr: {
      number,
      title: text(raw["title"]) ?? `!${number}`,
      url: `${web}/pullrequest/${number}`,
      state: status === "completed" ? "merged" : status === "abandoned" ? "closed" : "open",
      isDraft: raw["isDraft"] === true,
      headBranch: branchOfRef(text(raw["sourceRefName"])),
      baseBranch: branchOfRef(text(raw["targetRefName"])),
      ...(closed !== undefined || created !== undefined ? { updatedAt: closed ?? created! } : {}),
      ...(status === "completed" && closed ? { mergedAt: closed } : {}),
      ...(status === "abandoned" && closed ? { closedAt: closed } : {}),
      // T3 reads no checks from Azure DevOps either.
      checks: rollup([]),
    },
    crossRepository: raw["forkSource"] !== null && raw["forkSource"] !== undefined,
  };
}

/**
 * Which Azure DevOps repository: the one `site` names (`org/project/_git/repo`
 * on dev.azure.com, `project/_git/repo` on `<org>.visualstudio.com`), else
 * the folder's (`--detect`).
 */
function azureWhere(site: ForgeSite): string[] {
  const match = /^(?:([^/]+)\/)?([^/]+)\/_git\/([^/]+)$/.exec(site.repository);
  if (match === null) return ["--detect", "true"];
  const organization =
    site.host === "dev.azure.com" ? `https://dev.azure.com/${match[1]}` : `https://${site.host}`;
  return ["--organization", organization, "--project", match[2]!, "--repository", match[3]!];
}

export function azureForge(azPath: () => string, site: ForgeSite): Forge {
  const where = azureWhere(site);
  const az = async (args: readonly string[]) =>
    json(
      await runCli(azPath(), [...args, "--only-show-errors", "--output", "json"], {
        cwd: site.cwd,
        env: { AZURE_CORE_NO_COLOR: "true", AZURE_CORE_ONLY_SHOW_ERRORS: "true" },
        missing: "Azure CLI (az) with the azure-devops extension is not installed on this node",
        signedOut: "Azure DevOps CLI is not signed in: run `az devops login` on this node",
        signedOutPattern: AZURE_SIGNED_OUT,
        timeoutMs: 60_000,
      }),
      "az",
    );
  const one = (raw: unknown, what: string) => {
    const found = azureRequest((raw ?? {}) as Record<string, unknown>);
    if (found === undefined) throw new ForgeUnavailable("failed", `az ${what} no pull request`);
    return found.pr;
  };
  return {
    kind: "azure-devops",
    name: "Azure DevOps",
    terminology: PULL_REQUEST,
    find: async (head) => {
      const raw = await az([
        "repos",
        "pr",
        "list",
        ...where,
        "--source-branch",
        head.branch,
        "--status",
        "all",
        "--top",
        "20",
      ]);
      if (!Array.isArray(raw)) throw new ForgeUnavailable("failed", "az answered no list");
      return newest(
        raw
          .map((item) => azureRequest(item as Record<string, unknown>))
          .filter((item) => item !== undefined),
        head,
      );
    },
    at: async (url) => {
      const { host, repository, number } = reference(url);
      const organization =
        host === "dev.azure.com"
          ? `https://dev.azure.com/${repository.split("/")[0]}`
          : `https://${host}`;
      return one(
        await az(["repos", "pr", "show", "--id", String(number), "--organization", organization]),
        "answered",
      );
    },
    create: async ({ base, head, title, bodyFile }) => {
      if (head.owner !== undefined) {
        throw new ForgeUnavailable(
          "failed",
          "Opening an Azure DevOps pull request from a fork is not supported on this node yet",
        );
      }
      return one(
        await az([
          "repos",
          "pr",
          "create",
          ...where,
          "--source-branch",
          head.branch,
          "--target-branch",
          base,
          "--title",
          title,
          "--description",
          await Fs.readFile(bodyFile, "utf8"),
        ]),
        "created",
      );
    },
    templatePaths: [
      ".azuredevops/pull_request_template.md",
      ".vsts/pull_request_template.md",
      "docs/pull_request_template.md",
      "pull_request_template.md",
    ],
  };
}

// --- Bitbucket (REST) ---------------------------------------------------------------------------

/** Bitbucket Cloud's credentials, from the node's environment (T3's, renamed for Jhin). */
function bitbucketAuth(env: NodeJS.ProcessEnv): string {
  const token = env["JHIN_BITBUCKET_ACCESS_TOKEN"];
  if (token) return `Bearer ${token}`;
  const email = env["JHIN_BITBUCKET_EMAIL"];
  const apiToken = env["JHIN_BITBUCKET_API_TOKEN"];
  if (email && apiToken) return `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  throw new ForgeUnavailable(
    "signed-out",
    "Bitbucket needs a token on this node: set JHIN_BITBUCKET_ACCESS_TOKEN, or JHIN_BITBUCKET_EMAIL and JHIN_BITBUCKET_API_TOKEN",
  );
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

function bitbucketRequest(
  raw: Record<string, unknown>,
  checks: readonly CheckWord[],
): ForgePullRequest | undefined {
  const number = raw["id"];
  const links = raw["links"] as { html?: { href?: unknown } } | undefined;
  const url = text(links?.html?.href);
  if (typeof number !== "number" || url === undefined) return undefined;
  const source = raw["source"] as
    | { branch?: { name?: unknown }; repository?: { full_name?: unknown } }
    | undefined;
  const destination = raw["destination"] as typeof source;
  const state = text(raw["state"]);
  const from = text(source?.repository?.full_name);
  const into = text(destination?.repository?.full_name);
  const updated = text(raw["updated_on"]);
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

export function bitbucketForge(site: ForgeSite, env: NodeJS.ProcessEnv = process.env): Forge {
  const base = (env["JHIN_BITBUCKET_API_BASE_URL"] ?? "https://api.bitbucket.org/2.0").replace(
    /\/+$/,
    "",
  );
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const authorization = bitbucketAuth(env);
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: {
          authorization,
          accept: "application/json",
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ForgeUnavailable(
        "failed",
        `Bitbucket could not be reached: ${(error as Error).message}`,
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
        "Bitbucket refused this node's token: check JHIN_BITBUCKET_ACCESS_TOKEN (or JHIN_BITBUCKET_EMAIL and JHIN_BITBUCKET_API_TOKEN)",
      );
    }
    const answer: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = text(
        (answer as { error?: { message?: unknown } } | undefined)?.error?.message,
      );
      throw new ForgeUnavailable("failed", message ?? `Bitbucket answered ${response.status}`);
    }
    return (answer ?? {}) as Record<string, unknown>;
  };
  const repo = (repository: string) => `/repositories/${repository}`;
  const checksOf = async (repository: string, number: number) => {
    const answer = await call(
      `${repo(repository)}/pullrequests/${number}/statuses?pagelen=50`,
    ).catch(() => ({ values: [] }));
    const values = Array.isArray(answer["values"])
      ? (answer["values"] as { state?: unknown }[])
      : [];
    return values.map((value) => statusWord(text(value.state)));
  };
  const full = async (repository: string, raw: Record<string, unknown>) => {
    const number = raw["id"];
    const found = bitbucketRequest(
      raw,
      typeof number === "number" ? await checksOf(repository, number) : [],
    );
    if (found === undefined)
      throw new ForgeUnavailable("failed", "Bitbucket answered no pull request");
    return found;
  };
  return {
    kind: "bitbucket",
    name: "Bitbucket",
    terminology: PULL_REQUEST,
    find: async (head) => {
      const query = encodeURIComponent(
        `source.branch.name="${head.branch.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
      );
      const answer = await call(
        `${repo(site.repository)}/pullrequests?q=${query}&state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED&sort=-updated_on&pagelen=10`,
      );
      const values = Array.isArray(answer["values"])
        ? (answer["values"] as Record<string, unknown>[])
        : [];
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
      const { repository, number } = reference(url);
      return (await full(repository, await call(`${repo(repository)}/pullrequests/${number}`))).pr;
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
    // Bitbucket has no template files of a pull request.
    templatePaths: [],
  };
}

// --- Forgejo and Gitea (tea) ----------------------------------------------------------------------

const TEA_SIGNED_OUT = /tea login|no login|token is required|401|unauthorized/i;

function forgejoRequest(
  raw: Record<string, unknown>,
  checks: readonly CheckWord[],
): ForgePullRequest | undefined {
  const number = raw["number"];
  const url = text(raw["html_url"]);
  if (typeof number !== "number" || url === undefined) return undefined;
  const head = raw["head"] as
    | { ref?: unknown; repo?: { full_name?: unknown; owner?: { login?: unknown } } | null }
    | undefined;
  const base = raw["base"] as { ref?: unknown; repo?: { full_name?: unknown } | null } | undefined;
  const title = text(raw["title"]) ?? `#${number}`;
  const merged = raw["merged"] === true;
  const updated = text(raw["updated_at"]);
  const mergedAt = stamp(raw["merged_at"]).value;
  const closedAt = stamp(raw["closed_at"]).value;
  const from = text(head?.repo?.full_name);
  const into = text(base?.repo?.full_name);
  const owner = text(head?.repo?.owner?.login);
  return {
    pr: {
      number,
      title,
      url,
      state: merged ? "merged" : text(raw["state"]) === "closed" ? "closed" : "open",
      isDraft: raw["draft"] === true || /^(\[WIP\]|WIP:)/i.test(title),
      headBranch: text(head?.ref) ?? "",
      baseBranch: text(base?.ref) ?? "",
      ...(updated ? { updatedAt: updated } : {}),
      ...(merged && mergedAt ? { mergedAt } : {}),
      ...(!merged && closedAt ? { closedAt } : {}),
      checks: rollup(checks),
    },
    ...(from !== undefined && into !== undefined
      ? { crossRepository: from.toLowerCase() !== into.toLowerCase() }
      : {}),
    ...(owner === undefined ? {} : { headOwner: owner }),
  };
}

export function forgejoForge(teaPath: () => string, site: ForgeSite): Forge {
  const tea = async (endpoint: string, init: { method?: string; body?: unknown } = {}) => {
    const answer = json(
      await runCli(
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
          signedOut: "tea is not signed in to this server: run `tea login add` on this node",
          signedOutPattern: TEA_SIGNED_OUT,
        },
      ),
      "tea",
    );
    // tea exits 0 on an HTTP error and prints the server's error body.
    const message = text((answer as { message?: unknown } | null)?.message);
    if (
      message !== undefined &&
      !Array.isArray(answer) &&
      (answer as { number?: unknown }).number === undefined
    ) {
      if (TEA_SIGNED_OUT.test(message)) {
        throw new ForgeUnavailable(
          "signed-out",
          "tea is not signed in to this server: run `tea login add` on this node",
        );
      }
      throw new ForgeUnavailable("failed", message);
    }
    return answer;
  };
  const checksOf = async (repository: string, sha: string | undefined) => {
    if (sha === undefined) return [];
    const answer = (await tea(`/repos/${repository}/commits/${sha}/status`).catch(
      () => undefined,
    )) as { statuses?: { status?: unknown }[] } | undefined;
    return (answer?.statuses ?? []).map((status): CheckWord => {
      const word = text(status.status);
      return word === "success"
        ? "success"
        : word === "failure" || word === "error"
          ? "failure"
          : "pending";
    });
  };
  const full = async (repository: string, raw: Record<string, unknown>) => {
    const head = raw["head"] as { sha?: unknown } | undefined;
    const found = forgejoRequest(raw, await checksOf(repository, text(head?.sha)));
    if (found === undefined) throw new ForgeUnavailable("failed", "tea answered no pull request");
    return found;
  };
  return {
    kind: "forgejo",
    name: "Forgejo",
    terminology: PULL_REQUEST,
    find: async (head) => {
      const answer = await tea(
        `/repos/${site.repository}/pulls?state=all&sort=recentupdate&limit=50`,
      );
      if (!Array.isArray(answer)) throw new ForgeUnavailable("failed", "tea answered no list");
      const values = answer as Record<string, unknown>[];
      const match = values.find((value) => {
        const found = forgejoRequest(value, []);
        return (
          found !== undefined && found.pr.headBranch === head.branch && matchesHead(found, head)
        );
      });
      return match === undefined ? null : (await full(site.repository, match)).pr;
    },
    at: async (url) => {
      const { repository, number } = reference(url);
      return (
        await full(
          repository,
          (await tea(`/repos/${repository}/pulls/${number}`)) as Record<string, unknown>,
        )
      ).pr;
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
      return (await full(site.repository, answer as Record<string, unknown>)).pr;
    },
    templatePaths: [
      ".forgejo/pull_request_template.md",
      ".gitea/pull_request_template.md",
      ".github/pull_request_template.md",
      "docs/pull_request_template.md",
    ],
  };
}

/** The `owner/repo` and host of a remote, for the forges that need them. */
export function siteOf(cwd: string, remoteUrl: string): ForgeSite | undefined {
  const remote = repositoryOfRemote(remoteUrl);
  return remote === undefined
    ? undefined
    : { cwd, host: remote.host, repository: remote.repository };
}
