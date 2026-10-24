// The forges other than GitHub follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/source-control-gitlab (GitLabCli.ts: `glab mr list --source-branch`, `glab api
// projects/:path/merge_requests`; gitLabMergeRequestJson.ts: states, drafts, the pipeline as a
// check), packages/source-control-azure-devops (AzureDevOpsCli.ts: `az repos pr list|show|
// create`; states), with their messages; Bitbucket and Forgejo are bitbucket.ts and forgejo.ts.
// Listing and watching follow GitLabPullRequestCli.ts and gitLabMergeRequestJson.ts (the merge
// request list, its notes, toChecks, toMergeability) and AzureDevOpsPullRequestCli.ts and
// azureDevOpsPullRequestJson.ts (the list, the threads' comments, toMergeability), and
// resolving a reference follows GitLabCli.ts and AzureDevOpsCli.ts (normalizeChangeRequestId).
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
  numberedReference,
  rollup,
  runCli,
  text,
  viewerOf,
  type CheckWord,
  type Forge,
  type ForgePullRequest,
  type HeadContext,
  type Viewers,
} from "./forge.ts";
import type { Remark, WatchRead } from "./pr-watch.ts";

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

/** T3's query helper: `key=value` pairs, the values encoded. */
const queryString = (params: readonly (readonly [string, string])[]) =>
  params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");

const watchState = (pr: PullRequest): WatchRead["state"] => pr.state;

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
      ...(text(raw["sha"]) === undefined ? {} : { headSha: text(raw["sha"])! }),
      ...(updated ? { updatedAt: updated } : {}),
      ...(merged ? { mergedAt: merged } : {}),
      ...(closed ? { closedAt: closed } : {}),
      checks: rollup(pipeline?.status === undefined ? [] : [pipelineWord(text(pipeline.status))]),
      ...gitlabDetails(raw),
    },
    ...(typeof source === "number" && typeof target === "number"
      ? { crossRepository: source !== target }
      : {}),
  };
}

/** T3's row details of a merge request (D1449): its author, files count and mergeability. */
function gitlabDetails(raw: Record<string, unknown>): Partial<PullRequest> {
  const author = raw["author"] as
    | { username?: unknown; name?: unknown; avatar_url?: unknown }
    | null
    | undefined;
  const login = text(author?.username);
  // "1000+" past GitLab's count.
  const files = Number.parseInt(text(raw["changes_count"]) ?? "", 10);
  return {
    ...(login === undefined
      ? {}
      : {
          author: {
            login,
            name: text(author?.name) ?? null,
            avatarUrl: text(author?.avatar_url) ?? null,
          },
        }),
    ...(Number.isInteger(files) && files >= 0 ? { changedFiles: files } : {}),
    ...(raw["has_conflicts"] !== undefined || raw["merge_status"] !== undefined
      ? { mergeability: gitlabMergeability(raw) }
      : {}),
  };
}

/** A note of a merge request, as T3's decodeNotesJson keeps it: no system notes, none empty. */
function gitlabRemark(raw: Record<string, unknown>): Remark | undefined {
  if (raw["system"] === true) return undefined;
  const body = text(raw["body"]) ?? "";
  const createdAt = text(raw["created_at"]);
  const id = raw["id"];
  if (
    body.trim() === "" ||
    createdAt === undefined ||
    (typeof id !== "number" && typeof id !== "string")
  ) {
    return undefined;
  }
  const author = raw["author"] as { username?: unknown } | null | undefined;
  const position = raw["position"] as { new_path?: unknown; old_path?: unknown } | null | undefined;
  const path = text(position?.new_path) ?? text(position?.old_path);
  const edited = text(raw["updated_at"]);
  return {
    id: String(id),
    author: text(author?.username) ?? null,
    body,
    createdAt,
    ...(edited !== undefined && edited !== createdAt ? { editedAt: edited } : {}),
    ...(path === undefined ? {} : { path }),
  };
}

