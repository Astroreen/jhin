// The panel of a thread's pull requests follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/web/src/components/pullRequest/ThreadPullRequestsPanel.tsx (its rows, menu, empty
// state and footer, the speed mode under Shift, a row's drag into the composer and the
// virtualized list), PullRequestListRow.tsx (a row's two lines, its author and glyph) and
// PullRequestSpeedActions.tsx (the quick actions); the menu's pull request actions are
// pull-request-menu.tsx. A chunk of its own (D440), loaded when the panel first opens.
// docs/plans/source-control.md, D1281, D1452–D1455, D1457, D1663, D1664.
import type { NodeTarget, RightPanelSurfaceProps } from "@jhin/client-api";
import type {
  PullRequestAction,
  PullRequestCheck,
  PullRequestDetail,
  PullRequestMergeMethod,
  ThreadPullRequest,
} from "@jhin/source-control-api";
import { LegendList } from "@legendapp/list/react";
import {
  Button,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  Spinner,
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
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestCreateArrowIcon,
  LayersIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PlusIcon,
  UnlinkIcon,
  XIcon,
} from "lucide-react";
import { memo, useMemo, useRef, useState, type ReactNode } from "react";

import { encodePullRequestDrag, PULL_REQUEST_DRAG_TYPE } from "../../lib/composer-context.ts";
import { forgeKindOfUrl } from "../../lib/forges.ts";
import { formatRelativeTimeLabel } from "../../lib/format.ts";
import { useCatalog, useExternal, useNow } from "../../lib/hooks.ts";
import { MiddleTruncate } from "../../lib/middle-truncate.tsx";
import {
  pullRequestChecksPresentation,
  pullRequestListLines,
  resolvePullRequestState,
  webPageUrl,
  WATCHING_DESCRIPTION,
  type PullRequestListLine,
} from "../../lib/pull-request.ts";
import {
  ACTION_FAILURE_HINTS,
  ACTION_FAILURE_LABELS,
  ACTION_SUCCESS_LABELS,
  FORGE_ACTIONS,
  lastSelectedMergeMethod,
  pullRequestQuickActions,
  readableFailure,
  resolvePullRequestMergeMethod,
  type QuickAction,
} from "../../lib/pull-request-detail.ts";
import { usePullRequestMenuActions } from "./pull-request-menu.tsx";
import { useShortcutModifierState } from "../../lib/shortcut-modifiers.ts";
import {
  PullRequestChecksPopover,
  PullRequestConflictGlyph,
  PullRequestDiffStat,
  PullRequestReviewDecisionGlyph,
  PullRequestRowAuthor,
  pullRequestConflictLabel,
} from "./pull-request-presentation.tsx";
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
  /** The head's checks one by one, for the checks popover (`git.pr.detail`); absent without a project. */
  checks?: ((link: ThreadPullRequest) => Promise<readonly PullRequestCheck[]>) | undefined;
  /** Runs an action (`git.pr.action`) with its toasts; absent without a project. */
  act?:
    | ((
        link: ThreadPullRequest,
        action: PullRequestAction,
        mergeMethod?: PullRequestMergeMethod,
      ) => Promise<void>)
    | undefined;
  /** The pull request's detail (`git.pr.detail`), for the menu's actions (D1663). */
  detail?: ((link: ThreadPullRequest) => Promise<PullRequestDetail>) | undefined;
  /** Opens a check's details. */
  openUrl?: ((url: string) => void) | undefined;
}

const QUICK_ACTIONS = {
  close: { label: "Close", Icon: GitPullRequestClosedIcon },
  merge: { label: "Merge", Icon: GitMergeIcon },
  ready: { label: "Ready for review", Icon: GitPullRequestArrowIcon },
  reopen: { label: "Reopen", Icon: GitPullRequestCreateArrowIcon },
} as const;

