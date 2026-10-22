// Linking follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/pullRequest/
// LinkPullRequestDialog.tsx (its title, field, validation and failure) and the row menu of
// ThreadPullRequestsPanel.tsx ("Unlink from thread").
import type { ThreadActionProps } from "@jhin/client-api";
import {
  parsePullRequestUrl,
  repositoryOfRemote,
  type ThreadPullRequest,
} from "@jhin/source-control-api";
import { MenuItem, type Dialogs } from "@jhin/ui";
import { EyeIcon, EyeOffIcon, GitPullRequestArrowIcon, UnlinkIcon } from "lucide-react";

import { useSourceControl, type SourceControlServices } from "./services.ts";

/** What the user typed: a URL, or a number (`42`, `#42`) of the project's repository. */
export function readPullRequestInput(
  value: string,
  remoteUrl: string | null,
): { url: string } | { repository: string; number: number; host: string } | string {
  const text = value.trim();
  if (text === "") return "Paste a pull request URL or enter 123 / #123.";
  const number = /^#?(\d+)$/.exec(text)?.[1];
  if (number !== undefined) {
    const remote = remoteUrl === null ? undefined : repositoryOfRemote(remoteUrl);
    if (remote === undefined) return "Use a pull request URL, 123, or #123.";
    return { repository: remote.repository, number: Number(number), host: remote.host };
  }
  return parsePullRequestUrl(text) === undefined
    ? "Use a pull request URL, 123, or #123."
    : { url: text };
}

export function createLinkActions(services: SourceControlServices, dialogs: Dialogs | undefined) {
  const { store, threads, toasts } = services;

  function LinkPullRequest({ target, thread }: ThreadActionProps) {
    const view = useSourceControl(store, target);
    const status = view.projects.get(thread.projectId);
    if (dialogs === undefined || status === undefined || !status.isRepo) return null;
    const link = async () => {
      const value = await dialogs.prompt({
        title: "Link pull request",
        label: "Pull request",
        placeholder: "Pull request URL or #42",
        confirmLabel: "Link",
        validate: (text) => {
          const read = readPullRequestInput(text, status.remoteUrl);
          return typeof read === "string" ? read : undefined;
        },
      });
      if (value === undefined) return;
      const read = readPullRequestInput(value, status.remoteUrl);
      if (typeof read === "string") return;
      await threads
        .call(target, "git.pr.link", { threadId: thread.id, source: "manual", ...read })
        .catch((error: unknown) =>
          toasts?.show({
            type: "error",
            title: "Could not link the pull request.",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
    };
    return (
      <MenuItem onClick={() => void link()}>
        <GitPullRequestArrowIcon />
        Link pull request…
      </MenuItem>
    );
  }

  function UnlinkPullRequests({ target, thread }: ThreadActionProps) {
    const view = useSourceControl(store, target);
    const links: readonly ThreadPullRequest[] = view.links.get(thread.id) ?? [];
    const unlink = (link: ThreadPullRequest) =>
      void threads
        .call(target, "git.pr.unlink", { threadId: thread.id, url: link.url })
        .catch((error: unknown) =>
          toasts?.show({
            type: "error",
            title: "Could not unlink the pull request",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
    return links.map((link) => (
      <MenuItem key={link.key} onClick={() => unlink(link)}>
        <UnlinkIcon />
        {`Unlink #${link.number} from thread`}
      </MenuItem>
    ));
  }

  /** T3's "Watch for changes" and "Stop watching" for each open linked pull request. */
  function WatchPullRequests({ target, thread }: ThreadActionProps) {
    const view = useSourceControl(store, target);
    const links = (view.links.get(thread.id) ?? []).filter(
      (link) => (link.snapshot?.state ?? "open") === "open",
    );
    const toggle = (link: ThreadPullRequest) =>
      void threads
        .call(target, link.watch === undefined ? "git.pr.watch" : "git.pr.unwatch", {
          threadId: thread.id,
          url: link.url,
        })
        .catch((error: unknown) =>
          toasts?.show({
            type: "error",
            title: "Could not change the watch",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
    return links.map((link) => (
      <MenuItem key={link.key} onClick={() => toggle(link)}>
        {link.watch === undefined ? <EyeIcon /> : <EyeOffIcon />}
        {link.watch === undefined
          ? `Watch #${link.number} for changes`
          : `Stop watching #${link.number}`}
      </MenuItem>
    ));
  }

  return { LinkPullRequest, UnlinkPullRequests, WatchPullRequests };
}