/** T3's toMergeability for GitLab: `has_conflicts`, else `merge_status`. */
function gitlabMergeability(raw: Record<string, unknown>): WatchRead["mergeability"] {
  if (raw["has_conflicts"] === true) return "conflicting";
  const status = text(raw["merge_status"])?.trim().toLowerCase();
  return status === "can_be_merged"
    ? "mergeable"
    : status === "cannot_be_merged"
      ? "conflicting"
      : "unknown";
}

export function gitlabForge(glabPath: () => string, site: ForgeSite, viewers: Viewers): Forge {
  const glabRun = (args: readonly string[]) =>
    runCli(glabPath(), args, {
      cwd: site.cwd,
      env: { GLAB_NO_PROMPT: "1", NO_COLOR: "1", GLAB_CHECK_UPDATE: "false" },
      missing: "GitLab CLI (glab) is not installed on this node",
      signedOut: "GitLab CLI is not signed in: run `glab auth login` on this node",
      signedOutPattern: GITLAB_SIGNED_OUT,
      timeoutMs: 60_000,
    });
  const glab = async (args: readonly string[]) => json(await glabRun(args), "glab");
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
  const forge: Forge = {
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
    // A number or a merge request URL (D1443); a fork's source project is asked for its path.
    resolve: async (value) => {
      const found = numberedReference(value, forge);
      const host = found.host ?? site.host;
      const repository = found.repository ?? site.repository;
      const raw = ((await glab([
        "api",
        "--hostname",
        host,
        `${project(repository)}/merge_requests/${found.number}`,
      ])) ?? {}) as Record<string, unknown>;
      const request = gitlabRequest(raw);
      if (request === undefined) {
        throw new ForgeUnavailable("failed", "glab answered no merge request");
      }
      const source = raw["source_project_id"];
      if (request.crossRepository !== true || typeof source !== "number") {
        return { ...request, pullRefs: false };
      }
      const fork = (await glab(["api", "--hostname", host, `projects/${source}`])) as {
        path_with_namespace?: unknown;
      } | null;
      const headRepository = text(fork?.path_with_namespace);
      return {
        ...request,
        pullRefs: false,
        ...(headRepository === undefined
          ? {}
          : { headRepository, headOwner: headRepository.split("/")[0]! }),
      };
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
    // T3's listMergeRequests: any state, most recently updated first, `search` on GitLab.
    list: async ({ query: words, limit }) => {
      if (site.repository === "") throw new ForgeUnavailable("failed", "No GitLab project to list");
      const trimmed = words?.trim() ?? "";
      const raw = await glab([
        "api",
        "--hostname",
        site.host,
        `${project(site.repository)}/merge_requests?${queryString([
          ["state", "all"],
          ...(trimmed === "" ? [] : ([["search", trimmed]] as const)),
          ["order_by", "updated_at"],
          ["sort", "desc"],
          ["per_page", String(limit)],
        ])}`,
      ]);
      if (!Array.isArray(raw)) throw new ForgeUnavailable("failed", "glab answered no list");
      return raw
        .map((item) => gitlabRequest(item as Record<string, unknown>)?.pr)
        .filter((item) => item !== undefined);
    },
    // What a watch reads (D1287): the merge request, its notes and the node's account.
    watch: async (url) => {
      const { host, repository, number } = reference(url);
      const path = `${project(repository)}/merge_requests/${number}`;
      const [raw, notes, viewer] = await Promise.all([
        glab(["api", "--hostname", host, path]),
        glab([
          "api",
          "--hostname",
          host,
          `${path}/notes?${queryString([
            // The newest hundred: what a watch has not told yet is among them.
            ["per_page", "100"],
            ["order_by", "created_at"],
            ["sort", "desc"],
          ])}`,
        ]),
        viewerOf(viewers, `glab\u0000${host}`, async () => {
          const user = (await glab(["api", "--hostname", host, "user"])) as {
            username?: unknown;
          } | null;
          return text(user?.username) ?? null;
        }),
      ]);
      const request = (raw ?? {}) as Record<string, unknown>;
      const found = gitlabRequest(request);
      if (found === undefined)
        throw new ForgeUnavailable("failed", "glab answered no merge request");
      const pipeline = request["head_pipeline"] as
        | { status?: unknown; web_url?: unknown }
        | null
        | undefined;
      const pipelineUrl = text(pipeline?.web_url);
      const author = request["author"] as { username?: unknown } | null | undefined;
      return {
        state: watchState(found.pr),
        headSha: found.pr.headSha ?? null,
        baseBranch: found.pr.baseBranch,
        // T3's toChecks: the head pipeline is the one check.
        checks:
          pipeline == null
            ? []
            : [
                {
                  name: "Pipeline",
                  status: pipelineWord(text(pipeline.status)),
                  ...(pipelineUrl === undefined ? {} : { url: pipelineUrl }),
                },
              ],
        mergeability: gitlabMergeability(request),
        author: text(author?.username) ?? null,
        viewer,
        remarks: (Array.isArray(notes) ? notes : [])
          .map((item) => gitlabRemark(item as Record<string, unknown>))
          .filter((item) => item !== undefined)
          .toReversed(),
      };
    },
    templatePaths: [
      ".gitlab/merge_request_templates/Default.md",
      ".gitlab/merge_request_templates/default.md",
    ],
    actions: ["merge", "ready", "close", "reopen"],
    // T3's GitLab merge capabilities: the project's merge method and squash option (D1450).
    mergeMethods: async (url) => {
      const { host, repository } = reference(url);
      const raw = ((await glab(["api", "--hostname", host, project(repository)])) ?? {}) as Record<
        string,
        unknown
      >;
      const method = text(raw["merge_method"]);
      const squash = text(raw["squash_option"]);
      return [
        ...(method === "merge" ? (["merge"] as const) : []),
        ...(squash === "always" || squash === "default_on" || squash === "default_off"
          ? (["squash"] as const)
          : []),
        ...(method === "rebase_merge" || method === "ff" ? (["rebase"] as const) : []),
      ];
    },
    // T3's `glab mr <action> <iid> --repo <project>` (D1451).
    act: async (url, action, method) => {
      const { host, repository, number } = reference(url);
      const where = ["--repo", `https://${host}/${repository}`];
      await glabRun(
        action === "merge"
          ? [
              "mr",
              "merge",
              String(number),
              ...where,
              "--yes",
              "--auto-merge=false",
              ...(method === "squash" ? ["--squash"] : method === "rebase" ? ["--rebase"] : []),
            ]
          : action === "ready"
            ? ["mr", "update", String(number), ...where, "--ready"]
            : ["mr", action, String(number), ...where],
      );
    },
  };
  return forge;
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
      ...azureDetails(raw),
    },
    crossRepository: raw["forkSource"] !== null && raw["forkSource"] !== undefined,
  };
}

