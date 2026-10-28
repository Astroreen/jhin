// Publishing a repository follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/sourceControl/SourceControlRepositoryService.ts (publishRepository,
// publishPushFailureDetail), the GitHub provider's createRepository (`user/repos` or
// `orgs/<owner>/repos`) and GitLabCli.ts's createRepository (`namespaces/<path>`, then `POST
// projects`). docs/plans/source-control.md D1667.
import { ForgeUnavailable, json, runCli, text } from "./forge.ts";
import type { Git } from "./git.ts";

export const PUBLISH_FORGES = ["github", "gitlab"] as const;
export type PublishForge = (typeof PUBLISH_FORGES)[number];

/** A created repository's addresses (T3's `SourceControlRepositoryCloneUrls`). */
export interface CloneUrls {
  readonly nameWithOwner: string;
  /** Its web page. */
  readonly url: string;
  readonly sshUrl: string;
  readonly httpsUrl: string;
}

const SIGNED_OUT = /not logged|auth login|401|unauthori[sz]ed|no token/i;

/** `owner/name` (GitLab: `group/subgroup/name`), refusing what is not a repository path. */
function repositoryPath(repository: string): { owner: string; name: string } {
  const trimmed = repository.trim().replace(/^\/+|\/+$/g, "");
  const parts = trimmed.split("/");
  const name = parts.pop() ?? "";
  if (
    parts.length === 0 ||
    name === "" ||
    [...parts, name].some(
      (part) => part === "" || part === "." || part === ".." || /[\s?#%\\]/.test(part),
    )
  ) {
    throw new ForgeUnavailable("failed", `${repository} names no owner/repository.`);
  }
  return { owner: parts.join("/"), name };
}

/** Creates the repository on GitHub, under the account or an organization it may create in. */
async function createOnGitHub(
  gh: string,
  cwd: string,
  input: { readonly repository: string; readonly visibility: "private" | "public" },
): Promise<CloneUrls> {
  const { owner, name } = repositoryPath(input.repository);
  const options = {
    cwd,
    env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
    missing: "GitHub CLI (gh) is not installed on this node",
    signedOut: "GitHub CLI is not signed in: run `gh auth login` on this node",
    signedOutPattern: SIGNED_OUT,
  };
  const viewer = text(
    (json(await runCli(gh, ["api", "user"], options), "gh") as Record<string, unknown> | null)?.[
      "login"
    ],
  );
  if (viewer === undefined) {
    throw new ForgeUnavailable("failed", "GitHub did not say which account is signed in.");
  }
  if (owner.includes("/")) {
    throw new ForgeUnavailable("failed", `${input.repository} names no GitHub owner/repository.`);
  }
  const own = viewer.toLowerCase() === owner.toLowerCase();
  let created: Record<string, unknown> | null;
  try {
    created = json(
      await runCli(
        gh,
        [
          "api",
          "--method",
          "POST",
          own ? "user/repos" : `orgs/${encodeURIComponent(owner)}/repos`,
          "-f",
          `name=${name}`,
          "-F",
          `private=${input.visibility === "private"}`,
        ],
        options,
      ),
      "gh",
    ) as Record<string, unknown> | null;
  } catch (error) {
    // GitHub answers 404 for an organization the account cannot create repositories in.
    if (!own && error instanceof ForgeUnavailable && /404|Not Found/i.test(error.message)) {
      throw new ForgeUnavailable(
        "failed",
        `No organization named ${owner} that this account can create repositories in.`,
      );
    }
    throw error;
  }
  const nameWithOwner = text(created?.["full_name"]);
  const url = text(created?.["html_url"]);
  const sshUrl = text(created?.["ssh_url"]);
  const httpsUrl = text(created?.["clone_url"]);
  if (!nameWithOwner || !url || !sshUrl || !httpsUrl) {
    throw new ForgeUnavailable("failed", "GitHub returned an invalid repository.");
  }
  return { nameWithOwner, url, sshUrl, httpsUrl };
}

/** Creates the project on GitLab, in the namespace the path names. */
async function createOnGitLab(
  glab: string,
  cwd: string,
  input: { readonly repository: string; readonly visibility: "private" | "public" },
): Promise<CloneUrls> {
  const { owner, name } = repositoryPath(input.repository);
  const options = {
    cwd,
    missing: "GitLab CLI (glab) is not installed on this node",
    signedOut: "GitLab CLI is not signed in: run `glab auth login` on this node",
    signedOutPattern: SIGNED_OUT,
  };
  const namespace = json(
    await runCli(glab, ["api", `namespaces/${encodeURIComponent(owner)}`], options),
    "glab",
  ) as Record<string, unknown> | null;
  const namespaceId = namespace?.["id"];
  if (typeof namespaceId !== "number") {
    throw new ForgeUnavailable("failed", "GitLab CLI returned invalid namespace JSON.");
  }
  const created = json(
    await runCli(
      glab,
      [
        "api",
        "--method",
        "POST",
        "projects",
        "--raw-field",
        `path=${name}`,
        "--raw-field",
        `name=${name}`,
        "--raw-field",
        `visibility=${input.visibility}`,
        "--raw-field",
        `namespace_id=${namespaceId}`,
      ],
      options,
    ),
    "glab",
  ) as Record<string, unknown> | null;
  const nameWithOwner = text(created?.["path_with_namespace"]);
  const url = text(created?.["web_url"]);
  const sshUrl = text(created?.["ssh_url_to_repo"]);
  const httpsUrl = text(created?.["http_url_to_repo"]);
  if (!nameWithOwner || !url || !sshUrl || !httpsUrl) {
    throw new ForgeUnavailable("failed", "GitLab CLI returned invalid repository JSON.");
  }
  return { nameWithOwner, url, sshUrl, httpsUrl };
}

export function createRepository(
  forge: PublishForge,
  tools: { readonly gh: string; readonly glab: string; readonly cwd: string },
  input: { readonly repository: string; readonly visibility: "private" | "public" },
): Promise<CloneUrls> {
  return forge === "github"
    ? createOnGitHub(tools.gh, tools.cwd, input)
    : createOnGitLab(tools.glab, tools.cwd, input);
}

/**
 * T3's ensureRemote: a remote that already points at `url` is reused, else `preferred`, else
 * `preferred-2`, `preferred-3`, … whichever is free.
 */
export async function ensureRemote(git: Git, preferred: string, url: string): Promise<string> {
  const remotes = (await git(["remote"])).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  for (const remote of remotes) {
    const current = await git(["config", "--get", `remote.${remote}.url`], { ok: [0, 1] });
    if (current.stdout.trim() === url) return remote;
  }
  let name = preferred;
  for (let index = 2; remotes.includes(name); index += 1) name = `${preferred}-${index}`;
  await git(["remote", "add", name, url]);
  return name;
}

/** T3's publishPushFailureDetail: what was done, why the push failed and what to do. */
export function pushFailureDetail(input: {
  readonly urls: CloneUrls;
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly error: string;
}): string {
  const created = `Created ${input.urls.nameWithOwner} and added it as remote "${input.remoteName}", but the push failed`;
  const switchToHttps = `git remote set-url ${input.remoteName} ${input.urls.httpsUrl}`;
  const usesSsh = input.remoteUrl === input.urls.sshUrl;
  if (/Host key verification failed/i.test(input.error)) {
    return `${created} because the host's SSH key is not trusted yet. Verify it by connecting once with ssh, or switch the remote to HTTPS with "${switchToHttps}", then push again.`;
  }
  if (
    /Permission denied|publickey|Authentication failed|could not read Username/i.test(input.error)
  ) {
    return usesSsh
      ? `${created} because SSH authentication was rejected. Add an SSH key to your account, or switch the remote to HTTPS with "${switchToHttps}", then push again.`
      : `${created} because Git could not authenticate. Check your Git credentials, then push again.`;
  }
  return `${created}. Fix the problem, then push again.`;
}
