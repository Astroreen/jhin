// The right panel follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/components/
// RightPanelTabs.tsx (the tab strip), preview/PreviewPanelShell.tsx, PreviewView.tsx,
// PreviewChromeRow.tsx, PreviewMoreMenu.tsx, PreviewEmptyState.tsx, PreviewRecentUrlCard.tsx,
// PreviewUnreachable.tsx, previewConstants.ts, RightPanelResizeHandle.tsx,
// apps/web/src/browser/BrowserDeviceToolbar.tsx and the control strip and dialogs of
// browser/ServerBrowserSurface.tsx with packages/client-runtime/src/preview/serverBrowserStream.ts.
import type { NodeTarget } from "@jhin/client-api";
import {
  PREVIEW_UPLOAD_MAX_BYTES,
  PREVIEW_VIEWPORT_MAX_AREA,
  PREVIEW_VIEWPORT_PRESETS,
  PREVIEW_ZOOM_LEVELS,
  resolveAddressBarInput,
  type PreviewAppearance,
  type PreviewTab,
  type PreviewViewportSetting,
} from "@jhin/preview-api";
import type { RpcClient } from "@jhin/rpc";
import {
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  cn,
} from "@jhin/ui";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  GlobeIcon,
  Globe2Icon,
  HistoryIcon,
  MinusIcon,
  MoreVerticalIcon,
  PictureInPicture2Icon,
  PlusIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SmartphoneIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { profileName, type BrowserProfile } from "./profiles.tsx";
import { BrowserSurface } from "./surface.tsx";

// --- Recently used pages (T3's browser history) ----------------------------------

const HISTORY_KEY = "jhin:browser-history:v1";
const RECENT_URL_LIMIT = 10;

interface RecentUrl {
  readonly url: string;
  readonly title: string;
  readonly visitedAt: number;
}

function readRecentUrls(): RecentUrl[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? (parsed as RecentUrl[]).slice(0, RECENT_URL_LIMIT) : [];
  } catch {
    return [];
  }
}

function recordRecentUrl(url: string, title: string): void {
  if (!/^https?:/.test(url)) return;
  const known = readRecentUrls();
  // A visit without a title (opened, not loaded yet) keeps the title known before.
  title ||= known.find((entry) => entry.url === url)?.title ?? "";
  const kept = known.filter((entry) => entry.url !== url);
  const next = [{ url, title, visitedAt: Date.now() }, ...kept].slice(0, RECENT_URL_LIMIT);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked storage only costs the history.
  }
}

function forgetRecentUrl(url: string): void {
  try {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(readRecentUrls().filter((entry) => entry.url !== url)),
    );
  } catch {
    // A full or blocked storage only costs the history.
  }
}

// --- Labels ---------------------------------------------------------------------------

/** T3's tab title: the page's title, else its host, else "Browser". */
function tabTitle(tab: PreviewTab | undefined): string {
  const status = tab?.navStatus;
  if (status === undefined || status.state === "idle") return "Browser";
  if (status.title.trim() !== "") return status.title;
  try {
    return new URL(status.url).host || "Browser";
  } catch {
    return "Browser";
  }
}

function urlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  ERR_NAME_NOT_RESOLVED: "DNS address could not be found",
  ERR_NAME_RESOLUTION_FAILED: "DNS address could not be found",
  ERR_CONNECTION_REFUSED: "Connection refused",
  ERR_CONNECTION_RESET: "Connection was reset",
  ERR_CONNECTION_CLOSED: "Connection was closed",
  ERR_CONNECTION_TIMED_OUT: "Connection timed out",
  ERR_TIMED_OUT: "Connection timed out",
  ERR_INTERNET_DISCONNECTED: "No internet connection",
  ERR_CERT_AUTHORITY_INVALID: "Certificate authority is not trusted",
  ERR_CERT_COMMON_NAME_INVALID: "Certificate hostname mismatch",
  ERR_CERT_DATE_INVALID: "Certificate is expired or not yet valid",
  ERR_TOO_MANY_REDIRECTS: "Too many redirects",
};

/** What the control strip says (T3's `previewStreamControlLabel`). */
function controlLabel(tab: PreviewTab, viewer: string): string {
  if (tab.controller === viewer) return "You have control";
  if (tab.controller !== null) return "Another viewer has control";
  if (tab.owner === "agent") return "Agent has control";
  return "Watching";
}

function IconButton(props: {
  label: string;
  tooltip?: string;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
            size="icon-xs"
            type="button"
            variant="ghost"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.tooltip ?? props.label}</TooltipPopup>
    </Tooltip>
  );
}

// --- The panel --------------------------------------------------------------------------