/** T3's row details of an Azure DevOps pull request (D1449): its author and mergeability. */
function azureDetails(raw: Record<string, unknown>): Partial<PullRequest> {
  const author = raw["createdBy"] as
    | { uniqueName?: unknown; displayName?: unknown; imageUrl?: unknown }
    | null
    | undefined;
  const login = text(author?.uniqueName) ?? text(author?.displayName);
  const status = text(raw["mergeStatus"]);
  return {
    ...(login === undefined
      ? {}
      : {
          author: {
            login,
            name: text(author?.displayName) ?? null,
            avatarUrl: text(author?.imageUrl) ?? null,
          },
        }),
    ...(status === undefined ? {} : { mergeability: azureMergeability(status) }),
  };
}

/**
 * Which Azure DevOps repository: the one `site` names (`org/project/_git/repo`
 * on dev.azure.com, `project/_git/repo` on `<org>.visualstudio.com`), else
 * the folder's (`--detect`).
 */
function azureWhere(site: ForgeSite): string[] {
  const location = azureLocation(site.host, site.repository);
  if (location === undefined) return ["--detect", "true"];
  return [
    "--organization",
    location.organization,
    "--project",
    location.project,
    "--repository",
    location.repository,
  ];
}

/** T3's toMergeability for Azure DevOps. */
function azureMergeability(status: string | undefined): WatchRead["mergeability"] {
  switch (status?.trim().toLowerCase()) {
    case "succeeded":
      return "mergeable";
    case "conflicts":
    case "failure":
    case "rejectedbypolicy":
      return "conflicting";
    default:
      return "unknown";
  }
}

