// Pull requests linked to threads follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// packages/contracts/src/threadPullRequest.ts (a link and its key), packages/shared/src/
// threadPullRequests.ts (keys, chains), apps/server/src/mcp/toolkits/pullRequests (resolving a
// link from a URL or a repository and number, and their messages) and
// apps/server/src/git/linkCreatedPullRequest.ts (linking the pull request an action created).
import {
  SourceControlEvents,
  ThreadPullRequest,
  parsePullRequestUrl,
  pullRequestKey,
  repositoryOfRemote,
  type PullRequest,
  type PullRequestLinkSource,
  type PullRequestReference,
  type ThreadPullRequests,
} from "@jhin/source-control-api";
import type { Json, KeyValueStore } from "@jhin/storage-api";

import { SourceControlError } from "./git.ts";

const NAMESPACE = "jhin.source-control";

/** How a link is named: a URL, or a repository and number (on `host`, else the project's). */
interface LinkTarget {
  readonly url?: string | undefined;
  readonly repository?: string | undefined;
  readonly number?: number | undefined;
  readonly host?: string | undefined;
}

export interface LinksDeps {
  readonly kv: KeyValueStore;
  append(type: string, payload: unknown): Promise<void>;
  /** The remote URL of a thread's project, if it has one. */
  remoteOf(threadId: string): Promise<string | null>;
  /** Reads a pull request from its forge, or `undefined` when no forge here can. */
  read(threadId: string, link: ThreadPullRequest): Promise<PullRequest | undefined>;
  warn(message: string, fields: Record<string, unknown>): void;
}

export interface Links {
  /** Stops writing: reads still running when the plugin goes write nothing. */
  dispose(): void;
  /** Resolves once the reads started by `link` have ended (for tests and disposal). */
  settled(): Promise<void>;
  list(threadId: string): Promise<ThreadPullRequest[]>;
  all(): Promise<ThreadPullRequests[]>;
  link(
    threadId: string,
    target: LinkTarget,
    source: PullRequestLinkSource,
    snapshot?: PullRequest,
  ): Promise<{ pullRequest: ThreadPullRequest; alreadyLinked: boolean }>;
  unlink(threadId: string, target: LinkTarget): Promise<{ key: string; wasLinked: boolean }>;
  /** Reads the linked pull requests again: the open ones and the unread, or all with `all`. */
  sync(threadId: string, options?: { all?: boolean }): Promise<void>;
  /** Every thread with links, for the periodic read. */
  threads(): Promise<string[]>;
  /** Replaces a link's record (its snapshot, or the watch of D272) and publishes it. */
  update(threadId: string, link: ThreadPullRequest): Promise<void>;
  remove(threadId: string): Promise<void>;
}

/** A pull request's URL on a forge, from its repository and number. */
export function pullRequestUrl(reference: PullRequestReference): string {
  const host = reference.host;
  if (host.includes("gitlab")) {
    return `https://${host}/${reference.repository}/-/merge_requests/${reference.number}`;
  }
  if (host.includes("bitbucket")) {
    return `https://${host}/${reference.repository}/pull-requests/${reference.number}`;
  }
  if (reference.repository.includes("/_git/")) {
    return `https://${host}/${reference.repository}/pullrequest/${reference.number}`;
  }
  return `https://${host}/${reference.repository}/pull/${reference.number}`;
}