export interface PanelServices {
  readonly viewer: string;
  /** The tab shown for a thread, chosen on this device. */
  activeTab(key: string): string | undefined;
  setActiveTab(key: string, tabId: string | undefined): void;
  /** Bumped to focus the address bar (⌘/Ctrl+L). */
  readonly focusUrlRequests: { current: number; subscribe(listener: () => void): () => void };
  /** Runs a command on the thread's node. */
  call<T>(method: string, params: unknown): Promise<T>;
  readonly shortcut: (command: string) => string | undefined;
  readonly onError: (title: string, error: unknown) => void;
  /** The tab of this panel's thread that floats over the chat (D1202). */
  useFloatingTab(key: string): string | undefined;
  /** Floats a tab over the chat and closes the panel, or (undefined) closes the floating one. */
  float(key: string, tabId: string | undefined): void;
  /** This device's browser profiles and its default one (D953). */
  useProfiles(): {
    readonly profiles: readonly BrowserProfile[];
    readonly defaultProfileId: string;
  };
}

const WIDTH_KEY = "jhin:preview-panel-width";
const MIN_WIDTH = 360;
const DEFAULT_WIDTH = 540;
const MIN_CHAT_WIDTH = 360;

function maxWidth(): number {
  return Math.max(
    MIN_WIDTH,
    Math.min(Math.floor(window.innerWidth * 0.7), window.innerWidth - MIN_CHAT_WIDTH),
  );
}

function readWidth(): number {
  let stored = Number.NaN;
  try {
    stored = Number(localStorage.getItem(WIDTH_KEY));
  } catch {
    // Blocked storage: the default width.
  }
  return Number.isFinite(stored) && stored >= MIN_WIDTH ? stored : DEFAULT_WIDTH;
}

/** T3's PreviewPanelShell with its resize handle on the left edge. */
function PanelShell(props: { children: ReactNode; label: string }) {
  const [width, setWidth] = useState(readWidth);
  const drag = useRef<{ startX: number; startWidth: number } | undefined>(undefined);
  const shown = Math.min(width, maxWidth());
  return (
    <aside
      aria-label={props.label}
      className="relative flex h-full min-h-0 min-w-0 max-w-full shrink-0 flex-col self-stretch border-l border-border bg-background"
      data-preview-panel-mode="inline"
      style={{ width: `${shown}px` } as CSSProperties}
    >
      <div
        aria-label="Resize right panel"
        aria-orientation="vertical"
        aria-valuemax={maxWidth()}
        aria-valuemin={MIN_WIDTH}
        aria-valuenow={shown}
        className="group absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize select-none"
        onDoubleClick={() => {
          localStorage.removeItem(WIDTH_KEY);
          setWidth(DEFAULT_WIDTH);
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { startX: event.clientX, startWidth: shown };
        }}
        onPointerMove={(event) => {
          if (drag.current === undefined) return;
          const next = drag.current.startWidth + (drag.current.startX - event.clientX);
          setWidth(Math.max(MIN_WIDTH, Math.min(maxWidth(), Math.round(next))));
        }}
        onPointerUp={() => {
          drag.current = undefined;
          localStorage.setItem(WIDTH_KEY, String(width));
        }}
        role="separator"
        tabIndex={-1}
      >
        <div className="mx-auto h-full w-px group-hover:bg-border group-active:bg-primary/60" />
      </div>
      {props.children}
    </aside>
  );
}

export interface BrowserPanelProps {
  readonly target: NodeTarget;
  readonly threadId: string;
  readonly client: RpcClient;
  readonly tabs: readonly PreviewTab[];
  readonly services: PanelServices;
  readonly panelKey: string;
}

