// The panel of a thread's pull requests follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/pullRequest/ThreadPullRequestsPanel.tsx (its rows, menu, empty
// state and footer) and PullRequestListRow.tsx (a row's two lines). A chunk of its own
// (D440), loaded when the panel first opens. docs/plans/source-control.md, D1281.
import type { NodeTarget } from "@jhin/client-api";
import type { ThreadPullRequest } from "@jhin/source-control-api";
import {
  Button,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
  copyText,
} from "@jhin/ui";
import {
  ArrowUpRightIcon,
  EyeIcon,
  EyeOffIcon,
  GitPullRequestArrowIcon,
  LayersIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PlusIcon,
  UnlinkIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { formatRelativeTimeLabel } from "../../lib/format.ts";
import { useCatalog, useExternal, useNow } from "../../lib/hooks.ts";
import { MiddleTruncate } from "../../lib/middle-truncate.tsx";
import {
  pullRequestChecksPresentation,
  pullRequestListLines,
  resolvePullRequestState,
  webPageUrl,
  type PullRequestListLine,
} from "../../lib/pull-request.ts";
import { PULL_REQUESTS_PANEL, useSourceControl, type SourceControlServices } from "./services.ts";

/** T3's SOURCE_LABELS: who linked a pull request, in its number's tooltip. */
const LINK_SOURCE_LABELS: Record<ThreadPullRequest["source"], string> = {
  manual: "Linked by you",
  created: "Created from this thread",
  agent: "Linked by the agent",
};

const ROW_CLASS = "group/pr-row flex w-full items-center gap-2 rounded-md py-1 pr-1 text-left";
const NUMBER_CLASS = "shrink-0 font-mono text-xs tabular-nums text-muted-foreground";

/** The newest `syncedAt` of the links, for the footer. */
function latestSyncedAt(links: readonly ThreadPullRequest[]): string | null {
  let latest: string | null = null;
  for (const link of links) {
    const at = link.syncedAt;
    if (at !== undefined && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

function Tip(props: { trigger: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={props.className ?? "inline-flex shrink-0"} />}>
        {props.trigger}
      </TooltipTrigger>
      <TooltipPopup>{props.children}</TooltipPopup>
    </Tooltip>
  );
}

interface RowActions {
  copy(link: ThreadPullRequest): void;
  open(link: ThreadPullRequest): void;
  setWatching(link: ThreadPullRequest, watching: boolean): void;
  unlink(link: ThreadPullRequest): void;
}

function LinkRow({
  line,
  now,
  actions,
}: {
  line: PullRequestListLine;
  now: number;
  actions: RowActions;
}) {
  const { link, depth, stack } = line;
  const snapshot = link.snapshot;
  const open = snapshot === null || snapshot.state === "open";
  const watching = link.watch !== undefined;
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const anchor = menuPosition
    ? { getBoundingClientRect: () => new DOMRect(menuPosition.x, menuPosition.y, 0, 0) }
    : undefined;
  const state = snapshot === null ? null : resolvePullRequestState(snapshot);
  const checks = snapshot === null || !open ? null : pullRequestChecksPresentation(snapshot.checks);
  return (
    <li
      className={cn(ROW_CLASS, "relative hover:bg-accent/60")}
      data-pull-request-row={link.key}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuPosition({ x: event.clientX, y: event.clientY });
        setMenuOpen(true);
      }}
      style={{ paddingLeft: `${0.5 + Math.min(depth, 3) * 1.25}rem` }}
    >
      {depth > 0 ? <span aria-hidden className="-ml-2 h-6 w-px shrink-0 bg-border/70" /> : null}
      <span className="flex w-4 shrink-0 flex-col items-center">
        {state === null ? (
          <GitPullRequestArrowIcon
            aria-label="Waiting for host state"
            className="size-4 shrink-0 text-muted-foreground"
            role="img"
          />
        ) : (
          <state.Icon
            aria-label={state.label}
            className={cn("size-4 shrink-0", state.toneClassName)}
            role="img"
          />
        )}
      </span>
      <a
        className="flex min-w-0 flex-1"
        href={webPageUrl(link.url)}
        rel="noopener noreferrer"
        target="_blank"
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <Tip className={NUMBER_CLASS} trigger={`#${link.number}`}>
              {LINK_SOURCE_LABELS[link.source]} · {formatRelativeTimeLabel(link.linkedAt, now)}
            </Tip>
            <span className="min-w-0 truncate text-sm">{snapshot?.title ?? link.repository}</span>
            {open && (watching || checks !== null) ? (
              <span className="flex shrink-0 items-center gap-1 text-2xs">
                {watching ? (
                  <Tip trigger={<EyeIcon aria-label="Watching" className="size-3.5" role="img" />}>
                    Watching: the agent wakes when checks finish, someone comments, or the branch
                    conflicts
                  </Tip>
                ) : null}
                {checks === null ? null : (
                  <Tip
                    trigger={
                      <checks.Icon
                        aria-label={checks.label}
                        className={cn("size-3.5", checks.toneClassName)}
                        role="img"
                      />
                    }
                  >
                    {checks.label}
                  </Tip>
                )}
              </span>
            ) : null}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted-foreground">
            {stack === null ? null : (
              <Tip
                className="inline-flex shrink-0 items-center gap-0.5 text-foreground/70"
                trigger={
                  <>
                    <LayersIcon aria-hidden className="size-3" />
                    {stack}
                  </>
                }
              >
                {`${stack} pull requests chained by base branch.`}
              </Tip>
            )}
            {snapshot === null ? (
              <span className="truncate font-mono">
                {link.host}/{link.repository}
              </span>
            ) : (
              <>
                <Tip className="flex min-w-0 max-w-32 font-mono" trigger={link.repository}>
                  {link.repository}
                </Tip>
                <span className="flex min-w-0 items-center gap-1 font-mono">
                  <MiddleTruncate value={snapshot.headBranch} />
                  <span className="shrink-0">→</span>
                  <MiddleTruncate className="max-w-[45%] shrink-0" value={snapshot.baseBranch} />
                </span>
              </>
            )}
            {snapshot?.updatedAt ? (
              <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums">
                {formatRelativeTimeLabel(snapshot.updatedAt, now)}
              </span>
            ) : null}
          </span>
        </span>
      </a>
      <span
        className={cn(
          "absolute right-0 bottom-0.5 flex items-center rounded-r-md bg-background pr-1 pl-5",
          "[mask-image:linear-gradient(to_right,transparent,black_1rem)]",
          // Hidden means untouchable too, so a tap on a touch screen reaches the link.
          "pointer-events-none opacity-0 group-hover/pr-row:pointer-events-auto group-hover/pr-row:opacity-100",
          "has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100",
          "has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100",
        )}
      >
        <span aria-hidden className="absolute inset-0 bg-accent/60" />
        <Menu
          onOpenChange={(next) => {
            setMenuOpen(next);
            if (!next) setMenuPosition(null);
          }}
          open={menuOpen}
        >
          <MenuTrigger
            render={
              <Button
                aria-label={`Actions for #${link.number}`}
                className="relative"
                size="icon-micro"
                variant="ghost"
              />
            }
          >
            <MoreHorizontalIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup
            align={menuPosition ? "start" : "end"}
            anchor={anchor}
            side="bottom"
            sideOffset={menuPosition ? 0 : 4}
          >
            <MenuItem onClick={() => actions.copy(link)}>
              <LinkIcon className="size-3.5" />
              Copy link
            </MenuItem>
            <MenuItem onClick={() => actions.open(link)}>
              <ArrowUpRightIcon className="size-3.5" />
              Open
            </MenuItem>
            {open ? (
              <MenuItem onClick={() => actions.setWatching(link, !watching)}>
                {watching ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                {watching ? "Stop watching" : "Watch for changes"}
              </MenuItem>
            ) : null}
            <MenuItem onClick={() => actions.unlink(link)}>
              <UnlinkIcon className="size-3.5" />
              Unlink from thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </span>
    </li>
  );
}

/** The list itself, for the thread's links: the panel's body. */
export function ThreadPullRequestsList({
  links,
  actions,
  onLink,
}: {
  links: readonly ThreadPullRequest[];
  actions: RowActions;
  /** Opens the "Link pull request" dialog; absent where it cannot open. */
  onLink: (() => void) | undefined;
}) {
  const now = useNow();
  const linkButton = (children: ReactNode, size: "sm" | "xs", variant: "outline" | "ghost") =>
    onLink === undefined ? null : (
      <Button onClick={onLink} size={size} variant={variant}>
        <PlusIcon className="size-3.5" />
        {children}
      </Button>
    );
  if (links.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <LinkIcon aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No linked pull requests</p>
        <p className="max-w-60 text-xs text-muted-foreground">
          Pull requests the agent opens from this thread land here. Link one yourself from a URL or
          a number.
        </p>
        {linkButton("Link pull request", "sm", "outline")}
      </div>
    );
  }
  const lines = pullRequestListLines(links);
  const openCount = links.filter(
    (link) => link.snapshot === null || link.snapshot.state === "open",
  ).length;
  const lastSynced = latestSyncedAt(links);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ul
        aria-label="Linked pull requests"
        className="m-0 min-h-0 flex-1 list-none overflow-y-auto overscroll-contain p-1.5"
      >
        {lines.map((line) => (
          <LinkRow actions={actions} key={line.link.key} line={line} now={now} />
        ))}
      </ul>
      <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5 text-2xs text-muted-foreground">
        <span>
          {openCount} open · {links.length} linked
          {lastSynced ? ` · synced ${formatRelativeTimeLabel(lastSynced, now)}` : null}
        </span>
        {linkButton("Link", "xs", "ghost")}
      </footer>
    </div>
  );
}

