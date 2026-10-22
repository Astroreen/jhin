// The tabs of the node's browser follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/preview/ServerBrowser.ts (tabs, their limits and idle sweep, popups, the
// current tab of an agent session, navigation status, dialogs, file choosers, downloads,
// viewers and their input, the screencast, the agent's cursor and recordings) and
// apps/server/src/mcp/PreviewAutomationBroker.ts (the current tab and the error wording).
import * as Crypto from "node:crypto";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import {
  DEFAULT_PREVIEW_VIEWPORT,
  PREVIEW_CONTROL_MESSAGES,
  PREVIEW_RECORDING_MAX_BYTES,
  PreviewError,
  PreviewEvents,
  normalizePreviewUrl,
  previewFramesStream,
  previewTabsStream,
  resolvePreviewViewport,
  PreviewUrlError,
  type PreviewActionEvent,
  type PreviewAppearance,
  type PreviewClickInput,
  type PreviewConsoleEntry,
  type PreviewDialogInput,
  type PreviewDragInput,
  type PreviewEvaluateInput,
  type PreviewHoverInput,
  type PreviewInputEvent,
  type PreviewNavigateInput,
  type PreviewNavStatus,
  type PreviewNetworkEntry,
  type PreviewOpenInput,
  type PreviewPressInput,
  type PreviewRecordingArtifact,
  type PreviewResizeInput,
  type PreviewScrollInput,
  type PreviewSelectInput,
  type PreviewSnapshot,
  type PreviewSnapshotInput,
  type PreviewStatus,
  type PreviewTab,
  type PreviewTabAdjustInput,
  type PreviewTarget,
  type PreviewTypeInput,
  type PreviewUploadInput,
  type PreviewViewportSetting,
  type PreviewWaitForInput,
  DEFAULT_BROWSER_PROFILE_ID,
} from "@jhin/preview-api";
import type { MemoryStreams } from "@jhin/rpc";
import type { Json } from "@jhin/storage-api";
import type { Invocation, Logger } from "@jhin/sdk";
import type {
  BrowserContext,
  CDPSession,
  Dialog,
  Download,
  FileChooser,
  Page,
} from "playwright-core";

import { Chromium, RENDER_SCALE, presentAsChrome } from "./chromium.ts";
import { ControlInterrupted, TabControl } from "./control.ts";
import * as Ops from "./page.ts";
import { RECORDING_ENCODER_SCRIPT, RECORDING_SCREENCAST, type EncoderWindow } from "./recording.ts";

const AGENT_TAB_LIMIT = 8;
const SERVER_TAB_LIMIT = 32;
const IDLE_AGENT_TAB_MS = 30 * 60_000;
const SWEEP_EVERY_MS = 60_000;
const DOWNLOADS_KEPT = 20;
const AGENT_CURSOR_MOVE_MS = 160;
const AGENT_CURSOR_CLICK_LEAD_MS = 40;
/** Chromium gets the ack for a frame no sooner than this after it came (T3's pacing). */
const FRAME_ACK_MS = 100;
const FRAME_QUALITY = 70;
const READ_OPERATIONS = new Set(["status", "snapshot", "waitFor"]);
const VIEWER_NAVIGATION = { waitUntil: "commit", timeout: Ops.DEFAULT_TIMEOUT_MS } as const;
/** T3's EDITABLE_AT_POINT_SCRIPT: whether a tap there should raise a soft keyboard (D1203). */
const EDITABLE_AT_POINT_SCRIPT = `(x, y) => {
  let element = document.elementFromPoint(x, y);
  while (element && element.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  if (element && element.tagName === "LABEL" && element.control) element = element.control;
  if (!element) return false;
  if (element.tagName === "IFRAME" || element.tagName === "FRAME") return true;
  if (element.isContentEditable) return true;
  if (element.tagName === "TEXTAREA") return !element.disabled && !element.readOnly;
  if (element.tagName !== "INPUT") return false;
  const nonText = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
  return !nonText.includes(element.type) && !element.disabled && !element.readOnly;
}`;

interface Recording {
  readonly encoder: Page;
  readonly session: CDPSession;
  readonly startedAt: string;
  readonly framesInFlight: Set<Promise<void>>;
}

interface Screencast {
  readonly session: CDPSession;
  readonly cap: { readonly width: number; readonly height: number };
}

interface Tab {
  readonly threadId: string;
  readonly tabId: string;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly context: BrowserContext;
  readonly isolated: boolean;
  /** A human's tab: the profile it browses with (D952). */
  readonly profileId: string | undefined;
  readonly control: TabControl;
  readonly openerTabId: string | undefined;
  readonly openedAt: string;
  updatedAt: string;
  usedAt: number;
  navStatus: PreviewNavStatus;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  navigationGeneration: number;
  setting: PreviewViewportSetting;
  /** The size `fill` takes: the newest a viewer asked for. */
  fillSize: { width: number; height: number };
  colorScheme: PreviewAppearance;
  zoomFactor: number;
  reveal: boolean;
  dialog: Dialog | null;
  fileChooser: FileChooser | null;
  /** The open chooser's `accept` attribute. */
  fileChooserAccept: string;
  readonly downloads: {
    fileName: string;
    path: string;
    sizeBytes: number;
    url: string;
    completedAt: string;
  }[];
  readonly consoleEntries: PreviewConsoleEntry[];
  readonly networkEntries: PreviewNetworkEntry[];
  readonly actionTimeline: PreviewActionEvent[];
  recording: Recording | null;
  recordingStart: Promise<Recording> | null;
  viewers: number;
  frameScale: number;
  screencast: Promise<Screencast | null> | null;
  screencastSync: Promise<void>;
  /** Snapshots and recordings in progress: the viewers' screencast waits for them. */
  capturing: number;
  captureLock: Promise<void>;
  lastFrame: number | undefined;
  lastPointer: number | undefined;
  closing: boolean;
}

export interface TabsOptions {
  readonly chromium: Chromium;
  readonly streams: MemoryStreams;
  /** Where screenshots, recordings and downloads go. */
  readonly dataDir: string;
  readonly log: Logger;
  /** The clock tabs are stamped and swept by. */
  readonly now?: () => Date;
}

const tabKey = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;