export function createLinks(deps: LinksDeps): Links {
  const links = new Map<string, ThreadPullRequest[]>();
  let loaded: Promise<void> | undefined;
  /** Changes to one thread's links run one at a time. */
  const chains = new Map<string, Promise<unknown>>();

  let disposed = false;
  /** Reads started by `link`, so disposal and tests can wait for them. */
  const reads = new Set<Promise<unknown>>();
  /** Links whose last read failed: a failure is reported once, not every period. */
  const failing = new Set<string>();

  const load = () => {
    loaded ??= (async () => {
      for (const entry of await deps.kv.list(NAMESPACE, { prefix: "links/" })) {
        const parsed = ThreadPullRequest.array().safeParse(entry.value);
        if (!parsed.success) {
          deps.warn("stored links of a thread cannot be read", {
            key: entry.key,
            error: parsed.error.message,
          });
          continue;
        }
        if (parsed.data.length > 0) links.set(entry.key.slice("links/".length), parsed.data);
      }
    })();
    // A storage hiccup is not kept: the next call reads again.
    loaded.catch(() => {
      loaded = undefined;
    });
    return loaded;
  };

  function queued<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const next = (chains.get(threadId) ?? Promise.resolve()).then(task);
    chains.set(
      threadId,
      next.catch(() => undefined),
    );
    return next;
  }

  const save = async (threadId: string, list: ThreadPullRequest[]) => {
    if (disposed) return;
    if (list.length === 0) {
      links.delete(threadId);
      await deps.kv.delete(NAMESPACE, `links/${threadId}`);
    } else {
      links.set(threadId, list);
      await deps.kv.set(NAMESPACE, `links/${threadId}`, list as unknown as Json);
    }
  };

  const resolve = async (threadId: string, target: LinkTarget): Promise<PullRequestReference> => {
    if (target.url !== undefined) {
      const parsed = parsePullRequestUrl(target.url);
      if (parsed === undefined) {
        throw new SourceControlError(
          "PULL_REQUEST_INVALID",
          "This is not a recognised pull request URL. Pass repository and number instead.",
        );
      }
      return parsed;
    }
    if (target.repository === undefined || target.number === undefined) {
      throw new SourceControlError(
        "PULL_REQUEST_INVALID",
        "Pass either url, or both repository and number.",
      );
    }
    let host = target.host?.toLowerCase();
    if (host === undefined) {
      const remote = await deps.remoteOf(threadId);
      host = remote === null ? undefined : repositoryOfRemote(remote)?.host;
    }
    if (host === undefined) {
      throw new SourceControlError(
        "PULL_REQUEST_INVALID",
        "This thread's project has no recognised remote. Pass host or url.",
      );
    }
    return { host, repository: target.repository, number: target.number };
  };

  const readInto = async (threadId: string, link: ThreadPullRequest) => {
    try {
      const snapshot = await deps.read(threadId, link);
      failing.delete(link.key);
      if (snapshot === undefined) return link;
      return { ...link, snapshot, syncedAt: new Date().toISOString() };
    } catch (error) {
      if (!failing.has(link.key)) {
        failing.add(link.key);
        deps.warn("reading a linked pull request failed", {
          threadId,
          key: link.key,
          error: String(error),
        });
      }
      return link;
    }
  };

  const service: Links = {
    dispose() {
      disposed = true;
    },
    async settled() {
      while (reads.size > 0) await Promise.allSettled(reads);
    },
    async list(threadId) {
      await load();
      return links.get(threadId) ?? [];
    },
    async all() {
      await load();
      return [...links].map(([threadId, pullRequests]) => ({ threadId, pullRequests }));
    },
    async link(threadId, target, source, snapshot) {
      await load();
      const reference = await resolve(threadId, target);
      const key = pullRequestKey(reference);
      const result = await queued(threadId, async () => {
        const list = links.get(threadId) ?? [];
        const known = list.find((link) => link.key === key);
        if (known !== undefined) return { pullRequest: known, alreadyLinked: true };
        const pullRequest: ThreadPullRequest = {
          key,
          host: reference.host,
          repository: reference.repository,
          number: reference.number,
          url: target.url?.trim() || snapshot?.url || pullRequestUrl(reference),
          source,
          linkedAt: new Date().toISOString(),
          snapshot: snapshot ?? null,
          ...(snapshot === undefined ? {} : { syncedAt: new Date().toISOString() }),
        };
        await save(threadId, [...list, pullRequest]);
        await deps.append(SourceControlEvents.pullRequestLinked, { threadId, pullRequest });
        return { pullRequest, alreadyLinked: false };
      });
      // Its state comes from the forge, after the link is answered.
      if (!result.alreadyLinked && snapshot === undefined) {
        const read = service
          .sync(threadId)
          .catch((error: unknown) =>
            deps.warn("reading a linked pull request failed", { threadId, error: String(error) }),
          )
          .finally(() => reads.delete(read));
        reads.add(read);
      }
      return result;
    },
    async unlink(threadId, target) {
      await load();
      const key = pullRequestKey(await resolve(threadId, target));
      return queued(threadId, async () => {
        const list = links.get(threadId) ?? [];
        const rest = list.filter((link) => link.key !== key);
        if (rest.length === list.length) return { key, wasLinked: false };
        await save(threadId, rest);
        await deps.append(SourceControlEvents.pullRequestUnlinked, { threadId, key });
        return { key, wasLinked: true };
      });
    },
    async sync(threadId, options = {}) {
      await load();
      const due = (links.get(threadId) ?? []).filter(
        (link) => options.all === true || link.snapshot === null || link.snapshot.state === "open",
      );
      for (const link of due) {
        const read = await readInto(threadId, link);
        if (read === link) continue;
        await queued(threadId, async () => {
          const list = links.get(threadId) ?? [];
          const index = list.findIndex((item) => item.key === link.key);
          if (index < 0) return;
          const current = list[index]!;
          const next = { ...current, snapshot: read.snapshot, syncedAt: read.syncedAt! };
          await save(threadId, list.toSpliced(index, 1, next));
          // When it was read is kept; only a changed snapshot is published.
          if (JSON.stringify(current.snapshot) === JSON.stringify(next.snapshot)) return;
          await deps.append(SourceControlEvents.pullRequestUpdated, {
            threadId,
            pullRequest: next,
          });
        });
      }
    },
    async threads() {
      await load();
      return [...links.keys()];
    },
    async update(threadId, link) {
      await load();
      await queued(threadId, async () => {
        const list = links.get(threadId) ?? [];
        const index = list.findIndex((item) => item.key === link.key);
        if (index < 0) return;
        await save(threadId, list.toSpliced(index, 1, link));
        await deps.append(SourceControlEvents.pullRequestUpdated, { threadId, pullRequest: link });
      });
    },
    async remove(threadId) {
      await load();
      await queued(threadId, async () => {
        const list = links.get(threadId) ?? [];
        if (list.length === 0) return;
        await save(threadId, []);
        // Said per link: a client holding them drops them whether or not it knew the thread.
        for (const link of list) {
          await deps.append(SourceControlEvents.pullRequestUnlinked, { threadId, key: link.key });
        }
      });
    },
  };
  return service;
}