/** The right panel of the thread on screen (`app.panel`, D1281). */
export function createPullRequestsPanel(
  services: SourceControlServices,
  linkPrompt:
    | ((target: NodeTarget, threadId: string, remoteUrl: string | null) => Promise<void>)
    | undefined,
) {
  const { store, threads, navigation, toasts } = services;

  const failed = (title: string) => (error: unknown) =>
    toasts?.show({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    });

  function Panel({ target, threadId }: { target: NodeTarget; threadId: string }) {
    const catalog = useCatalog(threads, target);
    const view = useSourceControl(store, target);
    const thread = catalog?.threads.find((item) => item.id === threadId);
    const links = view.links.get(threadId) ?? [];
    const status = thread === undefined ? undefined : view.projects.get(thread.projectId);
    const close = () => {
      const { panel: _panel, section: _section, ...rest } = navigation.current();
      navigation.navigate(rest);
    };
    const call = (method: string, link: ThreadPullRequest, title: string) =>
      void threads.call(target, method, { threadId, url: link.url }).catch(failed(title));
    const actions: RowActions = {
      copy: (link) => void copyText(link.url).catch(failed("Could not copy the link")),
      open: (link) => {
        const url = webPageUrl(link.url);
        if (url !== undefined) window.open(url, "_blank", "noopener,noreferrer");
      },
      setWatching: (link, watching) =>
        call(watching ? "git.pr.watch" : "git.pr.unwatch", link, "Could not change the watch"),
      unlink: (link) => call("git.pr.unlink", link, "Could not unlink the pull request"),
    };
    const onLink =
      linkPrompt === undefined || status === undefined || !status.isRepo
        ? undefined
        : () => void linkPrompt(target, threadId, status.remoteUrl);
    return (
      <aside
        aria-label="Pull requests"
        className="flex h-full w-[42vw] min-w-[320px] max-w-[440px] shrink-0 flex-col border-l border-border bg-background"
        data-pull-requests-panel
      >
        <div className="drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-background px-4 wco:pr-(--workspace-native-controls-inset)">
          <h2 className="min-w-0 truncate text-sm font-medium">Pull requests</h2>
          <Button
            aria-label="Close pull requests panel"
            onClick={close}
            size="icon-xs"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          {/* Until the thread is known, its empty state would be a guess. */}
          {thread === undefined ? null : (
            <ThreadPullRequestsList actions={actions} links={links} onLink={onLink} />
          )}
        </div>
      </aside>
    );
  }

  return function PullRequestsPanel() {
    const route = useExternal(navigation, navigation.current);
    if (route.node === undefined || route.thread === undefined) return null;
    if (route.panel !== PULL_REQUESTS_PANEL) return null;
    const target: NodeTarget = {
      node: route.node,
      ...(route.remote === undefined ? {} : { remote: route.remote }),
    };
    return <Panel key={route.thread} target={target} threadId={route.thread} />;
  };
}