function pushBounded<T>(list: T[], entry: T, limit: number): void {
  list.push(entry);
  if (list.length > limit) list.splice(0, list.length - limit);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An agent session: the caller, the thread and the session it names (D396). */
export function sessionKey(input: PreviewTarget, invocation: Invocation): string {
  return [invocation.caller?.id ?? "local", input.threadId, input.session ?? ""].join("\u0000");
}

/** Modifier bits of T3's stream input as CDP's (alt 1, ctrl 2, meta 4, shift 8: the same). */
const modifiersOf = (value: number | undefined) => value ?? 0;

// Cmd shortcuts from Apple viewers are no editing shortcut for headless Chromium on
// Linux, so they carry the command; copy and cut only run as commands there.
function editingCommand(key: string, modifiers: number): { commands: string[] } | null {
  const modifier = modifiers & 0b0111;
  if (modifier !== 2 && modifier !== 4) return null;
  const lower = key.toLowerCase();
  const command =
    lower === "c"
      ? "copy"
      : lower === "x"
        ? "cut"
        : modifier !== 4
          ? null
          : lower === "a"
            ? "selectAll"
            : lower === "z"
              ? modifiers & 8
                ? "redo"
                : "undo"
              : null;
  return command === null ? null : { commands: [command] };
}

/** The tabs of the node's browser (D394–D402). */
export function createTabs(options: TabsOptions) {
  const { chromium, streams, log } = options;
  const clock = () => options.now?.().getTime() ?? Date.now();
  const now = () => new Date(clock()).toISOString();
  const instance = Crypto.randomUUID().slice(0, 8);
  let sequence = 0;
  const tabs = new Map<string, Tab>();
  /** Subscribers of each tab's frames stream, by tab key. */
  const viewerCounts = new Map<string, number>();
  /** The current tab of each agent session. */
  const current = new Map<string, string>();
  const pendingTabs = new Set<Promise<unknown>>();
  let disposed = false;

  const threadTabs = (threadId: string) =>
    [...tabs.values()].filter((tab) => tab.threadId === threadId);

  // --- Publishing ------------------------------------------------------------

  const dirtyThreads = new Set<string>();
  const summary = (tab: Tab): PreviewTab => ({
    threadId: tab.threadId,
    tabId: tab.tabId,
    navStatus: tab.navStatus,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    viewport: tab.setting,
    size: tab.page.viewportSize() ?? DEFAULT_PREVIEW_VIEWPORT,
    colorScheme: tab.colorScheme,
    zoomFactor: tab.zoomFactor,
    owner: ownerOf(tab),
    controller: tab.control.controller,
    generation: tab.control.generation,
    dialog:
      tab.dialog === null
        ? null
        : {
            type: tab.dialog.type(),
            message: tab.dialog.message().slice(0, 4000),
            defaultValue: tab.dialog.defaultValue().slice(0, 4000),
          },
    fileChooser:
      tab.fileChooser === null
        ? null
        : {
            multiple: tab.fileChooser.isMultiple(),
            accept: tab.fileChooserAccept,
          },
    recording: tab.recording !== null,
    visible: tab.viewers > 0,
    reveal: tab.reveal,
    ...(tab.openerTabId === undefined ? {} : { openerTabId: tab.openerTabId }),
    ...(tab.profileId === undefined ? {} : { profileId: tab.profileId }),
    openedAt: tab.openedAt,
    updatedAt: tab.updatedAt,
  });
  /** The thread's `preview.tabs` event, once per tick however many changes came. */
  const publish = (threadId: string) => {
    if (dirtyThreads.has(threadId)) return;
    dirtyThreads.add(threadId);
    queueMicrotask(() => {
      dirtyThreads.delete(threadId);
      const stream = previewTabsStream(threadId);
      streams.clear(stream);
      // Summaries are plain JSON; their optional fields are left out, never undefined.
      const list = threadTabs(threadId).map(summary) as unknown as Json[];
      streams.append(stream, PreviewEvents.tabs, { tabs: list });
    });
  };
  const changed = (tab: Tab) => {
    tab.updatedAt = now();
    publish(tab.threadId);
  };

  const ownerOf = (tab: Tab) =>
    tab.control.controller !== null
      ? ("human" as const)
      : tab.control.agentId !== null
        ? ("agent" as const)
        : ("unclaimed" as const);

  // --- Creating and dropping tabs ---------------------------------------------

  const fixedSize = (setting: PreviewViewportSetting) =>
    setting.mode === "fill" ? undefined : { width: setting.width, height: setting.height };

  const reportStatus = async (tab: Tab, navStatus: PreviewNavStatus) => {
    tab.navStatus = navStatus;
    try {
      const history = await tab.cdp.send("Page.getNavigationHistory");
      tab.canGoBack = history.currentIndex > 0;
      tab.canGoForward = history.currentIndex < history.entries.length - 1;
    } catch {
      // The page is going away.
    }
    changed(tab);
  };
  /** A page may retitle itself without navigating: actions look again when they end. */
  const refreshTitle = async (tab: Tab) => {
    const before = tab.navStatus;
    if (tab.closing || tab.loading || before.state !== "success") return;
    const title = (await tab.page.title().catch(() => "")).slice(0, 512);
    // A navigation that began meanwhile owns the status now.
    if (tab.navStatus !== before || tab.loading || tab.closing) return;
    if (title !== before.title) await reportStatus(tab, { ...before, title });
  };
  const reportLoaded = async (tab: Tab) => {
    const url = tab.page.url();
    if (url === "about:blank" || url.startsWith("chrome-error://")) return;
    const title = await tab.page.title().catch(() => "");
    await reportStatus(tab, {
      state: "success",
      url: url.slice(0, 2048),
      title: title.slice(0, 512),
    });
  };

  async function createTab(input: {
    threadId: string;
    agentId: string | null;
    url?: string | undefined;
    reveal: boolean;
    setting?: PreviewViewportSetting | undefined;
    adopted?: { page: Page; openerTabId: string } | undefined;
    profileId?: string | undefined;
  }): Promise<Tab> {
    const isolated = input.adopted === undefined && input.agentId !== null;
    // A popup keeps its opener's profile (none for an agent's own context).
    const profileId =
      input.adopted !== undefined
        ? input.profileId
        : isolated
          ? undefined
          : (input.profileId ?? DEFAULT_BROWSER_PROFILE_ID);
    const opened = input.adopted
      ? { page: input.adopted.page, context: input.adopted.page.context() }
      : await chromium.newPage(isolated, profileId);
    const { page, context } = opened;
    const cdp = await context.newCDPSession(page);
    await presentAsChrome(cdp).catch(() => undefined);
    page.setDefaultTimeout(Ops.DEFAULT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(Ops.DEFAULT_TIMEOUT_MS);
    sequence += 1;
    const tab: Tab = {
      threadId: input.threadId,
      tabId: `tab_${sequence.toString(36)}_${instance}`,
      page,
      cdp,
      context,
      isolated,
      profileId,
      control: new TabControl(input.agentId, () => {
        Ops.invalidateRefs(page);
        changed(tab);
      }),
      openerTabId: input.adopted?.openerTabId,
      openedAt: now(),
      updatedAt: now(),
      usedAt: clock(),
      navStatus:
        input.url === undefined
          ? { state: "idle" }
          : { state: "loading", url: input.url, title: "" },
      canGoBack: false,
      canGoForward: false,
      loading: false,
      navigationGeneration: 0,
      setting: input.setting ?? { mode: "fill" },
      fillSize: { ...DEFAULT_PREVIEW_VIEWPORT },
      colorScheme: "system",
      zoomFactor: 1,
      reveal: input.reveal,
      dialog: null,
      fileChooser: null,
      fileChooserAccept: "",
      downloads: [],
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      recording: null,
      recordingStart: null,
      viewers: 0,
      frameScale: 1,
      screencast: null,
      screencastSync: Promise.resolve(),
      capturing: 0,
      captureLock: Promise.resolve(),
      lastFrame: undefined,
      lastPointer: undefined,
      closing: false,
    };
    if (input.adopted === undefined) {
      await page.setViewportSize(fixedSize(tab.setting) ?? tab.fillSize);
    }
    const isMainNavigation = (request: { isNavigationRequest(): boolean; frame(): unknown }) =>
      request.isNavigationRequest() && request.frame() === page.mainFrame();
    const generations = new WeakMap<object, number>();
    page.on("request", (request) => {
      if (!isMainNavigation(request)) return;
      generations.set(request, ++tab.navigationGeneration);
      tab.loading = true;
      void reportStatus(tab, { state: "loading", url: request.url().slice(0, 2048), title: "" });
    });
    page.on("load", () => {
      tab.loading = false;
      void reportLoaded(tab);
    });
    page.on("framenavigated", (frame) => {
      // Same-document navigations (single-page routes) fire no load event.
      if (frame === page.mainFrame() && !tab.loading) void reportLoaded(tab);
    });
    page.on("requestfailed", (request) => {
      const errorText = request.failure()?.errorText ?? "";
      pushBounded(
        tab.networkEntries,
        {
          url: request.url(),
          method: request.method(),
          status: null,
          failed: true,
          errorText,
          timestamp: now(),
        },
        Ops.DIAGNOSTIC_LIMIT,
      );
      if (!isMainNavigation(request)) return;
      // A navigation a newer one replaced leaves the status to the newer one.
      if ((generations.get(request) ?? 0) !== tab.navigationGeneration) return;
      // An aborted navigation is usually a download; its event settles the status.
      if (errorText.includes("ERR_ABORTED")) return;
      tab.loading = false;
      const { code, description } = Ops.parseNetError(errorText);
      void reportStatus(tab, {
        state: "failed",
        url: request.url().slice(0, 2048),
        title: "",
        code,
        description,
      });
    });
    page.on("response", (response) => {
      pushBounded(
        tab.networkEntries,
        {
          url: response.url(),
          method: response.request().method(),
          status: response.status(),
          failed: false,
          timestamp: now(),
        },
        Ops.DIAGNOSTIC_LIMIT,
      );
    });
    page.on("console", (message) => {
      pushBounded(
        tab.consoleEntries,
        { level: message.type(), text: message.text().slice(0, 2000), timestamp: now() },
        Ops.DIAGNOSTIC_LIMIT,
      );
    });
    page.on("dialog", (dialog) => {
      tab.dialog = dialog;
      Ops.invalidateRefs(page);
      changed(tab);
    });
    page.on("filechooser", (chooser) => {
      tab.fileChooser = chooser;
      tab.fileChooserAccept = "";
      changed(tab);
      void chooser
        .element()
        .getAttribute("accept")
        .then((accept) => {
          if (tab.fileChooser !== chooser) return;
          tab.fileChooserAccept = accept ?? "";
          changed(tab);
        })
        .catch(() => undefined);
    });
    page.on("download", (download) => void saveDownload(tab, download));
    // Popups become tabs and keep `window.opener`, so sign-in popups can report back.
    page.on("popup", (popup) => void adoptPopup(tab, popup));
    // Playwright cannot reload a crashed page, so it leaves the tab list.
    page.on("close", () => void dropTab(tab, "page closed"));
    page.on("crash", () => void dropTab(tab, "page crashed"));
    tabs.set(tabKey(tab.threadId, tab.tabId), tab);
    tab.viewers = viewerCounts.get(tabKey(tab.threadId, tab.tabId)) ?? 0;
    changed(tab);
    if (tab.viewers > 0) void syncScreencast(tab);
    if (input.adopted === undefined && input.url !== undefined) {
      const url = input.url;
      const navigation = page
        .goto(url, { waitUntil: "commit", timeout: Ops.DEFAULT_TIMEOUT_MS })
        .then(() => page.waitForLoadState("load").catch(() => undefined));
      tab.control.track(navigation);
      void navigation.catch(() => undefined);
    }
    return tab;
  }

  async function adoptPopup(opener: Tab, popup: Page) {
    const agentId = opener.control.agentId;
    const atLimit =
      agentId !== null &&
      [...tabs.values()].filter((tab) => tab.control.agentId === agentId).length >= AGENT_TAB_LIMIT;
    if (opener.closing || atLimit || tabs.size >= SERVER_TAB_LIMIT || disposed) {
      await popup.close().catch(() => undefined);
      return;
    }
    const created = createTab({
      threadId: opener.threadId,
      agentId,
      reveal: false,
      adopted: { page: popup, openerTabId: opener.tabId },
      // A popup is in its opener's context, so in its profile too.
      profileId: opener.profileId,
    });
    pendingTabs.add(created);
    try {
      await created;
      await reportLoaded(await created);
    } catch (error) {
      log.warn("popup not adopted", { error: String(error) });
      await popup.close().catch(() => undefined);
    } finally {
      pendingTabs.delete(created);
    }
  }

  async function saveDownload(tab: Tab, download: Download) {
    try {
      const folder = Path.join(
        options.dataDir,
        "downloads",
        Crypto.createHash("sha256")
          .update(tabKey(tab.threadId, tab.tabId))
          .digest("hex")
          .slice(0, 32),
      );
      await Fs.mkdir(folder, { recursive: true });
      const fileName = Path.basename(download.suggestedFilename()) || "download";
      const path = Path.join(folder, `${Crypto.randomUUID()}-${fileName}`);
      await download.saveAs(path);
      const { size } = await Fs.stat(path);
      pushBounded(
        tab.downloads,
        { fileName, path, sizeBytes: size, url: download.url(), completedAt: now() },
        DOWNLOADS_KEPT,
      );
      changed(tab);
    } catch (error) {
      log.warn("download not saved", { tabId: tab.tabId, error: String(error) });
    }
  }

  async function dropTab(tab: Tab, reason = "closed") {
    const key = tabKey(tab.threadId, tab.tabId);
    if (tabs.get(key) !== tab || tab.closing) return;
    tab.closing = true;
    tabs.delete(key);
    log.info("preview tab closed", { threadId: tab.threadId, tabId: tab.tabId, reason });
    await tab.control.close();
    await stopScreencast(tab);
    const recording = tab.recording;
    tab.recording = null;
    await recording?.encoder
      .context()
      .close()
      .catch(() => undefined);
    await tab.page.close().catch(() => undefined);
    if (tab.isolated) await tab.context.close().catch(() => undefined);
    streams.delete(previewFramesStream(tab.threadId, tab.tabId));
    publish(tab.threadId);
    // The browser goes with its last tab (D394).
    if (tabs.size === 0 && pendingTabs.size === 0) await chromium.close();
  }

  // --- Viewers and their picture ----------------------------------------------

  const viewerCap = (tab: Tab) => {
    const size = tab.page.viewportSize() ?? DEFAULT_PREVIEW_VIEWPORT;
    const scale = Math.min(Math.max(tab.frameScale, 1), RENDER_SCALE);
    return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
  };

  const appendFrame = (tab: Tab, payload: { data: string; width: number; height: number }) => {
    const stream = previewFramesStream(tab.threadId, tab.tabId);
    if (tab.lastFrame !== undefined) streams.remove(stream, tab.lastFrame);
    tab.lastFrame = streams.append(stream, PreviewEvents.frame, payload).sequence;
  };

  async function startScreencast(tab: Tab): Promise<Screencast | null> {
    if (tab.viewers === 0 || tab.closing) return null;
    const cap = viewerCap(tab);
    const session = await tab.context.newCDPSession(tab.page);
    session.on("Page.screencastFrame", (frame) => {
      const arrived = Date.now();
      // The page's CSS size: what the viewer maps its pointer onto.
      appendFrame(tab, {
        data: frame.data,
        ...(tab.page.viewportSize() ?? DEFAULT_PREVIEW_VIEWPORT),
      });
      const wait = Math.max(0, FRAME_ACK_MS - (Date.now() - arrived));
      setTimeout(() => {
        void session
          .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
          .catch(() => undefined);
      }, wait);
    });
    await session.send("Page.startScreencast", {
      format: "jpeg",
      quality: FRAME_QUALITY,
      maxWidth: cap.width,
      maxHeight: cap.height,
    });
    // An idle page sends no frame until it paints: a new viewer gets one now.
    if (tab.lastFrame === undefined) {
      const data = await Ops.captureViewport(tab.page, tab.cdp, {
        format: "jpeg",
        quality: FRAME_QUALITY,
        scale: cap.width / ((tab.page.viewportSize()?.width ?? cap.width) * RENDER_SCALE),
      }).catch(() => undefined);
      const size = tab.page.viewportSize() ?? DEFAULT_PREVIEW_VIEWPORT;
      if (data !== undefined && !tab.closing) appendFrame(tab, { data, ...size });
    }
    return { session, cap };
  }

  async function stopScreencast(tab: Tab) {
    const running = tab.screencast;
    tab.screencast = null;
    const screencast = await running?.catch(() => null);
    if (screencast) {
      await screencast.session.send("Page.stopScreencast").catch(() => undefined);
      await screencast.session.detach().catch(() => undefined);
    }
  }

  /** Starts, restarts (another size) or stops the viewers' screencast. */
  /** Calls run one after another per tab, so two never start a screencast each. */
  function syncScreencast(tab: Tab): Promise<void> {
    const next = tab.screencastSync.then(() => syncScreencastNow(tab));
    tab.screencastSync = next.catch(() => undefined);
    return next;
  }

  async function syncScreencastNow(tab: Tab) {
    if (tab.viewers === 0 || tab.closing || tab.capturing > 0) {
      await stopScreencast(tab);
      return;
    }
    const running = await tab.screencast?.catch(() => null);
    const cap = viewerCap(tab);
    if (running && running.cap.width === cap.width && running.cap.height === cap.height) return;
    await stopScreencast(tab);
    if (tab.viewers === 0 || tab.closing) return;
    const started = startScreencast(tab);
    tab.screencast = started;
    await started.catch((error: unknown) =>
      log.warn("screencast not started", { tabId: tab.tabId, error: String(error) }),
    );
  }

  /** A client began or stopped watching a tab's frames (its stream's subscribers). */
  function watch(threadId: string, tabId: string, delta: 1 | -1) {
    const key = tabKey(threadId, tabId);
    // Counted by stream, so a subscription that comes before its tab is registered counts.
    const count = Math.max(0, (viewerCounts.get(key) ?? 0) + delta);
    if (count === 0) viewerCounts.delete(key);
    else viewerCounts.set(key, count);
    const tab = tabs.get(key);
    if (tab === undefined) return;
    tab.viewers = count;
    if (tab.viewers === 0) {
      // The last viewer went: whoever held control lets go (D397).
      void tab.control.releaseAny(() => releaseInput(tab)).catch(() => undefined);
    }
    changed(tab);
    void syncScreencast(tab);
  }

  /** Snapshots and recording captures pause the viewers' screencast, as T3's do. */
  async function withCapture<A>(tab: Tab, run: () => Promise<A>): Promise<A> {
    const previous = tab.captureLock;
    let release = () => {};
    tab.captureLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    tab.capturing += 1;
    try {
      await stopScreencast(tab);
      return await run();
    } finally {
      tab.capturing -= 1;
      release();
      void syncScreencast(tab);
    }
  }

  const pointer =
    (tab: Tab): Ops.PointerReporter =>
    async (point, phase) => {
      const watched = tab.viewers > 0 || tab.recording !== null;
      if (!watched) return;
      const stream = previewFramesStream(tab.threadId, tab.tabId);
      if (tab.lastPointer !== undefined) streams.remove(stream, tab.lastPointer);
      tab.lastPointer = streams.append(stream, PreviewEvents.pointer, {
        phase,
        x: point.x,
        y: point.y,
      }).sequence;
      void tab.recording?.encoder
        .evaluate(
          ([x, y, click]) =>
            (globalThis as unknown as EncoderWindow).jhinRecorder.cursor(x, y, click),
          [point.x, point.y, phase === "click"] as const,
        )
        .catch(() => undefined);
      await delay(
        phase === "click"
          ? AGENT_CURSOR_MOVE_MS + AGENT_CURSOR_CLICK_LEAD_MS
          : AGENT_CURSOR_MOVE_MS,
      );
    };

  // --- Finding the tab an agent means -------------------------------------------

  const find = (threadId: string, tabId: string) => tabs.get(tabKey(threadId, tabId));

  function notFound(operation: string, tabId?: string): PreviewError {
    return new PreviewError(
      "PREVIEW_TAB_NOT_FOUND",
      tabId === undefined
        ? `No active preview tab was found for ${operation}. Call preview_open first.`
        : `Preview tab ${tabId} was not found for ${operation}. Omit tabId to use the current tab, or call preview_open.`,
      { ...(tabId === undefined ? {} : { tabId }), instance },
    );
  }
  const controlError = (reason: keyof typeof PREVIEW_CONTROL_MESSAGES) =>
    new PreviewError("PREVIEW_CONTROL", PREVIEW_CONTROL_MESSAGES[reason], { reason });

  const owned = (agent: string, threadId: string) =>
    threadTabs(threadId).filter((tab) => tab.control.agentId === agent);

  /** The tab a command means (D396). */
  function resolveTab(agent: string, input: PreviewTarget, operation: string): Tab {
    if (input.tabId !== undefined) {
      const tab = find(input.threadId, input.tabId);
      if (tab === undefined) throw notFound(operation, input.tabId);
      return tab;
    }
    const assigned = current.get(agent);
    const assignedTab = assigned === undefined ? undefined : find(input.threadId, assigned);
    if (assignedTab !== undefined) return assignedTab;
    const mine = owned(agent, input.threadId);
    if (mine.length > 1) throw controlError("tabRequired");
    if (mine.length === 1) return mine[0]!;
    const thread = threadTabs(input.threadId).toSorted((a, b) => b.usedAt - a.usedAt);
    const tab = thread.find((candidate) => candidate.viewers > 0) ?? thread[0];
    if (tab === undefined) throw notFound(operation);
    return tab;
  }

  const markUsed = (agent: string, tab: Tab) => {
    const at = clock();
    tab.usedAt = at;
    for (const other of tabs.values()) if (other.control.agentId === agent) other.usedAt = at;
    current.set(agent, tab.tabId);
  };

  /** Runs an agent's operation under the tab's control (D397). */
  async function act<A>(
    agent: string,
    input: PreviewTarget,
    operation: string,
    run: (tab: Tab) => Promise<A>,
    record = true,
  ): Promise<A> {
    try {
      const tab = resolveTab(agent, input, operation);
      markUsed(agent, tab);
      if (READ_OPERATIONS.has(operation) && !tab.control.agentCanActNow(agent)) {
        if (tab.dialog !== null) throw controlError("dialogPending");
        return await tab.control.observe(() => run(tab));
      }
      if (!tab.control.agentMayAct(agent)) {
        throw new PreviewError(
          "PREVIEW_CONTROL",
          "This tab belongs to another agent session. You can read it, but open your own tab to act.",
          { reason: "agentMismatch" },
        );
      }
      return await tab.control.agent(agent, async () => {
        if (tab.dialog !== null && operation !== "dialog") throw controlError("dialogPending");
        const generation = tab.control.generation;
        const action: PreviewActionEvent | undefined = record
          ? { id: Crypto.randomUUID(), action: operation, status: "running", startedAt: now() }
          : undefined;
        if (action !== undefined) pushBounded(tab.actionTimeline, action, Ops.ACTION_LIMIT);
        const settle = (patch: Partial<PreviewActionEvent>) => {
          if (action === undefined) return;
          const index = tab.actionTimeline.indexOf(action);
          if (index >= 0) tab.actionTimeline[index] = { ...action, ...patch, completedAt: now() };
        };
        try {
          const result = await run(tab);
          void refreshTitle(tab).catch(() => undefined);
          settle({ status: "succeeded" });
          return result;
        } catch (error) {
          settle({
            status: error instanceof ControlInterrupted ? "interrupted" : "failed",
            error: error instanceof Error ? error.message.slice(0, 500) : String(error),
          });
          throw error;
        } finally {
          if (tab.control.generation !== generation) Ops.invalidateRefs(tab.page);
        }
      });
    } catch (error) {
      throw Ops.toPreviewError(error);
    }
  }

  // --- Status -------------------------------------------------------------------

  async function status(
    agent: string,
    threadId: string,
    tab: Tab | undefined,
  ): Promise<PreviewStatus> {
    const list = threadTabs(threadId).map((each) => ({
      tabId: each.tabId,
      url: each.navStatus.state === "idle" ? null : each.navStatus.url,
      ...(each.openerTabId === undefined ? {} : { openerTabId: each.openerTabId }),
      owner: ownerOf(each),
      ownedByCaller: each.control.agentId === agent,
      visible: each.viewers > 0,
    }));
    if (tab === undefined) {
      return {
        available: true,
        visible: false,
        tabId: null,
        url: null,
        title: null,
        loading: false,
        tabs: list,
      };
    }
    const url = tab.page.url();
    const nav = tab.navStatus;
    return {
      available: true,
      visible: tab.viewers > 0,
      tabId: tab.tabId,
      url: url === "about:blank" ? (nav.state === "idle" ? null : nav.url) : url,
      // The live title: a page may change it without navigating.
      title:
        (await tab.page.title().catch(() => "")) ||
        (nav.state === "idle" ? null : nav.title || null),
      loading: tab.loading,
      control: {
        owner: ownerOf(tab),
        ownedByCaller: tab.control.agentId === agent,
        generation: tab.control.generation,
      },
      dialog: summary(tab).dialog,
      viewportSetting: tab.setting,
      viewport: tab.page.viewportSize() ?? DEFAULT_PREVIEW_VIEWPORT,
      fileChooser: summary(tab).fileChooser,
      downloads: [...tab.downloads],
      tabs: list,
    };
  }

  // --- Navigation -----------------------------------------------------------------

  const targetUrl = (input: Pick<PreviewNavigateInput, "url" | "target">): string => {
    try {
      if (input.url !== undefined) return normalizePreviewUrl(input.url);
      const target = input.target!;
      if (target.kind === "url") return normalizePreviewUrl(target.url);
      const path = target.path ?? "";
      const suffix = path === "" || /^[/?#]/.test(path) ? path : `/${path}`;
      return `${target.protocol ?? "http"}://localhost:${target.port}${suffix}`;
    } catch (error) {
      if (error instanceof PreviewUrlError) {
        throw new PreviewError("PREVIEW_INVALID_URL", error.message, { reason: error.reason });
      }
      throw error;
    }
  };

  async function navigate(
    tab: Tab,
    url: string,
    readiness: "load" | "domContentLoaded" | "none",
    timeout: number,
  ) {
    const waitUntil =
      readiness === "load"
        ? "load"
        : readiness === "domContentLoaded"
          ? "domcontentloaded"
          : "commit";
    const navigation = tab.page.goto(url, { waitUntil, timeout });
    if (readiness === "none") {
      tab.control.track(navigation);
      void navigation.catch(() => undefined);
      return;
    }
    try {
      await navigation;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Download is starting/i.test(message)) {
        throw new PreviewError(
          "PREVIEW_EXECUTION",
          "URL is a file this browser cannot show, so it was downloaded instead. preview_status lists it under downloads.",
        );
      }
      const code = /ERR_[A-Z_]+/.exec(message)?.[0];
      if (code !== undefined) {
        throw new PreviewError("PREVIEW_EXECUTION", `Navigation to ${url} failed: ${code}`);
      }
      throw error;
    }
  }

  // --- Viewport -------------------------------------------------------------------

  async function applySetting(tab: Tab, setting: PreviewViewportSetting) {
    tab.setting = setting;
    await tab.page.setViewportSize(fixedSize(setting) ?? tab.fillSize);
    changed(tab);
    void syncScreencast(tab);
  }

  async function applyAppearance(tab: Tab, colorScheme: PreviewAppearance) {
    tab.colorScheme = colorScheme;
    await tab.page.emulateMedia({ colorScheme: colorScheme === "system" ? null : colorScheme });
    changed(tab);
  }

  // --- Recording ------------------------------------------------------------------

  async function startRecording(tab: Tab): Promise<Recording> {
    if (tab.recording !== null) return tab.recording;
    if (tab.recordingStart !== null) return tab.recordingStart;
    const started = (async () => {
      const encoder = await chromium.scratchPage();
      let session: CDPSession | undefined;
      try {
        await encoder.evaluate(RECORDING_ENCODER_SCRIPT);
        // Seeded before answering, so an immediate stop has a frame to encode.
        const first = await Ops.captureViewport(tab.page, tab.cdp, {
          format: "jpeg",
          quality: RECORDING_SCREENCAST.quality,
          scale: 1,
        });
        const cssWidth = () => tab.page.viewportSize()?.width ?? DEFAULT_PREVIEW_VIEWPORT.width;
        await encoder.evaluate(
          ([data, width]) =>
            (globalThis as unknown as EncoderWindow).jhinRecorder.frame(data, width),
          [first, cssWidth()] as const,
        );
        const opened = await tab.context.newCDPSession(tab.page);
        session = opened;
        const framesInFlight = new Set<Promise<void>>();
        opened.on("Page.screencastFrame", (frame) => {
          const delivered: Promise<void> = encoder
            .evaluate(
              ([data, width]) =>
                (globalThis as unknown as EncoderWindow).jhinRecorder.frame(data, width),
              [frame.data, cssWidth()] as const,
            )
            .then(async (accepted) => {
              if (!accepted) await opened.send("Page.stopScreencast");
            })
            .catch(() => undefined)
            .finally(() => {
              framesInFlight.delete(delivered);
              void opened
                .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
                .catch(() => undefined);
            });
          framesInFlight.add(delivered);
        });
        await opened.send("Page.startScreencast", RECORDING_SCREENCAST);
        if (tab.closing) throw new Error("The tab closed while the recording started.");
        const recording: Recording = { encoder, session: opened, startedAt: now(), framesInFlight };
        tab.recording = recording;
        changed(tab);
        return recording;
      } catch (error) {
        await encoder
          .context()
          .close()
          .catch(() => undefined);
        await session?.detach().catch(() => undefined);
        throw error;
      }
    })().finally(() => {
      tab.recordingStart = null;
    });
    tab.recordingStart = started;
    return started;
  }

  async function stopRecording(tab: Tab): Promise<PreviewRecordingArtifact> {
    const recording = tab.recording ?? (await tab.recordingStart?.catch(() => null)) ?? null;
    if (recording === null) {
      throw new PreviewError("PREVIEW_RECORDING", "No recording is active for this tab.");
    }
    let mimeType: string | null;
    const chunks: Buffer[] = [];
    try {
      await recording.session.send("Page.stopScreencast").catch(() => undefined);
      await Promise.all(recording.framesInFlight);
      await recording.session.detach().catch(() => undefined);
      const stopped = await recording.encoder.evaluate(() =>
        (globalThis as unknown as EncoderWindow).jhinRecorder.stop(),
      );
      mimeType = stopped.mimeType;
      if (stopped.bytes > PREVIEW_RECORDING_MAX_BYTES) {
        throw new PreviewError(
          "PREVIEW_RECORDING",
          "The recording exceeds 50 MiB. Make a shorter recording.",
        );
      }
      for (let index = 0; index < stopped.count; index += 1) {
        const chunk = await recording.encoder.evaluate(
          (chunkIndex) => (globalThis as unknown as EncoderWindow).jhinRecorder.chunk(chunkIndex),
          index,
        );
        chunks.push(Buffer.from(chunk, "base64"));
      }
    } finally {
      await recording.encoder
        .context()
        .close()
        .catch(() => undefined);
      tab.recording = null;
      changed(tab);
    }
    const data = Buffer.concat(chunks);
    if (mimeType === null || data.byteLength === 0) {
      throw new PreviewError("PREVIEW_EXECUTION", "The recording captured no frames.");
    }
    const extension = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
    const id = Crypto.randomUUID();
    const folder = Path.join(options.dataDir, "recordings");
    await Fs.mkdir(folder, { recursive: true });
    const path = Path.join(folder, `${id}.${extension}`);
    await Fs.writeFile(path, data);
    return {
      id,
      tabId: tab.tabId,
      path,
      mimeType: mimeType.split(";")[0]!,
      sizeBytes: data.byteLength,
      createdAt: now(),
    };
  }

  // --- Idle agent tabs --------------------------------------------------------------

  async function sweepIdle() {
    const cutoff = clock() - IDLE_AGENT_TAB_MS;
    const idle = [...tabs.values()].filter(
      (tab) => tab.control.agentId !== null && tab.viewers === 0 && tab.usedAt < cutoff,
    );
    await Promise.all(idle.map((tab) => dropTab(tab, "idle")));
  }
  const sweeper = setInterval(() => void sweepIdle(), SWEEP_EVERY_MS);
  sweeper.unref();

  /** Releases what a viewer still holds down when it lets go of control. */
  async function releaseInput(tab: Tab) {
    await tab.page.mouse.up().catch(() => undefined);
    for (const key of ["Shift", "Control", "Alt", "Meta"]) {
      await tab.page.keyboard.up(key).catch(() => undefined);
    }
  }

  const withErrors = async <A>(run: () => Promise<A>): Promise<A> => {
    try {
      return await run();
    } catch (error) {
      throw Ops.toPreviewError(error);
    }
  };

  const humanTab = (threadId: string, tabId: string) => {
    const tab = find(threadId, tabId);
    if (tab === undefined) throw notFound("the panel", tabId);
    return tab;
  };

  // --- The commands' operations ----------------------------------------------------

  return {
    instance,
    watch,
    /** Closes agent tabs nobody watched or used for 30 minutes (run every minute). */
    sweep: sweepIdle,

    tabs(threadId: string): PreviewTab[] {
      return threadTabs(threadId).map(summary);
    },

    async status(agent: string, input: PreviewTarget): Promise<PreviewStatus> {
      let tab: Tab | undefined;
      try {
        tab = resolveTab(agent, input, "status");
      } catch (error) {
        if (!(error instanceof PreviewError) || error.code !== "PREVIEW_TAB_NOT_FOUND") {
          throw Ops.toPreviewError(error);
        }
        if (input.tabId !== undefined) throw error;
      }
      if (tab !== undefined) markUsed(agent, tab);
      return status(agent, input.threadId, tab);
    },

    async open(agent: string, input: PreviewOpenInput): Promise<PreviewStatus> {
      return withErrors(async () => {
        const reveal = input.open !== false;
        const url = input.url === undefined ? undefined : targetUrl({ url: input.url });
        let tab: Tab | undefined;
        if (input.reuseExistingTab !== false) {
          if (input.tabId !== undefined) {
            tab = find(input.threadId, input.tabId);
            if (tab === undefined) throw notFound("open", input.tabId);
          } else {
            const assigned = current.get(agent);
            tab = assigned === undefined ? undefined : find(input.threadId, assigned);
            if (tab === undefined) {
              const mine = owned(agent, input.threadId);
              if (mine.length > 1) throw controlError("tabRequired");
              tab = mine[0];
            }
          }
        }
        if (tab !== undefined) {
          const reused = tab;
          if (url !== undefined) {
            await act(agent, { ...input, tabId: reused.tabId }, "open", (each) =>
              navigate(each, url, "load", Ops.DEFAULT_TIMEOUT_MS),
            );
          }
          if (reveal) {
            reused.reveal = true;
            changed(reused);
          }
          markUsed(agent, reused);
          return status(agent, input.threadId, reused);
        }
        await sweepIdle();
        if (
          owned(agent, input.threadId).length >= AGENT_TAB_LIMIT ||
          tabs.size >= SERVER_TAB_LIMIT
        ) {
          throw controlError("tabLimit");
        }
        const creating = createTab({ threadId: input.threadId, agentId: agent, url, reveal });
        pendingTabs.add(creating);
        try {
          const created = await creating;
          markUsed(agent, created);
          return status(agent, input.threadId, created);
        } finally {
          pendingTabs.delete(creating);
        }
      });
    },

    navigate: (agent: string, input: PreviewNavigateInput) =>
      act(agent, input, "navigate", async (tab) => {
        await navigate(
          tab,
          targetUrl(input),
          input.readiness ?? "load",
          input.timeoutMs ?? Ops.DEFAULT_TIMEOUT_MS,
        );
        return status(agent, input.threadId, tab);
      }),

    resize: (agent: string, input: PreviewResizeInput) =>
      act(agent, input, "resize", async (tab) => {
        await applySetting(tab, resolvePreviewViewport(input));
        return {
          tabId: tab.tabId,
          setting: tab.setting,
          viewport: tab.page.viewportSize() ?? DEFAULT_PREVIEW_VIEWPORT,
        };
      }),

    setAppearance: (agent: string, input: PreviewTarget & { colorScheme: PreviewAppearance }) =>
      act(agent, input, "setColorScheme", async (tab) => {
        await applyAppearance(tab, input.colorScheme);
        return { tabId: tab.tabId, colorScheme: tab.colorScheme };
      }),

    async snapshot(agent: string, input: PreviewSnapshotInput): Promise<PreviewSnapshot> {
      return act(
        agent,
        input,
        "snapshot",
        async (tab) => {
          const captured = await withCapture(tab, () =>
            Ops.snapshot({
              page: tab.page,
              cdp: tab.cdp,
              renderScale: RENDER_SCALE,
              consoleEntries: tab.consoleEntries,
              networkEntries: tab.networkEntries,
              actionTimeline: tab.actionTimeline,
            }),
          );
          let screenshotPath: string | undefined;
          if (input.save === true) {
            const folder = Path.join(options.dataDir, "screenshots");
            await Fs.mkdir(folder, { recursive: true });
            screenshotPath = Path.join(folder, `${Crypto.randomUUID()}.png`);
            await Fs.writeFile(screenshotPath, Buffer.from(captured.screenshot.data, "base64"));
          }
          if (input.save === true && input.includeImage !== true) {
            return { url: captured.url, screenshotPath: screenshotPath! };
          }
          const { screenshot, ...rest } = captured;
          return {
            ...rest,
            interactiveElements: [...rest.interactiveElements],
            consoleEntries: [...rest.consoleEntries],
            networkEntries: [...rest.networkEntries],
            actionTimeline: [...rest.actionTimeline],
            ...(input.includeImage === true
              ? { screenshot }
              : { screenshotSize: { width: screenshot.width, height: screenshot.height } }),
            ...(screenshotPath === undefined ? {} : { screenshotPath }),
          };
        },
        false,
      );
    },

    click: (agent: string, input: PreviewClickInput) =>
      act(agent, input, "click", (tab) => Ops.click(tab.page, input, pointer(tab))),
    type: (agent: string, input: PreviewTypeInput) =>
      act(agent, input, "type", (tab) => Ops.type(tab.page, input)),
    hover: (agent: string, input: PreviewHoverInput) =>
      act(agent, input, "hover", (tab) => Ops.hover(tab.page, input, pointer(tab))),
    select: (agent: string, input: PreviewSelectInput) =>
      act(agent, input, "select", async (tab) => ({
        selected: await Ops.select(tab.page, input),
      })),
    drag: (agent: string, input: PreviewDragInput) =>
      act(agent, input, "drag", (tab) => Ops.drag(tab.page, input, pointer(tab))),
    press: (agent: string, input: PreviewPressInput) =>
      act(agent, input, "press", (tab) => Ops.press(tab.page, input)),
    scroll: (agent: string, input: PreviewScrollInput) =>
      act(agent, input, "scroll", (tab) => Ops.scroll(tab.page, input)),
    evaluate: (agent: string, input: PreviewEvaluateInput) =>
      act(
        agent,
        input,
        "evaluate",
        async (tab) => ({ value: await Ops.evaluate(tab.cdp, input, Ops.DEFAULT_TIMEOUT_MS) }),
        false,
      ),
    waitFor: (agent: string, input: PreviewWaitForInput) =>
      act(agent, input, "waitFor", (tab) => Ops.waitFor(tab.page, input), false),

    upload: (agent: string, input: PreviewUploadInput) =>
      act(agent, input, "upload", async (tab) => {
        for (const path of input.paths) {
          if (!Path.isAbsolute(path)) {
            throw new PreviewError("PREVIEW_EXECUTION", `Upload paths must be absolute: ${path}`);
          }
        }
        if (await Ops.setInputFiles(tab.page, input)) return;
        const chooser = tab.fileChooser;
        if (chooser === null) {
          throw new PreviewError(
            "PREVIEW_EXECUTION",
            "No file picker is open. Click the page's upload control first, or pass the file input's locator.",
          );
        }
        if (!chooser.isMultiple() && input.paths.length > 1) {
          throw new PreviewError("PREVIEW_EXECUTION", "This file picker accepts one file.");
        }
        tab.fileChooser = null;
        changed(tab);
        await chooser.setFiles([...input.paths]);
      }),

    /** Answers a dialog outside the queue, so a click waiting on it can finish. */
    async dialog(agent: string, input: PreviewDialogInput): Promise<PreviewStatus> {
      return withErrors(async () => {
        const tab = resolveTab(agent, input, "dialog");
        if (!tab.control.agentMayAct(agent)) throw controlError("agentMismatch");
        if (tab.control.controller !== null) throw controlError("humanControl");
        await answerDialog(tab, input.accept, input.promptText);
        markUsed(agent, tab);
        return status(agent, input.threadId, tab);
      });
    },

    recordingStart: (agent: string, input: PreviewTarget) =>
      act(agent, input, "recordingStart", async (tab) => {
        const recording = await withCapture(tab, () => startRecording(tab));
        return { tabId: tab.tabId, recording: true, startedAt: recording.startedAt };
      }),

    async recordingStop(agent: string, input: PreviewTarget): Promise<PreviewRecordingArtifact> {
      return withErrors(async () => {
        let tab: Tab;
        try {
          tab = resolveTab(agent, input, "recordingStop");
        } catch (error) {
          if (error instanceof PreviewError && error.code === "PREVIEW_TAB_NOT_FOUND") {
            throw new PreviewError("PREVIEW_RECORDING", "No recording is active for this thread.");
          }
          throw error;
        }
        // Only a session that may act on the tab stops its recording, as one starts it.
        if (!tab.control.agentMayAct(agent)) throw controlError("agentMismatch");
        if (tab.control.controller !== null) throw controlError("humanControl");
        markUsed(agent, tab);
        return withCapture(tab, () => stopRecording(tab));
      });
    },

    list(threadId: string): PreviewTab[] {
      return threadTabs(threadId).map(summary);
    },

    /** An agent closes its own tab (T3's `t3_preview_close`). */
    async closeAsAgent(agent: string, input: { threadId: string; tabId: string }): Promise<void> {
      return withErrors(async () => {
        const tab = find(input.threadId, input.tabId);
        if (tab === undefined) throw notFound("close", input.tabId);
        if (tab.control.agentId !== null && tab.control.agentId !== agent) {
          throw controlError("agentMismatch");
        }
        if (tab.control.controller !== null) throw controlError("humanControl");
        await dropTab(tab);
      });
    },

    async close(threadId: string, tabId?: string): Promise<number> {
      const closing = threadTabs(threadId).filter(
        (tab) => tabId === undefined || tab.tabId === tabId,
      );
      await Promise.all(closing.map((tab) => dropTab(tab)));
      return closing.length;
    },

    // --- The panel's --------------------------------------------------------------

    async openForHuman(input: {
      threadId: string;
      url?: string | undefined;
      viewport?: PreviewViewportSetting | undefined;
      profileId?: string | undefined;
    }): Promise<PreviewTab> {
      return withErrors(async () => {
        if (tabs.size >= SERVER_TAB_LIMIT) throw controlError("tabLimit");
        const url = input.url === undefined ? undefined : targetUrl({ url: input.url });
        const creating = createTab({
          threadId: input.threadId,
          agentId: null,
          url,
          reveal: true,
          setting: input.viewport,
          profileId: input.profileId,
        });
        pendingTabs.add(creating);
        try {
          return summary(await creating);
        } finally {
          pendingTabs.delete(creating);
        }
      });
    },

    async adjust(input: PreviewTabAdjustInput): Promise<PreviewTab> {
      return withErrors(async () => {
        const tab = humanTab(input.threadId, input.tabId);
        await tab.control.system(async () => {
          if (input.viewport !== undefined) await applySetting(tab, input.viewport);
          if (input.colorScheme !== undefined) await applyAppearance(tab, input.colorScheme);
          if (input.zoomFactor !== undefined) {
            tab.zoomFactor = input.zoomFactor;
            const size = tab.page.viewportSize() ?? DEFAULT_PREVIEW_VIEWPORT;
            await tab.cdp.send("Emulation.setDeviceMetricsOverride", {
              width: size.width,
              height: size.height,
              deviceScaleFactor: RENDER_SCALE * input.zoomFactor,
              mobile: false,
            });
            changed(tab);
          }
          if (input.clear === "cookies") await tab.context.clearCookies();
          if (input.clear === "cache") await tab.cdp.send("Network.clearBrowserCache");
          if (input.hardReload === true) await tab.cdp.send("Page.reload", { ignoreCache: true });
        });
        return summary(tab);
      });
    },

    async control(input: { threadId: string; tabId: string; viewer: string; take: boolean }) {
      return withErrors(async () => {
        const tab = humanTab(input.threadId, input.tabId);
        if (input.take) await tab.control.take(input.viewer);
        else await tab.control.release(input.viewer, () => releaseInput(tab));
        return summary(tab);
      });
    },

    async navigateAsHuman(input: {
      threadId: string;
      tabId: string;
      viewer: string;
      url?: string | undefined;
      delta?: -1 | 1 | undefined;
      reload?: { ignoreCache?: boolean | undefined } | undefined;
    }): Promise<PreviewTab> {
      return withErrors(async () => {
        const tab = humanTab(input.threadId, input.tabId);
        await tab.control.human(input.viewer, async () => {
          if (input.url !== undefined) {
            await tab.page.goto(targetUrl({ url: input.url }), VIEWER_NAVIGATION);
          } else if (input.delta !== undefined) {
            await (input.delta < 0
              ? tab.page.goBack(VIEWER_NAVIGATION)
              : tab.page.goForward(VIEWER_NAVIGATION));
          } else if (input.reload?.ignoreCache === true) {
            await tab.cdp.send("Page.reload", { ignoreCache: true });
          } else {
            await tab.page.reload(VIEWER_NAVIGATION);
          }
        });
        return summary(tab);
      });
    },

    async dialogAsHuman(input: {
      threadId: string;
      tabId: string;
      viewer: string;
      accept: boolean;
      promptText?: string | undefined;
    }): Promise<PreviewTab> {
      return withErrors(async () => {
        const tab = humanTab(input.threadId, input.tabId);
        if (tab.control.controller !== input.viewer) {
          throw new PreviewError("PREVIEW_CONTROL", "Take control to respond.", {
            reason: "humanControl",
          });
        }
        await answerDialog(tab, input.accept, input.promptText);
        return summary(tab);
      });
    },

    /**
     * The files the viewer holding control chose for the page's open file picker, or none to
     * cancel it (T3's upload, D1203).
     */
    async uploadAsHuman(input: {
      threadId: string;
      tabId: string;
      viewer: string;
      files: readonly { name: string; mimeType?: string | undefined; data: string }[];
    }): Promise<PreviewTab> {
      return withErrors(async () => {
        const tab = humanTab(input.threadId, input.tabId);
        if (tab.control.controller !== input.viewer) {
          throw new PreviewError("PREVIEW_CONTROL", "Take control to choose files.", {
            reason: "humanControl",
          });
        }
        const chooser = tab.fileChooser;
        if (chooser === null) {
          throw new PreviewError("PREVIEW_EXECUTION", "The page's file picker is no longer open.");
        }
        if (!chooser.isMultiple() && input.files.length > 1) {
          throw new PreviewError("PREVIEW_EXECUTION", "This file picker accepts one file.");
        }
        // Taken at once, so a second upload meanwhile finds no picker; given back if the files
        // did not reach it, so the user can try again.
        tab.fileChooser = null;
        changed(tab);
        try {
          await chooser.setFiles(
            input.files.map((file) => ({
              name: file.name,
              mimeType: file.mimeType || "application/octet-stream",
              buffer: Buffer.from(file.data, "base64"),
            })),
          );
        } catch (error) {
          if (tab.fileChooser === null && !tab.page.isClosed()) {
            tab.fileChooser = chooser;
            changed(tab);
          }
          throw error;
        }
        // The page may retitle itself on the files, as after a viewer's click.
        void refreshTitle(tab).catch(() => undefined);
        return summary(tab);
      });
    },

    /** Whether the viewer holding control tapped something editable (T3's probe, D1203). */
    async probe(input: {
      threadId: string;
      tabId: string;
      viewer: string;
      x: number;
      y: number;
    }): Promise<{ x: number; y: number; editable: boolean }> {
      return withErrors(async () => {
        const tab = humanTab(input.threadId, input.tabId);
        if (tab.control.controller !== input.viewer) {
          throw new PreviewError("PREVIEW_CONTROL", "Take control to use the page.", {
            reason: "humanControl",
          });
        }
        const editable = await tab.page.evaluate(
          `(${EDITABLE_AT_POINT_SCRIPT})(${input.x}, ${input.y})`,
        );
        return { x: input.x, y: input.y, editable: editable === true };
      });
    },

    /** A viewer's input; a `resize` needs no control (the panel's size), the rest does. */
    async input(input: {
      threadId: string;
      tabId: string;
      viewer: string;
      events: readonly PreviewInputEvent[];
    }): Promise<void> {
      return withErrors(async () => {
        const tab = humanTab(input.threadId, input.tabId);
        for (const event of input.events) {
          if (event.type === "resize") {
            tab.fillSize = { width: event.width, height: event.height };
            tab.frameScale = event.scale ?? tab.frameScale;
            if (tab.setting.mode === "fill") {
              await tab.control.system(async () => {
                const size = tab.page.viewportSize();
                if (size?.width !== event.width || size.height !== event.height) {
                  await tab.page.setViewportSize(tab.fillSize);
                }
              });
              changed(tab);
            }
            void syncScreencast(tab);
            continue;
          }
          await tab.control.human(input.viewer, () => dispatch(tab, event));
        }
        // Pointer moves and wheels change no title: only clicks, keys and text are looked after.
        if (
          input.events.some(
            (event) =>
              event.type === "key" ||
              event.type === "text" ||
              (event.type === "mouse" && event.action === "up"),
          )
        ) {
          void refreshTitle(tab).catch(() => undefined);
        }
      });
    },

    async dispose(): Promise<void> {
      disposed = true;
      clearInterval(sweeper);
      await Promise.allSettled(pendingTabs);
      await Promise.all([...tabs.values()].map((tab) => dropTab(tab)));
      await chromium.close();
    },
  };

  async function answerDialog(tab: Tab, accept: boolean, promptText: string | undefined) {
    const dialog = tab.dialog;
    if (dialog === null) throw new PreviewError("PREVIEW_EXECUTION", "No dialog is pending.");
    tab.dialog = null;
    Ops.invalidateRefs(tab.page);
    changed(tab);
    await (accept ? dialog.accept(promptText) : dialog.dismiss());
  }

  async function dispatch(tab: Tab, event: Exclude<PreviewInputEvent, { type: "resize" }>) {
    const modifiers = modifiersOf("modifiers" in event ? event.modifiers : undefined);
    switch (event.type) {
      case "mouse": {
        const type =
          event.action === "down"
            ? "mousePressed"
            : event.action === "up"
              ? "mouseReleased"
              : "mouseMoved";
        await tab.cdp.send("Input.dispatchMouseEvent", {
          type,
          x: event.x,
          y: event.y,
          button: event.button ?? "none",
          buttons: event.buttons ?? 0,
          clickCount: event.clickCount ?? (type === "mouseMoved" ? 0 : 1),
          modifiers,
        });
        return;
      }
      case "wheel":
        await tab.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: event.x,
          y: event.y,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          modifiers,
        });
        return;
      case "key": {
        if (event.action === "up") {
          await tab.cdp.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: event.key,
            code: event.code,
            modifiers,
          });
          return;
        }
        const command = editingCommand(event.key, modifiers);
        await tab.cdp.send("Input.dispatchKeyEvent", {
          type: event.text ? "keyDown" : "rawKeyDown",
          key: event.key,
          code: event.code,
          modifiers,
          ...(event.text ? { text: event.text, unmodifiedText: event.text } : {}),
          ...command,
          windowsVirtualKeyCode:
            event.keyCode || (event.key.length === 1 ? event.key.toUpperCase().charCodeAt(0) : 0),
        });
        return;
      }
      case "text":
        await tab.cdp.send("Input.insertText", { text: event.text });
        return;
    }
  }
}