/** The comments of a pull request's threads, as T3's decodeThreadsJson keeps them. */
function azureRemarks(raw: unknown): Remark[] {
  const threads = (raw as { value?: unknown } | null)?.value;
  const remarks: Remark[] = [];
  for (const thread of Array.isArray(threads) ? threads : []) {
    const entry = thread as {
      id?: unknown;
      isDeleted?: unknown;
      threadContext?: { filePath?: unknown } | null;
      comments?: unknown;
    };
    if (entry.isDeleted === true) continue;
    const path = text(entry.threadContext?.filePath);
    for (const comment of Array.isArray(entry.comments) ? entry.comments : []) {
      const item = comment as {
        id?: unknown;
        isDeleted?: unknown;
        commentType?: unknown;
        content?: unknown;
        publishedDate?: unknown;
        lastUpdatedDate?: unknown;
        author?: { uniqueName?: unknown; displayName?: unknown } | null;
      };
      const body = text(item.content) ?? "";
      const createdAt = text(item.publishedDate);
      if (
        item.isDeleted === true ||
        text(item.commentType)?.toLowerCase() === "system" ||
        body.trim() === "" ||
        createdAt === undefined
      ) {
        continue;
      }
      const edited = text(item.lastUpdatedDate);
      remarks.push({
        id: `${String(entry.id ?? 0)}:${String(item.id ?? 0)}`,
        author: text(item.author?.uniqueName) ?? text(item.author?.displayName) ?? null,
        body,
        createdAt,
        ...(edited !== undefined && edited !== createdAt ? { editedAt: edited } : {}),
        ...(path === undefined ? {} : { path }),
      });
    }
  }
  return remarks.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * The organization (with its collection on a server), project and repository of an Azure
 * DevOps repository path: `org/project/_git/repo` on dev.azure.com, `project/_git/repo` on
 * `<org>.visualstudio.com`, `collection/project/_git/repo` on a server.
 */
function azureLocation(host: string, repository: string) {
  const match = /^(?:(.+)\/)?([^/]+)\/_git\/([^/]+)$/.exec(repository);
  if (match === null) return undefined;
  const prefix = match[1];
  const organization =
    host === "dev.azure.com"
      ? `https://dev.azure.com/${prefix ?? ""}`
      : `https://${host}${prefix === undefined ? "" : `/${prefix}`}`;
  return { organization, project: match[2]!, repository: match[3]! };
}

export function azureForge(azPath: () => string, site: ForgeSite, viewers: Viewers): Forge {
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
  const forge: Forge = {
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
    // A number or a pull request URL (T3's normalizeChangeRequestId, D1443). A fork's
    // repository is not named here, so its checkout is refused.
    resolve: async (value) => {
      const found = numberedReference(value, forge);
      const location =
        found.host === undefined
          ? azureLocation(site.host, site.repository)
          : azureLocation(found.host, found.repository ?? "");
      const raw = await az([
        "repos",
        "pr",
        "show",
        "--id",
        String(found.number),
        ...(location === undefined
          ? ["--detect", "true"]
          : ["--organization", location.organization]),
      ]);
      const request = azureRequest((raw ?? {}) as Record<string, unknown>);
      if (request === undefined)
        throw new ForgeUnavailable("failed", "az answered no pull request");
      return { ...request, pullRefs: false };
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
    // T3's listPullRequests: any state, newest first. `az` searches no text, so words are
    // matched here against the title and number, as the composer ranks them anyway.
    list: async ({ query: words, limit }) => {
      const trimmed = words?.trim().toLowerCase() ?? "";
      const raw = await az([
        "repos",
        "pr",
        "list",
        ...where,
        "--status",
        "all",
        "--top",
        String(trimmed === "" ? limit : Math.max(limit, 100)),
      ]);
      if (!Array.isArray(raw)) throw new ForgeUnavailable("failed", "az answered no list");
      return raw
        .map((item) => azureRequest(item as Record<string, unknown>)?.pr)
        .filter((item) => item !== undefined)
        .filter(
          (pr) =>
            trimmed === "" ||
            pr.title.toLowerCase().includes(trimmed) ||
            String(pr.number) === trimmed.replace(/^#/, ""),
        )
        .slice(0, limit);
    },
    // What a watch reads (D1288): the pull request, its threads' comments and the node's
    // account; Azure DevOps has no checks here, as in T3.
    watch: async (url) => {
      const { host, repository, number } = reference(url);
      const location = azureLocation(host, repository);
      if (location === undefined) {
        throw new ForgeUnavailable("failed", `${url} names no Azure DevOps repository`);
      }
      const [raw, threads, viewer] = await Promise.all([
        az([
          "repos",
          "pr",
          "show",
          "--id",
          String(number),
          "--organization",
          location.organization,
        ]),
        az([
          "devops",
          "invoke",
          "--organization",
          location.organization,
          "--area",
          "git",
          "--resource",
          "pullRequestThreads",
          "--api-version",
          "7.1",
          "--route-parameters",
          `project=${location.project}`,
          `repositoryId=${location.repository}`,
          `pullRequestId=${number}`,
        ]),
        viewerOf(viewers, `az\u0000${location.organization}`, async () => {
          const user = (await az(["account", "show", "--query", "user"])) as {
            name?: unknown;
          } | null;
          return text(user?.name) ?? null;
        }),
      ]);
      const request = (raw ?? {}) as Record<string, unknown>;
      const pr = one(request, "answered");
      const source = request["lastMergeSourceCommit"] as { commitId?: unknown } | null | undefined;
      const author = request["createdBy"] as { uniqueName?: unknown } | null | undefined;
      return {
        state: watchState(pr),
        headSha: text(source?.commitId) ?? null,
        baseBranch: pr.baseBranch,
        checks: [],
        mergeability: azureMergeability(text(request["mergeStatus"])),
        author: text(author?.uniqueName) ?? null,
        viewer,
        remarks: azureRemarks(threads),
      };
    },
    templatePaths: [
      ".azuredevops/pull_request_template.md",
      ".vsts/pull_request_template.md",
      "docs/pull_request_template.md",
      "pull_request_template.md",
    ],
    actions: ["merge", "ready", "close", "reopen"],
    // T3's Azure DevOps merge capabilities: a merge or a squash.
    mergeMethods: () => Promise.resolve(["merge", "squash"]),
    // T3's `az repos pr update --id <n>` (D1451).
    act: async (url, action, method) => {
      const { host, repository, number } = reference(url);
      const location = azureLocation(host, repository);
      if (location === undefined) {
        throw new ForgeUnavailable("failed", `${url} names no Azure DevOps repository`);
      }
      await az([
        "repos",
        "pr",
        "update",
        "--id",
        String(number),
        "--organization",
        location.organization,
        ...(action === "merge"
          ? ["--status", "completed", "--squash", method === "squash" ? "true" : "false"]
          : action === "ready"
            ? ["--draft", "false"]
            : ["--status", action === "close" ? "abandoned" : "active"]),
      ]);
    },
  };
  return forge;
}

/** The `owner/repo` and host of a remote, for the forges that need them. */
export function siteOf(cwd: string, remoteUrl: string): ForgeSite | undefined {
  const remote = repositoryOfRemote(remoteUrl);
  return remote === undefined
    ? undefined
    : { cwd, host: remote.host, repository: remote.repository };
}
