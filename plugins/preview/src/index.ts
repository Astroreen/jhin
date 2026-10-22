// The tools' descriptions follow T3 Code (MIT, see THIRD_PARTY_NOTICES.md):
// apps/server/src/mcp/toolkits/preview/tools.ts and previewControls/tools.ts.
import * as Os from "node:os";
import * as Path from "node:path";

import { THREADS_STREAM, ThreadEvents } from "@jhin/agent-api";
import { HOST_PATHS_CAPABILITY, type HostPaths } from "@jhin/host-api";
import { TERMINAL_SESSIONS_CAPABILITY, type TerminalSessions } from "@jhin/terminal-api";
import {
  PREVIEW_BROWSER_CAPABILITY,
  PREVIEW_STREAM_PREFIX,
  PreviewClickInput,
  PreviewCloseInput,
  PreviewDialogInput,
  PreviewDragInput,
  PreviewEvaluateInput,
  PreviewError,
  PreviewEvaluateResult,
  PreviewHoverInput,
  PreviewListInput,
  PreviewListResult,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewPressInput,
  PreviewRecordingArtifact,
  PreviewRecordingStatus,
  PreviewResizeInput,
  PreviewResizeResult,
  PreviewScrollInput,
  PreviewSelectInput,
  PreviewSelectResult,
  PreviewSetAppearanceInput,
  PreviewSetAppearanceResult,
  PreviewSnapshot,
  PreviewSnapshotInput,
  PreviewStatus,
  PreviewTab,
  PreviewTabAdjustInput,
  PreviewTabCloseInput,
  PreviewTabControlInput,
  PreviewTabDialogInput,
  PreviewTabInputInput,
  PreviewTabNavigateInput,
  PreviewProfileClearInput,
  PreviewImportCookiesInput,
  PreviewImportCookiesResult,
  PreviewImportSourcesResult,
  INCOGNITO_BROWSER_PROFILE_ID,
  PreviewTabOpenInput,
  PreviewTarget,
  PreviewTypeInput,
  PreviewUploadInput,
  PreviewWaitForInput,
  type PreviewBrowser,
} from "@jhin/preview-api";
import {
  LIVE_STREAMS_CAPABILITY,
  createMemoryStreams,
  type LiveStreams,
  type StreamSource,
} from "@jhin/rpc";
import { definePlugin, toDisposable, z, type Invocation, describePermissions } from "@jhin/sdk";
import { EVENTLOG_CAPABILITY, type EventLog } from "@jhin/storage-api";

import {
  createBrowserImport,
  importFailed,
  writeCookies,
} from "./browser-import/browser-import.ts";
import { Chromium } from "./chromium.ts";
import { createTabs, sessionKey } from "./tabs.ts";
import { createLocalServerScanner, DiscoveredLocalServer, nodeScanHost } from "./local-servers.ts";
import { createHeadlessShell, headlessShellRelease } from "./headless-shell.ts";

/** How long one local server scan answers every panel (D950). */
const SCAN_REUSE_MS = 2_000;

const CONFIG_SECTION = "jhin.preview";

const Config = z
  .object({
    executablePath: z
      .string()
      .min(1)
      .optional()
      .meta({
        title: "Browser",
        description:
          "The Chromium the preview runs; the one `npx playwright install chromium` installs when unset.",
        examples: ["/usr/bin/chromium"],
      }),
  })
  .meta({
    title: "Browser preview",
    description: "The browser on this node that agents and you drive in the right panel.",
  });
type Config = z.output<typeof Config>;

const Done = z.object({});