/** T3's PullRequestSpeedActions: a row's quick actions while Shift is held. */
function SpeedActions(props: {
  link: ThreadPullRequest;
  actions: readonly QuickAction[];
  visible: boolean;
  act: (link: ThreadPullRequest, action: QuickAction) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  if (props.actions.length === 0) return null;
  const perform = async (action: QuickAction) => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    try {
      await props.act(props.link, action);
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  return (
    <div
      aria-label={`Quick actions for pull request #${props.link.number}`}
      className="shrink-0 items-center gap-1 pr-3"
      data-pull-request-action-pending={pending}
      role="group"
      style={{ display: props.visible || pending ? "flex" : "none" }}
    >
      {props.actions.map((action) => {
        const { label, Icon } = QUICK_ACTIONS[action];
        return (
          <Tooltip key={action}>
            <TooltipTrigger
              render={
                <Button
                  aria-label={`${label} #${props.link.number}`}
                  disabled={pending}
                  onClick={() => void perform(action)}
                  size="xs"
                  variant={action === "close" ? "destructive-outline" : "outline"}
                />
              }
            >
              {pending ? <Spinner className="size-3" /> : <Icon aria-hidden className="size-3" />}
              {label}
            </TooltipTrigger>
            <TooltipPopup>{`${label} immediately`}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

function LinkRowImpl({
  line,
  now,
  actions,
  speedMode,
}: {
  line: PullRequestListLine;
  now: number;
  actions: RowActions;
  speedMode: boolean;
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
  const conflict = pullRequestConflictLabel(snapshot);
  const forge = forgeKindOfUrl(link.url);
  const quick =
    actions.act === undefined || snapshot === null || forge === undefined
      ? []
      : pullRequestQuickActions(snapshot, FORGE_ACTIONS[forge]);
  const { checks: loadChecks } = actions;
  const menuAccess = useMemo(
    () =>
      actions.act === undefined || actions.detail === undefined
        ? undefined
        : { act: actions.act, detail: actions.detail },
    [actions.act, actions.detail],
  );
  const menuActions = usePullRequestMenuActions(link, menuOpen, menuAccess);
  return (
    <div
      className={cn(ROW_CLASS, "relative hover:bg-accent/60")}
      data-pull-request-row={link.key}
      role="listitem"
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
          <span className="relative inline-flex">
            <state.Icon
              aria-label={state.label}
              className={cn("size-4 shrink-0", state.toneClassName)}
              role="img"
            />
            {conflict === null ? null : <PullRequestConflictGlyph label={conflict} />}
          </span>
        )}
      </span>
      <a
        className="flex min-w-0 flex-1"
        href={webPageUrl(link.url)}
        // The link's own URL still rides along for drops outside the app; the composer takes
        // this payload instead and adds the pull request as a chip (D1454).
        onDragStart={
          snapshot === null
            ? undefined
            : (event) => {
                // Moved into the composer, or a link copied anywhere else.
                event.dataTransfer.effectAllowed = "all";
                event.dataTransfer.setData(
                  PULL_REQUEST_DRAG_TYPE,
                  encodePullRequestDrag({
                    number: link.number,
                    title: snapshot.title,
                    url: link.url,
                    headBranch: snapshot.headBranch,
                    baseBranch: snapshot.baseBranch,
                    state: snapshot.state,
                    isDraft: snapshot.isDraft,
                  }),
                );
              }
        }
        rel="noopener noreferrer"
        target="_blank"
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <Tip className={NUMBER_CLASS} trigger={`#${link.number}`}>
              {LINK_SOURCE_LABELS[link.source]} · {formatRelativeTimeLabel(link.linkedAt, now)}
            </Tip>
            <span className="min-w-0 truncate text-sm">{snapshot?.title ?? link.repository}</span>
            {open && (watching || checks !== null || snapshot?.reviewDecision) ? (
              <span className="flex shrink-0 items-center gap-1 text-2xs">
                {watching ? (
                  <Tip trigger={<EyeIcon aria-label="Watching" className="size-3.5" role="img" />}>
                    {WATCHING_DESCRIPTION}
                  </Tip>
                ) : null}
                {checks === null ||
                snapshot === null ||
                snapshot.checks.state === null ? null : loadChecks === undefined ? (
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
                ) : (
                  <PullRequestChecksPopover
                    checksState={snapshot.checks.state}
                    load={() => loadChecks(link)}
                    openUrl={actions.openUrl ?? (() => undefined)}
                  />
                )}
                {snapshot?.reviewDecision ? (
                  <PullRequestReviewDecisionGlyph decision={snapshot.reviewDecision} />
                ) : null}
              </span>
            ) : null}
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-2xs">
              <PullRequestDiffStat
                additions={snapshot?.additions ?? 0}
                className="font-mono"
                deletions={snapshot?.deletions ?? 0}
              />
            </span>
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
            {snapshot?.author ? (
              <PullRequestRowAuthor
                actor={snapshot.author}
                className="shrink-0"
                labelClassName="max-w-28"
              />
            ) : null}
            {snapshot === null ? (
              <span className="truncate font-mono">
                {link.host}/{link.repository}
              </span>
            ) : (
              <>
                <Tip
                  className="flex min-w-0 max-w-32 font-mono"
                  trigger={<MiddleTruncate value={link.repository} />}
                >
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
      {actions.act === undefined ? null : (
        <SpeedActions act={actions.act} actions={quick} link={link} visible={speedMode} />
      )}
      <span
        className={cn(
          "absolute right-0 bottom-0.5 flex items-center rounded-r-md bg-background pr-1 pl-5",
          "[mask-image:linear-gradient(to_right,transparent,black_1rem)]",
          // Hidden means untouchable too, so a tap on a touch screen reaches the link.
          "pointer-events-none opacity-0 group-hover/pr-row:pointer-events-auto group-hover/pr-row:opacity-100",
          "has-[[data-popup-open]]:pointer-events-auto has-[[data-popup-open]]:opacity-100",
          "has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100",
          "group-has-[[data-pull-request-action-pending=true]]/pr-row:hidden",
          speedMode && quick.length > 0 && "hidden",
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
            {menuActions.leading}
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
            {menuActions.trailing}
          </MenuPopup>
        </Menu>
      </span>
      {menuActions.dialog}
    </div>
  );
}

/** Memoized: a modifier key or one link's sync re-renders only the rows that changed. */
const LinkRow = memo(LinkRowImpl);

const lineKey = (line: PullRequestListLine) => line.link.key;

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
  const modifiers = useShortcutModifierState(true);
  const speedMode =
    modifiers.shiftKey && !modifiers.metaKey && !modifiers.ctrlKey && !modifiers.altKey;
  // What the rows read beyond their line: the list renders them again only when it changes.
  const extraData = useMemo(() => ({ now, speedMode, actions }), [now, speedMode, actions]);
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
      {/* A thread that runs a stack or a sweep links hundreds: only the rows in view mount. */}
      <LegendList<PullRequestListLine>
        aria-label="Linked pull requests"
        className="min-h-0 flex-1 overscroll-contain p-1.5"
        data={lines}
        drawDistance={440}
        estimatedItemSize={44}
        extraData={extraData}
        keyExtractor={lineKey}
        renderItem={({ item }) => (
          <LinkRow actions={actions} line={item} now={now} speedMode={speedMode} />
        )}
        role="list"
      />
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

  function Panel({
    target,
    threadId,
    embedded,
  }: {
    target: NodeTarget;
    threadId: string;
    /** A surface of the right panel (t3-parity.md D1424): its strip names it and closes it. */
    embedded: boolean;
  }) {
    const catalog = useCatalog(threads, target);
    const view = useSourceControl(store, target);
    const thread = catalog?.threads.find((item) => item.id === threadId);
    const links = view.links.get(threadId) ?? [];
    const status = thread === undefined ? undefined : view.projects.get(thread.projectId);
    const close = () => {
      const { panel: _panel, section: _section, ...rest } = navigation.current();
      navigation.navigate(rest);
    };
    const projectId = thread?.projectId;
    // The rows are memoized and the list virtualized: one set of actions per thread and project.
    const actions = useMemo((): RowActions => {
      const call = (method: string, link: ThreadPullRequest, title: string) =>
        void threads.call(target, method, { threadId, url: link.url }).catch(failed(title));
      const openUrl = (url: string) => {
        const page = webPageUrl(url);
        if (page !== undefined) window.open(page, "_blank", "noopener,noreferrer");
      };
      const detail = (link: ThreadPullRequest) =>
        threads.call<PullRequestDetail>(target, "git.pr.detail", { projectId, url: link.url });
      /** T3's usePullRequestActionRunner: the action, then its toast. */
      const act = async (
        link: ThreadPullRequest,
        action: PullRequestAction,
        chosen?: PullRequestMergeMethod,
      ) => {
        try {
          // T3 resolves a merge's method on the click, not for every row in view: the
          // project's, else the last one chosen on this device (D1664).
          const mergeMethod =
            action === "merge" && chosen === undefined
              ? await detail(link).then(({ mergeMethods, defaultMergeMethod }) => {
                  if (mergeMethods.length === 0) {
                    throw new Error("No merge method is available for this repository.");
                  }
                  return resolvePullRequestMergeMethod(
                    mergeMethods,
                    defaultMergeMethod,
                    lastSelectedMergeMethod(),
                  );
                })
              : chosen;
          await threads.call(target, "git.pr.action", {
            projectId,
            url: link.url,
            action,
            ...(mergeMethod === undefined ? {} : { mergeMethod }),
          });
          toasts?.show({ type: "success", title: ACTION_SUCCESS_LABELS[action] });
        } catch (error) {
          toasts?.show({
            type: "error",
            title: ACTION_FAILURE_LABELS[action],
            description: readableFailure(error, ACTION_FAILURE_HINTS[action]),
          });
        }
      };
      return {
        copy: (link) => void copyText(link.url).catch(failed("Could not copy the link")),
        open: (link) => openUrl(link.url),
        setWatching: (link, watching) =>
          call(watching ? "git.pr.watch" : "git.pr.unwatch", link, "Could not change the watch"),
        unlink: (link) => call("git.pr.unlink", link, "Could not unlink the pull request"),
        checks:
          projectId === undefined ? undefined : (link) => detail(link).then(({ checks }) => checks),
        act: projectId === undefined ? undefined : act,
        detail: projectId === undefined ? undefined : detail,
        openUrl,
      };
      // oxlint-disable-next-line react-hooks/exhaustive-deps -- the target's parts are its identity
    }, [target.node, target.remote, threadId, projectId]);
    const onLink =
      linkPrompt === undefined || status === undefined || !status.isRepo
        ? undefined
        : () => void linkPrompt(target, threadId, status.remoteUrl);
    const list = (
      <div className="min-h-0 flex-1">
        {/* Until the thread is known, its empty state would be a guess. */}
        {thread === undefined ? null : (
          <ThreadPullRequestsList actions={actions} links={links} onLink={onLink} />
        )}
      </div>
    );
    if (embedded) {
      return (
        <section
          aria-label="Pull requests"
          className="flex min-h-0 flex-1 flex-col"
          data-pull-requests-panel
        >
          {list}
        </section>
      );
    }
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
        {list}
      </aside>
    );
  }

  /** The right panel's `pull-requests` surface (D1424). */
  function PullRequestsSurface({ place }: RightPanelSurfaceProps) {
    if (place.threadId === undefined) return null;
    return <Panel embedded key={place.threadId} target={place.target} threadId={place.threadId} />;
  }

  function PullRequestsPanel() {
    const route = useExternal(navigation, navigation.current);
    if (route.node === undefined || route.thread === undefined) return null;
    if (route.panel !== PULL_REQUESTS_PANEL) return null;
    const target: NodeTarget = {
      node: route.node,
      ...(route.remote === undefined ? {} : { remote: route.remote }),
    };
    return <Panel embedded={false} key={route.thread} target={target} threadId={route.thread} />;
  }

  return { PullRequestsPanel, PullRequestsSurface };
}