/** The right panel of a thread: its browser tabs and the one on screen. */
export function BrowserPanel(props: BrowserPanelProps) {
  const { tabs, services, panelKey, threadId } = props;
  const chosen = services.activeTab(panelKey);
  // A new tab placeholder (T3's `browser:new`) shows until a page opens.
  const [drafting, setDrafting] = useState(false);
  /** The profile the next tab opens in, when the user picked one (T3's "Open browser in a profile"). */
  const [draftProfile, setDraftProfile] = useState<string | undefined>(undefined);
  const active = drafting ? undefined : (tabs.find((tab) => tab.tabId === chosen) ?? tabs.at(-1));
  const { profiles, defaultProfileId } = services.useProfiles();
  // A profile removed in the settings meanwhile is not opened: the default is.
  const openingProfile =
    draftProfile !== undefined && profiles.some((profile) => profile.id === draftProfile)
      ? draftProfile
      : defaultProfileId;

  const openUrl = async (raw: string) => {
    let url: string;
    try {
      url = resolveAddressBarInput(raw);
    } catch (error) {
      services.onError("Unable to open the page", error);
      return;
    }
    try {
      const tab = await services.call<PreviewTab>("preview.tab.open", {
        threadId,
        url,
        profileId: openingProfile,
      });
      services.setActiveTab(panelKey, tab.tabId);
      setDrafting(false);
      setDraftProfile(undefined);
      recordRecentUrl(url, "");
    } catch (error) {
      services.onError("Unable to open the page", error);
    }
  };

  return (
    <PanelShell label="Right panel">
      <div
        className="flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2"
        data-right-panel-tabbar=""
      >
        <div
          aria-label="Panel surfaces"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          role="tablist"
        >
          {tabs.map((tab) => {
            const title = tabTitle(tab);
            const selected = tab.tabId === active?.tabId;
            return (
              <div
                className={cn(
                  "cursor-pointer group/tab flex h-6 max-w-36 shrink-0 items-center gap-0.5 rounded-md pr-2 pl-1.5 text-xs",
                  selected
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
                key={tab.tabId}
              >
                <button
                  aria-selected={selected}
                  className="flex min-w-0 items-center gap-1 outline-none"
                  onClick={() => {
                    setDrafting(false);
                    setDraftProfile(undefined);
                    services.setActiveTab(panelKey, tab.tabId);
                  }}
                  role="tab"
                  type="button"
                >
                  <Globe2Icon className="size-3 shrink-0" />
                  <span className="truncate">{title}</span>
                </button>
                <button
                  aria-label={`Close ${title}`}
                  className="ml-0.5 shrink-0 rounded-sm opacity-60 hover:opacity-100"
                  onClick={() => {
                    void services
                      .call("preview.tab.close", { threadId, tabId: tab.tabId })
                      .catch((error: unknown) =>
                        services.onError("Unable to change the browser tab", error),
                      );
                  }}
                  type="button"
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            );
          })}
          {drafting || tabs.length === 0 ? (
            <div
              aria-selected="true"
              className="flex h-6 max-w-36 shrink-0 items-center gap-0.5 rounded-md bg-accent pr-2 pl-1.5 text-xs text-foreground"
              role="tab"
            >
              <Globe2Icon className="size-3 shrink-0" />
              <span className="truncate">Browser</span>
              {openingProfile === defaultProfileId ? null : (
                <Badge className="max-w-20 shrink-0" variant="outline">
                  <span className="truncate">{profileName(profiles, openingProfile)}</span>
                </Badge>
              )}
            </div>
          ) : null}
        </div>
        <IconButton
          label="Add panel surface"
          onClick={() => {
            setDraftProfile(undefined);
            setDrafting(true);
          }}
          tooltip="New browser tab"
        >
          <PlusIcon className="size-4" />
        </IconButton>
        {profiles.length > 1 ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label="Open browser in a profile"
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                />
              }
            >
              <ChevronDownIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end" className="max-w-56" side="bottom" sideOffset={6}>
              {profiles.map((profile) => (
                <MenuItem
                  key={profile.id}
                  onClick={() => {
                    setDraftProfile(profile.id);
                    setDrafting(true);
                  }}
                >
                  <span className="min-w-0 truncate">{profile.name}</span>
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
        <div className="w-1" />
      </div>
      {active === undefined ? (
        <DraftView onOpen={(url) => void openUrl(url)} services={services} />
      ) : (
        <TabView
          client={props.client}
          key={active.tabId}
          panelKey={panelKey}
          services={services}
          tab={active}
          threadId={threadId}
        />
      )}
    </PanelShell>
  );
}

// --- The chrome row -------------------------------------------------------------------

function AddressBar(props: {
  url: string;
  disabled: boolean;
  services: PanelServices;
  onSubmit: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const { focusUrlRequests } = props.services;
  useEffect(
    () =>
      focusUrlRequests.subscribe(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }),
    [focusUrlRequests],
  );
  return (
    <InputGroup className="group/address h-7 flex-1" variant="ghost">
      <InputGroupInput
        aria-label="Address"
        data-preview-url-input=""
        disabled={props.disabled}
        onBlur={() => setDraft(undefined)}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onFocus={(event) => {
          setDraft(props.url);
          event.currentTarget.select();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setDraft(undefined);
            event.currentTarget.blur();
          }
          if (event.key === "Enter") {
            event.preventDefault();
            const value = (draft ?? "").trim();
            if (value === "") return;
            props.onSubmit(value);
            setDraft(undefined);
            event.currentTarget.blur();
          }
        }}
        placeholder="Search or enter URL"
        ref={inputRef}
        size="sm"
        spellCheck={false}
        value={draft ?? props.url}
      />
      {props.url !== "" && draft === undefined ? (
        <InputGroupAddon
          align="inline-end"
          className="opacity-0 group-hover/address:opacity-100 group-focus-within/address:opacity-100"
        >
          <IconButton
            label="Open in system browser"
            onClick={() => window.open(props.url, "_blank", "noopener,noreferrer")}
          >
            <ExternalLinkIcon className="size-3.5" />
          </IconButton>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}

function ChromeRow(props: {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  disabled: boolean;
  services: PanelServices;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onSubmit: (value: string) => void;
  menu?: ReactNode;
  /** Before the address: T3's badge of a tab's non-default profile. */
  leading?: ReactNode;
  /** T3's "Float preview over chat" toggle (D1202). */
  float?: { readonly floating: boolean; readonly disabled: boolean; readonly onToggle: () => void };
}) {
  const refresh = props.services.shortcut("preview.refresh");
  return (
    <form
      className="relative flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2"
      data-surface-subheader=""
      onSubmit={(event) => event.preventDefault()}
    >
      <div aria-label="Navigation" className="flex items-center" role="group">
        <IconButton
          disabled={props.disabled || !props.canGoBack}
          label="Back"
          onClick={props.onBack}
        >
          <ArrowLeftIcon className="size-4" />
        </IconButton>
        <IconButton
          disabled={props.disabled || !props.canGoForward}
          label="Forward"
          onClick={props.onForward}
        >
          <ArrowRightIcon className="size-4" />
        </IconButton>
        <IconButton
          disabled={props.disabled}
          label={props.loading ? "Stop" : "Refresh"}
          onClick={props.onRefresh}
          tooltip={props.loading ? "Loading…" : `Refresh${refresh ? ` (${refresh})` : ""}`}
        >
          <RefreshCwIcon className={cn("size-4", props.loading && "animate-spin")} />
        </IconButton>
      </div>
      {props.leading}
      <AddressBar
        disabled={props.disabled}
        onSubmit={props.onSubmit}
        services={props.services}
        url={props.url}
      />
      {props.float === undefined ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={
                  props.float.floating ? "Close floating preview" : "Float preview over chat"
                }
                aria-pressed={props.float.floating ? "true" : "false"}
                disabled={props.float.disabled}
                onClick={props.float.onToggle}
                size="icon-xs"
                type="button"
                variant={props.float.floating ? "secondary" : "ghost"}
              />
            }
          >
            <PictureInPicture2Icon className={cn(props.float.floating && "text-primary")} />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {props.float.floating ? "Close floating preview" : "Float preview over chat"}
          </TooltipPopup>
        </Tooltip>
      )}
      {props.menu}
      <div
        className="preview-loading-progress pointer-events-none absolute bottom-0 left-0 z-10 h-0.5 w-full origin-left rounded-r-full bg-primary"
        data-loading={props.loading ? "true" : "false"}
        style={{ boxShadow: "0 0 6px 1px var(--color-ring)" }}
      />
    </form>
  );
}

// --- The empty state ---------------------------------------------------------------------

/** A browser-ready server a terminal of the node started (`preview.servers.list`, D950). */
interface LocalServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly processName: string | null;
}

/** T3 rescans every 3 s while the empty state shows. */
const LOCAL_SERVERS_SCAN_MS = 3_000;

/** The node's local servers, rescanned while the empty state shows (T3's port discovery). */
function useLocalServers(services: Pick<PanelServices, "call">): readonly LocalServer[] {
  const [servers, setServers] = useState<readonly LocalServer[]>([]);
  // The latest services, so a new object each render does not restart the scans.
  const latest = useRef(services);
  latest.current = services;
  useEffect(() => {
    let live = true;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scan = () => {
      // A hidden page does not scan; it looks again as soon as it is shown.
      if (document.hidden) {
        document.addEventListener("visibilitychange", scan, { once: true });
        return;
      }
      latest.current.call<{ servers: LocalServer[] }>("preview.servers.list", {}).then(
        (result) => {
          if (!live) return;
          failures = 0;
          setServers((current) =>
            JSON.stringify(current) === JSON.stringify(result.servers) ? current : result.servers,
          );
          timer = setTimeout(scan, LOCAL_SERVERS_SCAN_MS);
        },
        // A failure (a reconnecting socket, a node without the command) waits longer each time.
        () => {
          if (!live) return;
          // A node that does not answer offers no servers that may be gone.
          setServers((current) => (current.length === 0 ? current : []));
          failures += 1;
          timer = setTimeout(scan, Math.min(LOCAL_SERVERS_SCAN_MS * 2 ** failures, 60_000));
        },
      );
    };
    scan();
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", scan);
    };
  }, []);
  return servers;
}

function EmptyState(props: {
  onOpen: (url: string) => void;
  services: Pick<PanelServices, "call">;
}) {
  const [recent, setRecent] = useState(readRecentUrls);
  const servers = useLocalServers(props.services);
  if (recent.length === 0 && servers.length === 0) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GlobeIcon className="size-4.5" />
          </EmptyMedia>
          <EmptyTitle>No preview yet</EmptyTitle>
          <EmptyDescription>
            Type a URL above, or run a dev script. Browser-ready localhost servers will show up here
            automatically.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="scrollbar-gutter-both flex h-full min-h-0 overflow-y-auto px-5 py-8">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        {recent.length > 0 ? (
          <section aria-label="Recently used" className="flex flex-col gap-2">
            <h2 className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
              <HistoryIcon className="size-3.5" />
              Recently used
            </h2>
            <ul className="flex flex-col">
              {recent.slice(0, 8).map((entry) => {
                const label = urlLabel(entry.url);
                return (
                  <li
                    className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60"
                    key={entry.url}
                  >
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => props.onOpen(entry.url)}
                      type="button"
                    >
                      <Globe2Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{entry.title || label}</span>
                        {entry.title ? (
                          <span className="block truncate text-xs text-muted-foreground">
                            {label}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    <button
                      aria-label={`Remove ${label} from history`}
                      className="opacity-0 group-hover:opacity-100"
                      onClick={() => {
                        forgetRecentUrl(entry.url);
                        setRecent(readRecentUrls());
                      }}
                      type="button"
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        {servers.length > 0 ? (
          <section aria-label="Local servers" className="flex flex-col gap-2">
            <h2 className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
              <RadioTowerIcon className="size-3.5" />
              Local servers
            </h2>
            <ul className="flex flex-col">
              {servers.map((server) => (
                <li
                  className="rounded-md px-2 py-1.5 hover:bg-accent/60"
                  key={`${server.host}:${server.port}`}
                >
                  <button
                    className="flex w-full min-w-0 items-center gap-2 text-left"
                    onClick={() => props.onOpen(server.url)}
                    type="button"
                  >
                    <Globe2Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {server.processName ?? "Listening"}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {`${server.host}:${server.port}`}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="px-1 text-xs text-muted-foreground">
              Select a live local server to open it in this browser tab.
            </p>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function DraftView(props: { onOpen: (url: string) => void; services: PanelServices }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <ChromeRow
        canGoBack={false}
        canGoForward={false}
        disabled={false}
        loading={false}
        onBack={() => undefined}
        onForward={() => undefined}
        onRefresh={() => undefined}
        onSubmit={props.onOpen}
        services={props.services}
        url=""
      />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <EmptyState onOpen={props.onOpen} services={props.services} />
      </div>
    </div>
  );
}

// --- The device toolbar ----------------------------------------------------------------------

const RESPONSIVE = "responsive";

function DeviceToolbar(props: {
  setting: Exclude<PreviewViewportSetting, { mode: "fill" }>;
  onChange: (setting: PreviewViewportSetting) => void;
}) {
  const { setting } = props;
  const [width, setWidth] = useState(String(setting.width));
  const [height, setHeight] = useState(String(setting.height));
  useEffect(() => {
    setWidth(String(setting.width));
    setHeight(String(setting.height));
  }, [setting.width, setting.height]);
  const apply = () => {
    const w = Math.round(Number(width));
    const h = Math.round(Number(height));
    if (
      !Number.isFinite(w) ||
      !Number.isFinite(h) ||
      w < 240 ||
      h < 240 ||
      w > 3840 ||
      h > 3840 ||
      w * h > PREVIEW_VIEWPORT_MAX_AREA
    ) {
      setWidth(String(setting.width));
      setHeight(String(setting.height));
      return;
    }
    if (w !== setting.width || h !== setting.height) {
      props.onChange({ mode: "freeform", width: w, height: h });
    }
  };
  const presetValue = setting.mode === "preset" ? setting.presetId : RESPONSIVE;
  return (
    <div
      aria-label="Browser device toolbar"
      className="sticky left-0 top-0 z-50 flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/70 bg-background/95 px-1.5 py-1 shadow-xs backdrop-blur-md [scrollbar-width:none]"
      role="toolbar"
    >
      <span className="px-1 text-xs text-muted-foreground">Dimensions</span>
      <Select
        onValueChange={(value) => {
          if (value === RESPONSIVE || value === null) {
            props.onChange({ mode: "freeform", width: setting.width, height: setting.height });
            return;
          }
          const preset = PREVIEW_VIEWPORT_PRESETS.find((each) => each.id === value);
          if (preset !== undefined) {
            props.onChange({
              mode: "preset",
              presetId: preset.id,
              width: preset.width,
              height: preset.height,
            });
          }
        }}
        value={presetValue}
      >
        <SelectTrigger aria-label="Browser device preset" className="w-36" size="sm">
          <SelectValue>
            {(value: string) =>
              value === RESPONSIVE
                ? "Responsive"
                : (PREVIEW_VIEWPORT_PRESETS.find((each) => each.id === value)?.label ?? value)
            }
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={RESPONSIVE}>Responsive</SelectItem>
          <SelectGroup>
            <SelectGroupLabel>Standard</SelectGroupLabel>
            {PREVIEW_VIEWPORT_PRESETS.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}>
                <span>{preset.label}</span>
                <span className="ml-2 text-muted-foreground text-xs">{preset.detail}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectPopup>
      </Select>
      <Input
        aria-label="Viewport width"
        className="w-16"
        inputMode="numeric"
        onBlur={apply}
        onChange={(event) => setWidth(event.currentTarget.value)}
        onKeyDown={(event) => event.key === "Enter" && apply()}
        size="sm"
        value={width}
      />
      <span className="text-xs text-muted-foreground">×</span>
      <Input
        aria-label="Viewport height"
        className="w-16"
        inputMode="numeric"
        onBlur={apply}
        onChange={(event) => setHeight(event.currentTarget.value)}
        onKeyDown={(event) => event.key === "Enter" && apply()}
        size="sm"
        value={height}
      />
      <IconButton
        label="Rotate viewport"
        onClick={() =>
          props.onChange(
            setting.mode === "preset"
              ? { ...setting, width: setting.height, height: setting.width }
              : { mode: "freeform", width: setting.height, height: setting.width },
          )
        }
      >
        <SmartphoneIcon className="size-3.5 rotate-90" />
      </IconButton>
      <div className="sticky right-0 ml-auto bg-background/95">
        <IconButton label="Close device toolbar" onClick={() => props.onChange({ mode: "fill" })}>
          <XIcon className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

// --- A tab on screen -----------------------------------------------------------------------

function Unreachable(props: { url: string; description: string; onReload: () => void }) {
  const [details, setDetails] = useState(false);
  let host = props.url;
  try {
    host = new URL(props.url).host || props.url;
  } catch {
    // Not a URL: shown as it is.
  }
  const friendly = ERROR_MESSAGES[props.description] ?? (props.description || "Network error");
  return (
    <div className="absolute inset-0 z-10 bg-background">
      <div className="scrollbar-gutter-both relative flex h-full min-h-0 w-full overflow-y-auto bg-background">
        <div className="mx-auto flex w-full max-w-xl flex-1 flex-col px-8 py-12 sm:py-16">
          <GlobeIcon aria-hidden="true" className="mb-6 size-12 text-muted-foreground/70" />
          <h1 className="text-2xl font-semibold">This site can’t be reached</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            <strong className="text-foreground">{host}</strong>: {friendly}.
          </p>
          {details ? (
            <div className="mt-4 rounded-lg border border-border p-3 text-sm">
              <p className="font-medium">Try:</p>
              <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                <li>Checking your connection</li>
                <li>Confirming the dev server is running</li>
                <li>Checking the proxy and the firewall</li>
              </ul>
            </div>
          ) : null}
          <p className="mt-4 text-xs uppercase tracking-wide text-muted-foreground/70">
            {props.description || "ERR_FAILED"}
          </p>
          <div className="mt-8 flex items-center gap-2">
            <Button onClick={() => setDetails(!details)} size="sm" variant="outline">
              {details ? "Hide details" : "Details"}
            </Button>
            <div className="flex-1" />
            <Button onClick={props.onReload} size="sm">
              Reload
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A file's bytes in base64, converted in chunks so a large file fits the call stack. */
async function base64Of(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/** T3's prompt when the page asks for files: the viewer holding control picks or cancels. */
function FileChooserDialog(props: {
  multiple: boolean;
  accept: string;
  onAnswer: (files: readonly File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      aria-label="Choose files for the page"
      className="absolute inset-x-2 top-2 z-10 flex flex-col gap-2 rounded-lg border border-border bg-background p-3 shadow-lg"
      role="dialog"
    >
      <p className="text-sm">The page asks for {props.multiple ? "files" : "a file"}.</p>
      <input
        accept={props.accept}
        aria-hidden="true"
        className="hidden"
        data-preview-file-input=""
        multiple={props.multiple}
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          if (files.length > 0) props.onAnswer(files);
        }}
        ref={input}
        tabIndex={-1}
        type="file"
      />
      <div className="flex justify-end gap-2">
        <Button onClick={() => props.onAnswer([])} size="sm" variant="outline">
          Cancel
        </Button>
        <Button onClick={() => input.current?.click()} size="sm">
          Choose {props.multiple ? "files" : "file"}
        </Button>
      </div>
    </div>
  );
}

function TabView(props: {
  client: RpcClient;
  threadId: string;
  tab: PreviewTab;
  services: PanelServices;
  panelKey: string;
}) {
  const { tab, services, threadId, panelKey } = props;
  const floating = services.useFloatingTab(panelKey) === tab.tabId;
  const { viewer } = services;
  const { profiles, defaultProfileId } = services.useProfiles();
  // T3 marks a tab that browses with another profile than the default.
  const profileBadge =
    tab.profileId === undefined || tab.profileId === defaultProfileId ? undefined : (
      <Tooltip>
        <TooltipTrigger render={<Badge className="max-w-28 shrink-0" variant="outline" />}>
          <span className="truncate">{profileName(profiles, tab.profileId)}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">{profileName(profiles, tab.profileId)}</TooltipPopup>
      </Tooltip>
    );
  const ids = { threadId, tabId: tab.tabId };
  const youControl = tab.controller === viewer;
  // Unset until the user edits the prompt: its default answers until then.
  const [promptText, setPromptText] = useState<string | undefined>(undefined);
  // The toolbar shows while the tab has a fixed size, whoever set it.
  const deviceToolbar = tab.viewport.mode !== "fill";
  const [painted, setPainted] = useState(false);
  const fail = (title: string) => (error: unknown) => services.onError(title, error);
  const tabCall = (method: string, params: Record<string, unknown>, title: string) =>
    void services.call(method, { ...ids, ...params }).catch(fail(title));

  // A tab nobody claimed is the human's to drive, as T3 hands it over on attach.
  const claimed = useRef(false);
  useEffect(() => {
    if (claimed.current || tab.owner !== "unclaimed" || tab.controller !== null) return;
    claimed.current = true;
    tabCall("preview.tab.control", { viewer, take: true }, "Unable to change the browser tab");
  });

  const status = tab.navStatus;
  const url = status.state === "idle" ? "" : status.url;
  useEffect(() => {
    if (status.state === "success") recordRecentUrl(status.url, status.title);
  }, [status.state, url, status.state === "idle" ? "" : status.title]);

  const navigate = (params: Record<string, unknown>) =>
    tabCall("preview.tab.navigate", { viewer, ...params }, "Unable to change the browser tab");
  const adjust = (params: Record<string, unknown>, title = "Unable to change the browser tab") =>
    tabCall("preview.tab.adjust", params, title);

  const zoomIndex = PREVIEW_ZOOM_LEVELS.indexOf(
    tab.zoomFactor as (typeof PREVIEW_ZOOM_LEVELS)[number],
  );
  const zoom = (step: number) => {
    const next =
      PREVIEW_ZOOM_LEVELS[Math.max(0, Math.min(PREVIEW_ZOOM_LEVELS.length - 1, zoomIndex + step))];
    if (next !== undefined) adjust({ zoomFactor: next });
  };

  const menu = (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              aria-label="Preview menu"
              render={<Button size="icon-xs" type="button" variant="ghost" />}
            />
          }
        >
          <MoreVerticalIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">More</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6}>
        {tab.profileId === undefined ? null : (
          <>
            <MenuItem disabled>
              <span className="block truncate">
                Profile: {profileName(profiles, tab.profileId)}
              </span>
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        <MenuItem onClick={() => adjust({ hardReload: true })}>Hard reload</MenuItem>
        <MenuItem
          onClick={() => {
            if (deviceToolbar) {
              adjust({ viewport: { mode: "fill" } }, "Unable to resize browser viewport");
            } else {
              adjust(
                { viewport: { mode: "freeform", width: tab.size.width, height: tab.size.height } },
                "Unable to resize browser viewport",
              );
            }
          }}
        >
          {deviceToolbar ? "Hide device toolbar" : "Show device toolbar"}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger>Appearance</MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              onValueChange={(value) => adjust({ colorScheme: value as PreviewAppearance })}
              value={tab.colorScheme}
            >
              <MenuRadioItem value="system">System</MenuRadioItem>
              <MenuRadioItem value="light">Light</MenuRadioItem>
              <MenuRadioItem value="dark">Dark</MenuRadioItem>
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuItem closeOnClick={false}>
          <span className="flex-1">Zoom</span>
          <Button aria-label="Zoom out" onClick={() => zoom(-1)} size="icon-xs" variant="outline">
            <MinusIcon className="size-3" />
          </Button>
          <span className="w-10 text-center tabular-nums">{Math.round(tab.zoomFactor * 100)}%</span>
          <Button aria-label="Zoom in" onClick={() => zoom(1)} size="icon-xs" variant="outline">
            <PlusIcon className="size-3" />
          </Button>
          <Button
            aria-label="Reset zoom"
            onClick={() => adjust({ zoomFactor: 1 })}
            size="icon-xs"
            variant="ghost"
          >
            <RotateCcwIcon className="size-3" />
          </Button>
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => adjust({ clear: "cookies" })}>Clear cookies</MenuItem>
        <MenuItem onClick={() => adjust({ clear: "cache" })}>Clear cache</MenuItem>
      </MenuPopup>
    </Menu>
  );

  /** Answers the page's file picker with the chosen files, or cancels it with none (D1203). */
  const uploadFiles = async (files: readonly File[]) => {
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > PREVIEW_UPLOAD_MAX_BYTES) {
      throw new Error(
        `The page takes at most ${PREVIEW_UPLOAD_MAX_BYTES / 1024 / 1024} MiB of files at once.`,
      );
    }
    await services.call("preview.tab.upload", {
      ...ids,
      viewer,
      files: await Promise.all(
        files.map(async (file) => ({
          name: file.name || "file",
          ...(file.type === "" ? {} : { mimeType: file.type }),
          data: await base64Of(file),
        })),
      ),
    });
  };

  const loading = status.state === "loading" || (status.state !== "idle" && !painted);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background" data-preview-tab={tab.tabId}>
      <ChromeRow
        canGoBack={tab.canGoBack}
        canGoForward={tab.canGoForward}
        disabled={!youControl}
        float={{
          floating,
          disabled: !floating && status.state === "failed",
          onToggle: () => services.float(panelKey, floating ? undefined : tab.tabId),
        }}
        leading={profileBadge}
        loading={status.state === "loading"}
        menu={menu}
        onBack={() => navigate({ delta: -1 })}
        onForward={() => navigate({ delta: 1 })}
        onRefresh={() => navigate({ reload: {} })}
        onSubmit={(value) => {
          try {
            navigate({ url: resolveAddressBarInput(value) });
          } catch (error) {
            services.onError("Unable to open the page", error);
          }
        }}
        services={services}
        url={url}
      />
      <div className="visible relative z-20 flex shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-2 py-1">
        <span className="text-xs text-muted-foreground" role="status">
          {controlLabel(tab, viewer)}
        </span>
        <Button
          disabled={tab.controller !== null && !youControl}
          onClick={() =>
            tabCall(
              "preview.tab.control",
              { viewer, take: !youControl },
              "Unable to change the browser tab",
            )
          }
          size="xs"
          variant="outline"
        >
          {youControl ? "Release control" : "Take control"}
        </Button>
      </div>
      {tab.viewport.mode !== "fill" ? (
        <DeviceToolbar
          onChange={(setting) => {
            adjust({ viewport: setting }, "Unable to resize browser viewport");
          }}
          setting={tab.viewport}
        />
      ) : null}
      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        data-loading={loading ? "true" : "false"}
      >
        <div className={cn("size-full", status.state === "idle" && "invisible")}>
          <BrowserSurface
            canOperate={youControl}
            client={props.client}
            humanControls={tab.controller !== null}
            onError={fail("Unable to change the browser tab")}
            onFirstFrame={() => setPainted(true)}
            tabId={tab.tabId}
            threadId={threadId}
            viewer={viewer}
          />
        </div>
        {status.state === "idle" ? (
          <div className="absolute inset-0">
            <EmptyState
              onOpen={(value) => navigate({ url: resolveAddressBarInput(value) })}
              services={services}
            />
          </div>
        ) : null}
        {status.state === "failed" ? (
          <Unreachable
            description={status.description}
            onReload={() => navigate({ reload: {} })}
            url={status.url}
          />
        ) : null}
        {tab.fileChooser !== null && youControl ? (
          <FileChooserDialog
            accept={tab.fileChooser.accept}
            multiple={tab.fileChooser.multiple}
            onAnswer={(files) =>
              void uploadFiles(files).catch((error: unknown) =>
                services.onError("Could not send the files to the page", error),
              )
            }
          />
        ) : null}
        {tab.dialog !== null ? (
          <div
            className="absolute inset-x-2 top-2 z-10 flex flex-col gap-2 rounded-lg border border-border bg-background p-3 shadow-lg"
            role="alertdialog"
          >
            <p className="text-sm">{tab.dialog.message}</p>
            {youControl ? (
              <>
                {tab.dialog.type === "prompt" ? (
                  <Input
                    aria-label="Dialog response"
                    defaultValue={tab.dialog.defaultValue}
                    onChange={(event) => setPromptText(event.currentTarget.value)}
                    size="sm"
                  />
                ) : null}
                <div className="flex justify-end gap-2">
                  <Button
                    onClick={() =>
                      tabCall(
                        "preview.tab.dialog",
                        { viewer, accept: false },
                        "Unable to change the browser tab",
                      )
                    }
                    size="xs"
                    variant="outline"
                  >
                    Dismiss
                  </Button>
                  <Button
                    onClick={() =>
                      tabCall(
                        "preview.tab.dialog",
                        {
                          viewer,
                          accept: true,
                          ...(tab.dialog?.type === "prompt"
                            ? { promptText: promptText ?? tab.dialog.defaultValue }
                            : {}),
                        },
                        "Unable to change the browser tab",
                      )
                    }
                    size="xs"
                  >
                    Accept
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Take control to respond.</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