export default definePlugin({
  activate(context) {
    context.config.define(CONFIG_SECTION, Config);
    const live = context.services.tryGet<LiveStreams>(LIVE_STREAMS_CAPABILITY);
    const log = context.services.tryGet<EventLog>(EVENTLOG_CAPABILITY);
    const paths = context.services.tryGet<HostPaths>(HOST_PATHS_CAPABILITY);
    const streams = createMemoryStreams({ log: context.log });
    // Kept in Jhin's home, shared by every plugin of the node (T3: `<home>/tools`); a
    // plugin run without a home (tests) never installs one into a shared temp folder.
    const headlessShell =
      paths === undefined
        ? undefined
        : createHeadlessShell({
            root: Path.join(paths.home, "tools", "chrome-headless-shell"),
            release: headlessShellRelease(process.platform, process.arch),
          });
    if (headlessShell !== undefined) {
      context.subscriptions.add({ dispose: () => headlessShell.dispose() });
    }
    const chromium = new Chromium({
      executablePath: () => context.config.get<Config>(CONFIG_SECTION).executablePath,
      headlessShell,
      // T3's persistent profiles, kept with the plugin's data (D952).
      profilesDir: Path.join(
        paths?.dataDir(context.plugin.id) ?? Path.join(Os.tmpdir(), "jhin-preview"),
        "profiles",
      ),
    });
    const tabs = createTabs({
      chromium,
      streams,
      dataDir: paths?.dataDir(context.plugin.id) ?? Path.join(Os.tmpdir(), "jhin-preview"),
      log: context.log,
    });
    const browser: PreviewBrowser = {
      instance: tabs.instance,
      tabs: (threadId) => tabs.tabs(threadId),
      close: (threadId, tabId) => tabs.close(threadId, tabId),
    };
    context.services.provide(PREVIEW_BROWSER_CAPABILITY, browser);
    // Tabs end with the plugin, and the browser with them.
    context.onDeactivate(() => tabs.dispose());

    if (live === undefined) {
      context.log.warn("no rpc.streams@1: clients see no tabs or frames, only preview.list");
    } else {
      // A subscriber of a tab's frames is a viewer: the screencast runs while one watches (D401).
      const watched: StreamSource = {
        head: (stream) => streams.head(stream),
        read: (stream, options) => streams.read(stream, options),
        subscribe(stream, listener) {
          const subscription = streams.subscribe(stream, listener);
          const parts = stream.slice(PREVIEW_STREAM_PREFIX.length).split("/");
          if (parts.length !== 2) return subscription;
          const [threadId, tabId] = parts as [string, string];
          tabs.watch(threadId, tabId, 1);
          let watching = true;
          return toDisposable(() => {
            subscription.dispose();
            if (!watching) return;
            watching = false;
            tabs.watch(threadId, tabId, -1);
          });
        },
      };
      context.subscriptions.add(
        live.serve(PREVIEW_STREAM_PREFIX, watched, { permissions: ["preview.read"] }),
      );
    }

    // A deleted thread takes its tabs with it.
    if (log !== undefined) {
      context.subscriptions.add(
        log.subscribe(THREADS_STREAM, (event) => {
          if (event.type !== ThreadEvents.threadDeleted) return;
          const threadId = (event.payload as { id?: unknown } | null)?.id;
          if (typeof threadId !== "string") return;
          void tabs.close(threadId).catch((error: unknown) =>
            context.log.warn("tabs of a deleted thread not closed", {
              threadId,
              error: String(error),
            }),
          );
        }),
      );
    }

    const read = ["preview.read"];
    const write = ["preview.write"];
    // The panel's commands act as a human viewer: agents' tokens do not hold this (D393).
    const control = ["preview.control"];
    const agent = (input: PreviewTarget, invocation: Invocation) => sessionKey(input, invocation);

    // --- The agent's tools (T3's preview_* and t3_preview_*) --------------------------
    // The titles of this plugin's permissions (security.md D961).
    describePermissions(context, {
      "preview.read": {
        title: "View previews",
        description: "Read browser preview tabs and their frames.",
      },
      "preview.write": {
        title: "Control previews",
        description: "Open browser previews and host browser automation.",
      },
      "preview.import": {
        title: "Import browser cookies",
        description:
          "Read the cookies of the browsers installed on this node's machine into a browser profile.",
      },
    });
    // T3's discovered local servers (D950): what terminals of this node serve.
    const scanner = createLocalServerScanner(nodeScanHost);
    /**
     * The scan running or just done, shared by the panels that ask meanwhile. Only a
     * cache: lost on a reload, it is not kept in kernel state (rule 5).
     */
    let lastScan:
      | {
          finishedAt?: number;
          readonly result: Promise<{ servers: DiscoveredLocalServer[]; scannedAt: string }>;
        }
      | undefined;
    context.commands.register({
      name: "preview.servers.list",
      title: "List local servers",
      description:
        "Lists the browser-ready servers on this node that its terminals started (a process of a terminal listens on a local port and answers HTTP or HTTPS with a page), by port, with the terminal each runs in",
      input: z.object({}),
      output: z.object({ servers: z.array(DiscoveredLocalServer), scannedAt: z.string() }),
      // It tells which threads' terminals run what: reading terminals is asked for too.
      permissions: [...read, "terminals.read"],
      // Every open panel asks every 3 s: one scan serves them all for a while (T3 scans once per tick).
      handler: () => {
        // A scan still running is shared however long it takes; a finished one for 2 s.
        if (
          lastScan !== undefined &&
          (lastScan.finishedAt === undefined || Date.now() - lastScan.finishedAt < SCAN_REUSE_MS)
        ) {
          return lastScan.result;
        }
        const terminals = context.services.tryGet<TerminalSessions>(TERMINAL_SESSIONS_CAPABILITY);
        const owners = new Map<number, { threadId: string; terminalId: string }>();
        for (const terminal of terminals?.list() ?? []) {
          for (const pid of terminals?.processIds?.(terminal.threadId, terminal.terminalId) ?? []) {
            owners.set(pid, { threadId: terminal.threadId, terminalId: terminal.terminalId });
          }
        }
        const result = scanner
          .scan(owners)
          .then((servers) => ({ servers, scannedAt: new Date().toISOString() }));
        const scan: { finishedAt?: number; result: typeof result } = { result };
        lastScan = scan;
        void result.then(
          () => (scan.finishedAt = Date.now()),
          () => undefined,
        );
        // A failed scan is not reused.
        result.catch(() => {
          if (lastScan?.result === result) lastScan = undefined;
        });
        return result;
      },
    });
    context.commands.register({
      name: "preview.status",
      title: "Get preview status",
      description:
        "Report whether a collaborative browser tab is automation-capable, including its control owner, pending dialog, URL, title, visibility, loading state, viewport mode, and measured CSS-pixel size. Pass tabId to inspect a specific tab; omit it to use this agent session's current tab, or the tab the user is viewing when you have none. Also lists every tab in the thread (tabs) with its owner, including tabs the user opened. You can read any listed tab; act only on your own tabs, or on an unclaimed tab while no human controls it.",
      input: PreviewTarget,
      output: PreviewStatus,
      permissions: read,
      handler: (input, invocation) => tabs.status(agent(input, invocation), input),
    });
    context.commands.register({
      name: "preview.open",
      title: "Open browser preview",
      description:
        "Initialize a collaborative browser tab and open its thread-bound inline preview by default. Set open=false for background-only automation. Pass tabId to reuse a specific existing tab, set reuseExistingTab=false to create another tab, or omit both to use this agent session's current tab. Parallel subagents sharing a session must each open with reuseExistingTab=false and pass their returned tabId on every call. Another agent session's tabs can be read but not operated.",
      input: PreviewOpenInput,
      output: PreviewStatus,
      permissions: write,
      handler: (input, invocation) => tabs.open(agent(input, invocation), input),
    });
    context.commands.register({
      name: "preview.dialog",
      title: "Resolve browser dialog",
      description:
        "Accept or dismiss the browser dialog reported by preview_status. For a prompt, supply promptText when accepting. Requires this agent to own the tab, or the tab to be unclaimed with no human in control.",
      input: PreviewDialogInput,
      output: PreviewStatus,
      permissions: write,
      handler: (input, invocation) => tabs.dialog(agent(input, invocation), input),
    });
    context.commands.register({
      name: "preview.navigate",
      title: "Navigate browser preview",
      description:
        "Navigate a collaborative browser tab. Pass tabId to target a specific tab, plus {url:'https://example.com'} for a website or {target:{kind:'environment-port',port:5173}} for a dev server. Exactly one of url or target is required.",
      input: PreviewNavigateInput,
      output: PreviewStatus,
      permissions: write,
      handler: (input, invocation) => tabs.navigate(agent(input, invocation), input),
    });
    context.commands.register({
      name: "preview.resize",
      title: "Resize browser viewport",
      description:
        "Resize a collaborative browser tab, optionally selected by tabId. Use {mode:'fill'}, {mode:'freeform',width:1024,height:768}, or {mode:'preset',preset:'iphone-12-pro',orientation:'portrait'}. This changes CSS layout breakpoints without changing the desktop browser user agent.",
      input: PreviewResizeInput,
      output: PreviewResizeResult,
      permissions: write,
      handler: (input, invocation) => tabs.resize(agent(input, invocation), input),
    });
    context.commands.register({
      name: "preview.set.appearance",
      title: "Set preview appearance",
      description:
        "Emulate prefers-color-scheme in a collaborative browser tab, optionally selected by tabId. Use {colorScheme:'dark'} or {colorScheme:'light'} to preview the page in that appearance, and {colorScheme:'system'} to clear the override and follow the OS appearance.",
      input: PreviewSetAppearanceInput,
      output: PreviewSetAppearanceResult,
      permissions: write,
      handler: (input, invocation) => tabs.setAppearance(agent(input, invocation), input),
    });
    context.commands.register({
      name: "preview.snapshot",
      title: "Inspect browser page",
      description:
        "Inspect a page before interacting. Pass tabId to inspect a specific tab, including one the user opened (see preview_status tabs), even while they control it; omit it to use this agent session's current tab, or the tab the user is viewing when you have none. Returns page state, an accessibilityTree with refs, diagnostics, action history, and screenshot dimensions. Pass locator=aria-ref=<ref> to target one exact element, including inside frames. Refresh refs after navigation, another snapshot, or human takeover. The text is capped near 20 KB; use preview_evaluate to read more. Set includeImage=true only when you need to see the page. Set save=true to write the PNG to disk and get back only the url and screenshotPath; embed that path in your reply as ![alt](screenshotPath) so the user sees it.",
      input: PreviewSnapshotInput,
      output: PreviewSnapshot,
      permissions: read,
      handler: (input, invocation) => tabs.snapshot(agent(input, invocation), input),
    });
    context.commands.register({
      name: "preview.click",
      title: "Click preview page",
      description:
        "Click exactly one target in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; selector accepts legacy CSS; x and y must be supplied together. Set button=right for a context menu or clickCount=2 for a double-click.",
      input: PreviewClickInput,
      output: Done,
      permissions: write,
      handler: async (input, invocation) => {
        await tabs.click(agent(input, invocation), input);
        return {};
      },
    });
    context.commands.register({
      name: "preview.type",
      title: "Type into preview page",
      description:
        "Insert literal text into one input in the tab selected by tabId, or this agent session's current tab when omitted. Prefer a Playwright locator; set clear=true to replace existing text.",
      input: PreviewTypeInput,
      output: Done,
      permissions: write,
      handler: async (input, invocation) => {
        await tabs.type(agent(input, invocation), input);
        return {};
      },
    });
    context.commands.register({
      name: "preview.hover",
      title: "Hover preview page",
      description:
        "Move the mouse over exactly one target in the tab selected by tabId, or this agent session's current tab when omitted, to reveal hover menus and tooltips.",
      input: PreviewHoverInput,
      output: Done,
      permissions: write,
      handler: async (input, invocation) => {
        await tabs.hover(agent(input, invocation), input);
        return {};
      },
    });
    context.commands.register({
      name: "preview.select",
      title: "Select preview option",
      description:
        "Choose options in one native <select> in the tab selected by tabId, or this agent session's current tab when omitted, by option value or visible label. Custom dropdowns are not <select>; click them open and click the option instead.",
      input: PreviewSelectInput,
      output: PreviewSelectResult,
      permissions: write,
      handler: (input, invocation) => tabs.select(agent(input, invocation), input),
    });
    context.commands.register({
      name: "preview.drag",
      title: "Drag in preview page",
      description:
        "Drag one element onto another in the tab selected by tabId, or this agent session's current tab when omitted.",
      input: PreviewDragInput,
      output: Done,
      permissions: write,
      handler: async (input, invocation) => {
        await tabs.drag(agent(input, invocation), input);
        return {};
      },
    });
    context.commands.register({
      name: "preview.upload",
      title: "Upload files to preview page",
      description:
        "Give files on the node to the page in the tab selected by tabId, or this agent session's current tab when omitted. After clicking an upload control, preview_status reports the open fileChooser; call this with absolute paths to answer it, or with an empty list to cancel. Pass a locator for an <input type=file> to set its files without a picker.",
      input: PreviewUploadInput,
      output: Done,
      permissions: write,
      handler: async (input, invocation) => {
        await tabs.upload(agent(input, invocation), input);
        return {};
      },
    });
    context.commands.register({
      name: "preview.press",
      title: "Press key in preview page",
      description:
        "Press one keyboard key in the tab selected by tabId, or this agent session's current tab when omitted. Examples: {key:'Enter'}, {key:'Escape'}, or {key:'a',modifiers:['Meta']}.",
      input: PreviewPressInput,
      output: Done,
      permissions: write,
      handler: async (input, invocation) => {
        await tabs.press(agent(input, invocation), input);
        return {};
      },
    });
    context.commands.register({
      name: "preview.scroll",
      title: "Scroll preview page",
      description:
        "Scroll the tab selected by tabId, or this agent session's current tab when omitted. Positive deltaY scrolls down and positive deltaX scrolls right; a locator/selector targets a container.",
      input: PreviewScrollInput,
      output: Done,
      permissions: write,
      handler: async (input, invocation) => {
        await tabs.scroll(agent(input, invocation), input);
        return {};
      },
    });
    context.commands.register({
      name: "preview.evaluate",
      title: "Evaluate JavaScript in preview",
      description:
        "Evaluate JavaScript in the tab selected by tabId, or this agent session's current tab when omitted. Needs the same control as clicking: it works on your own tabs and on the user's tab only while nobody controls it. To read a tab the user is driving, use preview_snapshot. Returns {value} with a serializable result up to 64 KB; the expression may mutate page state.",
      input: PreviewEvaluateInput,
      output: PreviewEvaluateResult,
      permissions: write,
      handler: (input, invocation) => tabs.evaluate(agent(input, invocation), input),
    });
    context.commands.register({
      name: "preview.wait.for",
      title: "Wait for preview page condition",
      description:
        "Wait in the tab selected by tabId, or this agent session's current tab when omitted, until all supplied locator, selector, text, and URL conditions match.",
      input: PreviewWaitForInput,
      output: Done,
      permissions: read,
      handler: async (input, invocation) => {
        await tabs.waitFor(agent(input, invocation), input);
        return {};
      },
    });
    context.commands.register({
      name: "preview.recording.start",
      title: "Start browser recording",
      description:
        "Start recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted.",
      input: PreviewTarget,
      output: PreviewRecordingStatus,
      permissions: write,
      handler: (input, invocation) => tabs.recordingStart(agent(input, invocation), input),
    });
    context.commands.register({
      name: "preview.recording.stop",
      title: "Stop browser recording",
      description:
        "Stop recording the collaborative browser tab selected by tabId, or this agent session's current tab when omitted, and write the compressed recording (up to 50 MiB) to a file on the node. Returns its path.",
      input: PreviewTarget,
      output: PreviewRecordingArtifact,
      permissions: write,
      handler: (input, invocation) => tabs.recordingStop(agent(input, invocation), input),
    });
    context.commands.register({
      name: "preview.list",
      title: "List preview tabs",
      description:
        "List this thread's preview tabs. Pages reflect the current server state and may shift as tabs change.",
      input: PreviewListInput,
      output: PreviewListResult,
      permissions: read,
      handler: (input) => {
        const all = tabs.list(input.threadId);
        const start = input.cursor ?? 0;
        const end = start + (input.limit ?? 50);
        return { tabs: all.slice(start, end), nextCursor: end < all.length ? end : null };
      },
    });
    context.commands.register({
      name: "preview.close",
      title: "Close preview tab",
      description: "Close one preview tab owned by this agent session, or an unclaimed one.",
      input: PreviewCloseInput,
      output: Done,
      permissions: write,
      handler: async (input, invocation) => {
        await tabs.closeAsAgent(sessionKey(input, invocation), input);
        return {};
      },
    });

    // --- The panel's (T3's preview RPC and stream messages, D402) ----------------------
    context.commands.register({
      name: "preview.profile.clear",
      title: "Clear browser profile",
      description:
        "Forgets a browser profile's cookies, logins and storage on this node (T3's Clear profile); its open tabs close. Incognito keeps nothing to clear",
      input: PreviewProfileClearInput,
      output: Done,
      permissions: control,
      handler: async ({ profileId }) => {
        await chromium.clearProfile(profileId);
        return {};
      },
    });
    // T3's "Import from" (D1204): the node machine's browsers, read into a profile.
    // Reading them hands over the machine user's sessions, so it takes the panel's
    // `preview.control` and `preview.import` besides: the owner's `*` holds both, a
    // device token only when it is granted `preview.import` (or `preview.*`).
    const importing = [...control, "preview.import"];
    const browserImport = createBrowserImport();
    context.commands.register({
      name: "preview.import.sources",
      title: "List browsers to import from",
      description:
        "Lists the browsers installed on this node's machine that cookies can be imported from (T3's Import from), with their profiles and cookie counts, or why one cannot be read now",
      input: z.object({}),
      output: PreviewImportSourcesResult,
      permissions: importing,
      handler: async () => ({ sources: await browserImport.listSources() }),
    });
    context.commands.register({
      name: "preview.import.cookies",
      title: "Import browser cookies",
      description:
        "Imports the cookies of a browser profile on this node's machine into a browser profile of this node (T3's Import from); its open tabs see them at once. Fails with PREVIEW_IMPORT_FAILED and details.reason",
      input: PreviewImportCookiesInput,
      output: PreviewImportCookiesResult,
      permissions: importing,
      handler: async (input) => {
        // Incognito keeps nothing past its browser: T3 imports only into kept profiles.
        if (input.targetProfileId === INCOGNITO_BROWSER_PROFILE_ID) {
          throw importFailed(input.sourceId, "sessionUnavailable");
        }
        const cookies = await browserImport.readCookies(input);
        try {
          return await chromium.withProfile(input.targetProfileId, (profile) =>
            writeCookies(profile, cookies),
          );
        } catch (cause) {
          // The profile did not start, or closed while it was written.
          if (cause instanceof PreviewError && cause.code === "PREVIEW_IMPORT_FAILED") throw cause;
          throw importFailed(input.sourceId, "sessionUnavailable", cause);
        }
      },
    });
    context.commands.register({
      name: "preview.tab.open",
      title: "Open a browser tab",
      description: "Opens a tab for the user in a thread's browser, optionally at a URL.",
      input: PreviewTabOpenInput,
      output: PreviewTab,
      permissions: control,
      handler: (input) => tabs.openForHuman(input),
    });
    context.commands.register({
      name: "preview.tab.close",
      title: "Close a browser tab",
      description: "Closes a tab of a thread's browser, whoever owns it.",
      input: PreviewTabCloseInput,
      output: z.object({ closed: z.number().int() }),
      permissions: control,
      handler: async (input) => ({ closed: await tabs.close(input.threadId, input.tabId) }),
    });
    context.commands.register({
      name: "preview.tab.adjust",
      title: "Adjust a browser tab",
      description:
        "Changes a tab's viewport, appearance or zoom, reloads it ignoring the cache, or clears cookies or the cache; needs no control of the tab.",
      input: PreviewTabAdjustInput,
      output: PreviewTab,
      permissions: control,
      handler: (input) => tabs.adjust(input),
    });
    context.commands.register({
      name: "preview.tab.control",
      title: "Take or release control of a browser tab",
      description:
        "A viewer takes control of a tab (from an agent too) or releases it; while it holds control, its input and navigation reach the page.",
      input: PreviewTabControlInput,
      output: PreviewTab,
      permissions: control,
      handler: (input) => tabs.control(input),
    });
    context.commands.register({
      name: "preview.tab.navigate",
      title: "Navigate a browser tab",
      description: "Goes to a URL, back, forward or reloads, for the viewer holding control.",
      input: PreviewTabNavigateInput,
      output: PreviewTab,
      permissions: control,
      handler: (input) => tabs.navigateAsHuman(input),
    });
    context.commands.register({
      name: "preview.tab.dialog",
      title: "Answer a browser dialog",
      description: "Accepts or dismisses a tab's dialog, for the viewer holding control.",
      input: PreviewTabDialogInput,
      output: PreviewTab,
      permissions: control,
      handler: (input) => tabs.dialogAsHuman(input),
    });
    context.commands.register({
      name: "preview.tab.input",
      title: "Send input to a browser tab",
      description:
        "Mouse, wheel, key and text input of the viewer holding control, in page CSS pixels; a resize (the panel's size) needs no control.",
      input: PreviewTabInputInput,
      output: Done,
      permissions: control,
      handler: async (input) => {
        await tabs.input(input);
        return {};
      },
    });
  },
});
