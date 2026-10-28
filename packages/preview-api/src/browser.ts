// The browser's tools, their inputs, results and errors follow T3 Code (MIT, see
// THIRD_PARTY_NOTICES.md): packages/contracts/src/previewAutomation.ts, packages/contracts/src/preview.ts
// and apps/server/src/mcp/toolkits/preview/tools.ts.
import { z } from "@jhin/sdk";

import { PREVIEW_URL_MAX_LENGTH } from "./url.ts";
import {
  PREVIEW_VIEWPORT_MAX_AREA,
  PreviewAppearance,
  PreviewRenderedViewportSize,
  PreviewViewportPresetId,
  PreviewViewportSetting,
  PreviewZoomFactor,
} from "./viewport.ts";

/** `preview.browser@1`: the node's browser tabs (docs/plans/preview.md, D394). */
export const PREVIEW_BROWSER_CAPABILITY = "preview.browser";

/** A thread's tabs: one `preview.tabs` event after every change. */
export const PREVIEW_STREAM_PREFIX = "preview/";
export const previewTabsStream = (threadId: string): string =>
  `${PREVIEW_STREAM_PREFIX}${threadId}`;
/** One tab's picture: its newest frame and the agent's pointer. */
export const previewFramesStream = (threadId: string, tabId: string): string =>
  `${PREVIEW_STREAM_PREFIX}${threadId}/${tabId}`;

/**
 * The desktop app's own node announces the tabs its webviews host here, while
 * the app's page subscribes (docs/plans/desktop.md, D1321).
 */
export const PREVIEW_DESKTOP_STREAM = "preview-desktop";

/**
 * The node's local servers, pushed while somebody watches (docs/plans/preview.md, D1692):
 * one `preview.servers` event after every change, for the configured URLs the name carries.
 */
export const PREVIEW_SERVERS_STREAM_PREFIX = "preview-servers/";

/** The stream of the servers a panel shows for these configured URLs (D1480), in any order. */
export const previewServersStream = (configuredUrls: readonly string[] = []): string =>
  `${PREVIEW_SERVERS_STREAM_PREFIX}${encodeURIComponent(JSON.stringify([...new Set(configuredUrls)].toSorted()))}`;

/** The configured URLs a servers stream carries; undefined for a name that is not one. */
export function previewServersStreamUrls(stream: string): string[] | undefined {
  if (!stream.startsWith(PREVIEW_SERVERS_STREAM_PREFIX)) return undefined;
  try {
    const urls: unknown = JSON.parse(
      decodeURIComponent(stream.slice(PREVIEW_SERVERS_STREAM_PREFIX.length)),
    );
    return Array.isArray(urls) &&
      urls.length <= 50 &&
      urls.every((url) => typeof url === "string" && url.length <= 2048)
      ? (urls as string[])
      : undefined;
  } catch {
    return undefined;
  }
}

export const PreviewEvents = {
  /** `{ tabs }`: every tab of the thread after a change. */
  tabs: "preview.tabs",
  /** `{ data, width, height }`: a JPEG of the viewport (base64) and its size in CSS pixels. */
  frame: "preview.frame",
  /** `{ phase, x, y }`: where the agent points before it acts, in CSS pixels. */
  pointer: "preview.pointer",
  /** `{ id, fileName, sizeBytes }`: the page downloaded a file the user may save (D1331). */
  download: "preview.download",
  /** `{ tabs }`: every tab the desktop app hosts or should host (`PreviewDesktopTab`, D1321). */
  desktopTabs: "preview.desktop.tabs",
  /** `{ servers, scannedAt }`: the node's local servers after a change (D1692). */
  servers: "preview.servers",
} as const;

/** Error codes of the browser commands, one per error tag of T3's. */
export type PreviewErrorCode =
  | "PREVIEW_TAB_NOT_FOUND"
  /** `details.reason`: why the caller may not act (`PreviewControlReason`). */
  | "PREVIEW_CONTROL"
  | "PREVIEW_TIMEOUT"
  /** `details.staleRef`: the ref was revoked. */
  | "PREVIEW_INVALID_SELECTOR"
  | "PREVIEW_NOT_EDITABLE"
  | "PREVIEW_RESULT_TOO_LARGE"
  | "PREVIEW_EXECUTION"
  | "PREVIEW_INVALID_URL"
  /** The node has no browser to run, or it did not start. */
  | "PREVIEW_UNAVAILABLE"
  | "PREVIEW_RECORDING"
  /** `details.reason`: why a cookie import stopped (`BrowserImportFailureReason`, D1204). */
  | "PREVIEW_IMPORT_FAILED"
  /** A desktop tab waits for the app's webview again (desktop.md D1488). */
  | "PREVIEW_TAB_RECONNECTING";

export const PreviewControlReason = z.enum([
  "agentMismatch",
  "humanControl",
  "tabRequired",
  "closed",
  "interrupted",
  "dialogPending",
  "tabLimit",
]);
export type PreviewControlReason = z.infer<typeof PreviewControlReason>;

/** What T3's broker tells the agent for each reason. */
export const PREVIEW_CONTROL_MESSAGES: Record<PreviewControlReason, string> = {
  agentMismatch: "This browser tab belongs to another agent session or a human. Open your own tab.",
  humanControl: "A human controls this browser tab. Wait until they release control.",
  tabRequired:
    "Multiple browser tabs belong to this session. Pass a tabId from preview_open or from the tabs listed by preview_status.",
  dialogPending:
    "A browser dialog is pending. Read preview_status and resolve it with preview_dialog.",
  tabLimit:
    "Too many server browser tabs are open (8 per agent session, 32 per server). Close one with preview_close or reuse one from preview_status tabs.",
  closed: "This browser tab is closed. Call preview_open.",
  interrupted: "Browser control changed. Take a fresh snapshot before trying again.",
};

export class PreviewError extends Error {
  readonly code: PreviewErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: PreviewErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "PreviewError";
    this.code = code;
    this.details = details;
  }
}

export const PreviewThreadId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "letters, digits, . _ : -");
export const PreviewTabId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "letters, digits, . _ : -");
/** A panel that watches tabs, named by the client. */
export const PreviewViewerId = z.string().min(1).max(128);

const BoundedUrl = z.string().trim().min(1).max(PREVIEW_URL_MAX_LENGTH);
const URL_GUIDANCE =
  "Absolute http(s) URL or a schemeless host such as example.com or localhost:5173. Schemeless public hosts use https; loopback hosts use http.";
const TimeoutMs = z
  .number()
  .int()
  .positive()
  .max(60_000)
  .describe("Maximum wait in milliseconds. Defaults to 15000; maximum 60000.");

const TargetFields = {
  threadId: PreviewThreadId.describe("The thread whose browser tabs to use."),
  tabId: PreviewTabId.optional().describe(
    "Exact collaborative browser tab to target, including a tab the user opened (see preview_status tabs). Omit to use this agent session's current tab, or the user's visible tab when this session has none.",
  ),
  session: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "This agent session within the thread, when several agents share it: subagents each pass their own.",
    ),
};
export const PreviewTarget = z.object(TargetFields);
export type PreviewTarget = z.infer<typeof PreviewTarget>;

export const PreviewTabOwner = z.enum(["agent", "human", "unclaimed"]);
export type PreviewTabOwner = z.infer<typeof PreviewTabOwner>;

export const PreviewDialog = z.object({
  type: z.string(),
  message: z.string(),
  defaultValue: z.string(),
});
export type PreviewDialog = z.infer<typeof PreviewDialog>;

export const PreviewFileChooser = z.object({ multiple: z.boolean(), accept: z.string() });

export const PreviewDownload = z.object({
  /** Names the file for `preview.tab.download` (D1331). */
  id: z.string().optional(),
  fileName: z.string(),
  path: z.string(),
  sizeBytes: z.number(),
  url: z.string(),
  completedAt: z.string(),
});

/** The payload of `preview.download` on a tab's frames stream (D1331). */
export const PreviewDownloadOffer = z.object({
  id: z.string(),
  fileName: z.string(),
  sizeBytes: z.number(),
});
export type PreviewDownloadOffer = z.infer<typeof PreviewDownloadOffer>;

export const PreviewStatusTab = z.object({
  tabId: PreviewTabId,
  url: z.string().nullable(),
  openerTabId: PreviewTabId.optional(),
  owner: PreviewTabOwner.optional(),
  ownedByCaller: z.boolean().optional(),
  visible: z.boolean().optional(),
});

/** T3's `PreviewAutomationStatus`. */
export const PreviewStatus = z.object({
  available: z.boolean(),
  visible: z.boolean(),
  tabId: PreviewTabId.nullable(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  loading: z.boolean(),
  control: z
    .object({ owner: PreviewTabOwner, ownedByCaller: z.boolean(), generation: z.number() })
    .optional(),
  dialog: PreviewDialog.nullable().optional(),
  viewportSetting: PreviewViewportSetting.optional(),
  viewport: PreviewRenderedViewportSize.optional(),
  fileChooser: PreviewFileChooser.nullable().optional(),
  downloads: z.array(PreviewDownload).optional(),
  /** Every tab of the thread: any can be read; acting needs your own or an unclaimed one. */
  tabs: z.array(PreviewStatusTab).optional(),
});
export type PreviewStatus = z.infer<typeof PreviewStatus>;

export const PreviewOpenInput = z
  .object({
    ...TargetFields,
    url: BoundedUrl.optional().describe(
      `Optional initial page URL. ${URL_GUIDANCE} Omit to open a blank tab.`,
    ),
    open: z
      .boolean()
      .optional()
      .describe(
        "Whether to open the thread-bound inline preview for the human. Defaults to true; set false for background-only automation.",
      ),
    reuseExistingTab: z
      .boolean()
      .optional()
      .describe(
        "Reuse tabId when supplied, otherwise this agent session's current tab. Defaults to true; set false to create a new tab.",
      ),
  })
  .refine((input) => !(input.tabId !== undefined && input.reuseExistingTab === false), {
    message: "tabId cannot be combined with reuseExistingTab=false.",
  })
  .describe(
    "Opens the collaborative browser for the thread. Use preview_navigate afterward when readiness waiting matters.",
  );
export type PreviewOpenInput = z.infer<typeof PreviewOpenInput>;

export const PreviewNavigationTarget = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("url").describe("Selects direct URL navigation."),
    url: BoundedUrl.describe(`Direct website URL. ${URL_GUIDANCE}`),
  }),
  z.object({
    kind: z
      .literal("environment-port")
      .describe("Selects a dev-server port on the node the browser runs on."),
    port: z.number().int().min(1).max(65_535).describe("Dev-server TCP port on the node."),
    protocol: z
      .enum(["http", "https"])
      .optional()
      .describe("Dev-server protocol. Defaults to http."),
    path: z
      .string()
      .max(PREVIEW_URL_MAX_LENGTH)
      .optional()
      .describe("Optional path, query, and fragment, for example /settings?tab=account."),
  }),
]);
export type PreviewNavigationTarget = z.infer<typeof PreviewNavigationTarget>;

export const PreviewReadiness = z
  .enum(["load", "domContentLoaded", "none"])
  .describe(
    "Readiness milestone before returning. 'load' waits for loading to stop (default), 'domContentLoaded' waits for an interactive document, and 'none' returns immediately.",
  );

export const PreviewNavigateInput = z
  .object({
    ...TargetFields,
    url: BoundedUrl.optional().describe(
      `Website URL. ${URL_GUIDANCE} Use this for public pages and directly reachable URLs.`,
    ),
    target: PreviewNavigationTarget.optional().describe(
      "Node-relative target. Prefer {kind:'environment-port',port:5173} for a dev server on the node.",
    ),
    readiness: PreviewReadiness.optional(),
    timeoutMs: TimeoutMs.optional(),
  })
  .refine((input) => Number(input.url !== undefined) + Number(input.target !== undefined) === 1, {
    message: "Provide exactly one of url or target.",
  });
export type PreviewNavigateInput = z.infer<typeof PreviewNavigateInput>;

export const PreviewResizeInput = z
  .object({
    ...TargetFields,
    mode: z
      .enum(["fill", "freeform", "preset"])
      .describe(
        "Viewport mode: fill follows the preview panel, freeform uses exact independently resizable dimensions, and preset uses a named device size.",
      ),
    preset: PreviewViewportPresetId.optional().describe(
      "Named device size from Chrome DevTools' standard device catalog. Required only when mode is preset.",
    ),
    width: z
      .number()
      .int()
      .min(240)
      .max(3840)
      .optional()
      .describe("Freeform viewport width in CSS pixels. Required only in freeform mode."),
    height: z
      .number()
      .int()
      .min(240)
      .max(3840)
      .optional()
      .describe("Freeform viewport height in CSS pixels. Required only in freeform mode."),
    orientation: z
      .enum(["portrait", "landscape"])
      .optional()
      .describe(
        "Orientation for a named device preset. It is not accepted in fill or freeform mode.",
      ),
    timeoutMs: TimeoutMs.optional(),
  })
  .superRefine((input, context) => {
    const hasPreset = input.preset !== undefined;
    const hasWidth = input.width !== undefined;
    const hasHeight = input.height !== undefined;
    const fail = (message: string) => context.addIssue({ code: "custom", message });
    if (hasWidth !== hasHeight) return fail("Custom dimensions require both width and height.");
    if (input.mode === "fill") {
      if (hasPreset || hasWidth || input.orientation !== undefined) {
        fail("Fill mode does not accept a preset, dimensions, or orientation.");
      }
      return;
    }
    if (input.mode === "freeform") {
      if (!hasWidth || hasPreset || input.orientation !== undefined) {
        return fail(
          "Freeform mode requires width and height and does not accept a preset or orientation.",
        );
      }
    } else if (!hasPreset || hasWidth) {
      return fail("Preset mode requires a preset and does not accept custom dimensions.");
    }
    if (hasWidth && input.width! * input.height! > PREVIEW_VIEWPORT_MAX_AREA) {
      fail(`Custom viewport area must not exceed ${PREVIEW_VIEWPORT_MAX_AREA} pixels.`);
    }
  });
export type PreviewResizeInput = z.infer<typeof PreviewResizeInput>;

export const PreviewResizeResult = z.object({
  tabId: PreviewTabId,
  setting: PreviewViewportSetting,
  viewport: PreviewRenderedViewportSize,
});

export const PreviewSetAppearanceInput = z.object({
  ...TargetFields,
  colorScheme: PreviewAppearance.describe(
    "Emulated prefers-color-scheme for the page: light, dark, or system to follow the OS appearance.",
  ),
});
export const PreviewSetAppearanceResult = z.object({
  tabId: PreviewTabId,
  colorScheme: PreviewAppearance,
});

const Locator = z
  .string()
  .trim()
  .min(1)
  .describe(
    "Use locator='aria-ref=<ref>' with a ref from the latest snapshot (including iframe elements), or a unique Playwright role/text selector. Refs expire on navigation, a new snapshot, or control handoff; refresh the snapshot after a stale-ref error.",
  );
const LegacySelector = z
  .string()
  .trim()
  .min(1)
  .describe(
    "Legacy CSS selector such as button[type='submit']. Prefer locator for resilient role/text targeting.",
  );

const PointerFields = {
  ...TargetFields,
  selector: LegacySelector.optional(),
  locator: Locator.optional(),
  x: z
    .number()
    .finite()
    .optional()
    .describe("Viewport-relative X coordinate in CSS pixels. Must be paired with y."),
  y: z
    .number()
    .finite()
    .optional()
    .describe("Viewport-relative Y coordinate in CSS pixels. Must be paired with x."),
  timeoutMs: TimeoutMs.optional(),
};

const onePointerTarget = (
  input: {
    selector?: string | undefined;
    locator?: string | undefined;
    x?: number | undefined;
    y?: number | undefined;
  },
  context: z.RefinementCtx,
) => {
  const selectors = Number(input.selector !== undefined) + Number(input.locator !== undefined);
  const hasX = input.x !== undefined;
  const hasY = input.y !== undefined;
  if (hasX !== hasY) {
    context.addIssue({ code: "custom", message: "Coordinates require both x and y." });
    return;
  }
  if (selectors + (hasX ? 1 : 0) !== 1) {
    context.addIssue({ code: "custom", message: "Provide exactly one target." });
  }
};

export const PreviewClickInput = z
  .object({
    ...PointerFields,
    button: z
      .enum(["left", "right", "middle"])
      .optional()
      .describe("Mouse button. Defaults to left; right opens the page's context menu."),
    clickCount: z
      .number()
      .int()
      .min(1)
      .max(3)
      .optional()
      .describe("1 for a click, 2 for a double-click, 3 for a triple-click. Defaults to 1."),
  })
  .superRefine(onePointerTarget);
export type PreviewClickInput = z.infer<typeof PreviewClickInput>;

export const PreviewHoverInput = z.object(PointerFields).superRefine(onePointerTarget);
export type PreviewHoverInput = z.infer<typeof PreviewHoverInput>;

const atMostOneSelector = (input: {
  selector?: string | undefined;
  locator?: string | undefined;
}) => !(input.selector !== undefined && input.locator !== undefined);
const AT_MOST_ONE = { message: "Provide at most one of selector or locator." };

export const PreviewSelectInput = z
  .object({
    ...TargetFields,
    selector: LegacySelector.optional(),
    locator: Locator.optional(),
    values: z
      .array(z.string())
      .max(100)
      .describe(
        "Option values or visible labels to select. Pass several for a multiple select, or an empty list to clear it.",
      ),
    timeoutMs: TimeoutMs.optional(),
  })
  .refine(
    (input) => Number(input.selector !== undefined) + Number(input.locator !== undefined) === 1,
    { message: "Provide exactly one of selector or locator." },
  );
export type PreviewSelectInput = z.infer<typeof PreviewSelectInput>;
export const PreviewSelectResult = z.object({
  selected: z.array(z.string()).describe("The values of the options now selected."),
});

export const PreviewDragInput = z.object({
  ...TargetFields,
  source: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Locator of the element to drag, for example aria-ref=<ref> from the latest snapshot.",
    ),
  target: z
    .string()
    .trim()
    .min(1)
    .describe("Locator of the element to drop onto, for example aria-ref=<ref>."),
  timeoutMs: TimeoutMs.optional(),
});
export type PreviewDragInput = z.infer<typeof PreviewDragInput>;

export const PreviewUploadInput = z
  .object({
    ...TargetFields,
    paths: z
      .array(z.string().trim().min(1))
      .max(20)
      .describe(
        "Absolute paths of files on the node to give the page. An empty list cancels the open file picker.",
      ),
    selector: LegacySelector.optional(),
    locator: Locator.optional(),
    timeoutMs: TimeoutMs.optional(),
  })
  .refine(atMostOneSelector, AT_MOST_ONE);
export type PreviewUploadInput = z.infer<typeof PreviewUploadInput>;

export const PreviewTypeInput = z
  .object({
    ...TargetFields,
    text: z.string().describe("Literal text to insert."),
    selector: LegacySelector.optional(),
    locator: Locator.optional(),
    clear: z
      .boolean()
      .optional()
      .describe("Clear the existing input value before inserting text. Defaults to false."),
    timeoutMs: TimeoutMs.optional(),
  })
  .refine(atMostOneSelector, AT_MOST_ONE);
export type PreviewTypeInput = z.infer<typeof PreviewTypeInput>;

export const PreviewPressInput = z.object({
  ...TargetFields,
  key: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Keyboard key name such as Enter, Escape, Tab, ArrowDown, Backspace, or a single character.",
    ),
  modifiers: z
    .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
    .optional()
    .describe("Modifier keys held while pressing key."),
});
export type PreviewPressInput = z.infer<typeof PreviewPressInput>;

export const PreviewScrollInput = z
  .object({
    ...TargetFields,
    deltaX: z
      .number()
      .finite()
      .optional()
      .describe("Horizontal scroll delta in CSS pixels. Positive scrolls right. Defaults to 0."),
    deltaY: z
      .number()
      .finite()
      .optional()
      .describe("Vertical scroll delta in CSS pixels. Positive scrolls down. Defaults to 0."),
    selector: LegacySelector.optional(),
    locator: Locator.optional(),
  })
  .refine(atMostOneSelector, AT_MOST_ONE)
  .refine((input) => input.deltaX !== undefined || input.deltaY !== undefined, {
    message: "Provide deltaX or deltaY.",
  });
export type PreviewScrollInput = z.infer<typeof PreviewScrollInput>;

export const PreviewEvaluateInput = z.object({
  ...TargetFields,
  expression: z
    .string()
    .trim()
    .min(1)
    .max(64_000)
    .describe(
      "JavaScript expression evaluated in the page's main frame, for example document.title or (() => ({href: location.href}))().",
    ),
  awaitPromise: z.boolean().optional().describe("Await a returned Promise. Defaults to true."),
  returnByValue: z
    .boolean()
    .optional()
    .describe(
      "Serialize and return the value instead of a remote object reference. Defaults to true.",
    ),
});
export type PreviewEvaluateInput = z.infer<typeof PreviewEvaluateInput>;
export const PreviewEvaluateResult = z.object({
  value: z.unknown().describe("The JSON-serializable value the expression produced, or null."),
});

export const PreviewWaitForInput = z
  .object({
    ...TargetFields,
    selector: LegacySelector.optional(),
    locator: Locator.optional(),
    text: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Case-sensitive substring that must appear in visible document text."),
    urlIncludes: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Substring that must appear in the current absolute URL."),
    timeoutMs: TimeoutMs.optional(),
  })
  .refine(atMostOneSelector, AT_MOST_ONE)
  .refine(
    (input) =>
      input.selector !== undefined ||
      input.locator !== undefined ||
      input.text !== undefined ||
      input.urlIncludes !== undefined,
    { message: "Provide at least one wait condition." },
  );
export type PreviewWaitForInput = z.infer<typeof PreviewWaitForInput>;

export const PreviewDialogInput = z.object({
  ...TargetFields,
  accept: z
    .boolean()
    .describe("Accept the pending browser dialog when true, or dismiss it when false."),
  promptText: z
    .string()
    .optional()
    .describe("Optional text to submit when accepting a prompt dialog."),
});
export type PreviewDialogInput = z.infer<typeof PreviewDialogInput>;

export const PreviewSnapshotInput = z.object({
  ...TargetFields,
  includeImage: z
    .boolean()
    .optional()
    .describe(
      "Include the PNG image in the result. Defaults to false. Set true only when you need to see the page.",
    ),
  save: z
    .boolean()
    .optional()
    .describe(
      "Write the screenshot PNG to disk and return its absolute path as screenshotPath. Unless includeImage=true, return only the url and screenshotPath. Defaults to false.",
    ),
});
export type PreviewSnapshotInput = z.infer<typeof PreviewSnapshotInput>;

export const PreviewConsoleEntry = z.object({
  level: z.string(),
  text: z.string(),
  timestamp: z.string(),
  source: z.string().optional(),
});
export type PreviewConsoleEntry = z.infer<typeof PreviewConsoleEntry>;

export const PreviewNetworkEntry = z.object({
  url: z.string(),
  method: z.string(),
  status: z.number().nullable(),
  failed: z.boolean(),
  errorText: z.string().optional(),
  timestamp: z.string(),
});
export type PreviewNetworkEntry = z.infer<typeof PreviewNetworkEntry>;

export const PreviewActionEvent = z.object({
  id: z.string(),
  action: z.string(),
  status: z.enum(["running", "succeeded", "failed", "interrupted"]),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
});
export type PreviewActionEvent = z.infer<typeof PreviewActionEvent>;

export const PreviewScreenshot = z.object({
  mimeType: z.literal("image/png"),
  data: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});

/**
 * T3's snapshot. With `save`, or without `includeImage`, parts are left out:
 * `save` alone answers with `url` and `screenshotPath` only.
 */
export const PreviewSnapshot = z.object({
  url: z.string(),
  title: z.string().optional(),
  loading: z.boolean().optional(),
  visibleText: z.string().optional(),
  interactiveElements: z.array(z.unknown()).optional(),
  accessibilityTree: z.string().optional(),
  consoleEntries: z.array(PreviewConsoleEntry).optional(),
  networkEntries: z.array(PreviewNetworkEntry).optional(),
  actionTimeline: z.array(PreviewActionEvent).optional(),
  screenshot: PreviewScreenshot.optional(),
  /** The size of the screenshot when the image itself is left out. */
  screenshotSize: z.object({ width: z.number().int(), height: z.number().int() }).optional(),
  screenshotPath: z.string().optional(),
});
export type PreviewSnapshot = z.infer<typeof PreviewSnapshot>;

export const PreviewRecordingStatus = z.object({
  tabId: PreviewTabId,
  recording: z.boolean(),
  startedAt: z.string().nullable(),
});
export const PreviewRecordingArtifact = z.object({
  id: z.string(),
  tabId: PreviewTabId,
  path: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  createdAt: z.string(),
});
export type PreviewRecordingArtifact = z.infer<typeof PreviewRecordingArtifact>;

/** The longest recording T3 transfers. */
export const PREVIEW_RECORDING_MAX_BYTES = 50 * 1024 * 1024;

// --- Tabs as the panel sees them --------------------------------------------

/** T3's `PreviewNavStatus`. */
export const PreviewNavStatus = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }),
  z.object({ state: z.literal("loading"), url: z.string(), title: z.string() }),
  z.object({ state: z.literal("success"), url: z.string(), title: z.string() }),
  z.object({
    state: z.literal("failed"),
    url: z.string(),
    title: z.string(),
    code: z.number().int(),
    description: z.string(),
  }),
]);
export type PreviewNavStatus = z.infer<typeof PreviewNavStatus>;

// --- Browser profiles (T3's, D952) ------------------------------------------

/**
 * A browser profile's id. Control characters are refused: ids are folded into
 * delimiter-joined keys, and one carrying the delimiter would reach another
 * profile (T3).
 */
export const BrowserProfileId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[^\p{Cc}]+$/u);
export type BrowserProfileId = z.output<typeof BrowserProfileId>;
/** The profile whose cookies and storage persist, used when none is named. */
export const DEFAULT_BROWSER_PROFILE_ID = "default";
/** The profile that keeps nothing: its storage lives as long as the browser. */
export const INCOGNITO_BROWSER_PROFILE_ID = "incognito";

export const PreviewProfileClearInput = z.object({ profileId: BrowserProfileId });

/** One tab, as the thread's `preview.tabs` event and `preview.list` give it. */
export const PreviewTab = z.object({
  threadId: z.string(),
  tabId: PreviewTabId,
  navStatus: PreviewNavStatus,
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  viewport: PreviewViewportSetting,
  /** The page's size in CSS pixels. */
  size: PreviewRenderedViewportSize,
  colorScheme: PreviewAppearance,
  zoomFactor: z.number(),
  owner: PreviewTabOwner,
  /** The viewer holding control, when a human does. */
  controller: z.string().nullable(),
  generation: z.number().int(),
  dialog: PreviewDialog.nullable(),
  fileChooser: PreviewFileChooser.nullable(),
  recording: z.boolean(),
  /** A client watches its frames. */
  visible: z.boolean(),
  /** The agent asked to show it to the human (T3's `reveal`). */
  reveal: z.boolean(),
  openerTabId: PreviewTabId.optional(),
  /** A human's tab: the profile it browses with (D952). An agent's tab has its own storage. */
  profileId: BrowserProfileId.optional(),
  openedAt: z.string(),
  updatedAt: z.string(),
  /** The page runs in the desktop app's webview, not in the node's headless browser (D1321). */
  desktop: z.literal(true).optional(),
  /** Its desktop page went; it waits for the app's webview again (desktop.md D1488). */
  reconnecting: z.literal(true).optional(),
});
export type PreviewTab = z.infer<typeof PreviewTab>;

export const PreviewListInput = z.object({
  threadId: PreviewThreadId,
  cursor: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
export const PreviewListResult = z.object({
  tabs: z.array(PreviewTab),
  nextCursor: z.number().int().nonnegative().nullable(),
});

export const PreviewCloseInput = z.object({
  threadId: PreviewThreadId,
  tabId: PreviewTabId,
  session: TargetFields.session,
});

// --- The panel's commands ---------------------------------------------------

const TabFields = { threadId: PreviewThreadId, tabId: PreviewTabId };

export const PreviewTabOpenInput = z.object({
  threadId: PreviewThreadId,
  url: BoundedUrl.optional(),
  viewport: PreviewViewportSetting.optional(),
  /** The browser profile whose cookies the tab uses (D952); `default` when absent. */
  profileId: BrowserProfileId.optional(),
});
export const PreviewTabCloseInput = z.object(TabFields);

/**
 * An Electron partition of the preview (D1323): `persist:jhin-preview-<profile>`
 * for a profile (its id as base64url), `jhin-preview-incognito-<tab>` or
 * `jhin-preview-agent-<tab>` in memory.
 */
export const PREVIEW_PARTITION_PATTERN =
  /^(persist:jhin-preview-[A-Za-z0-9_-]{1,344}|jhin-preview-(incognito|agent)-[A-Za-z0-9._:-]{1,128})$/;

/** The partition a profile's tabs browse with in the desktop app (D1323). */
export function previewProfilePartition(profileId: string): string {
  // UTF-8, then base64url without padding (no TextEncoder or btoa in every runtime's types).
  const bytes = encodeURIComponent(profileId)
    .replace(/%([0-9A-F]{2})|./gs, (match, hex?: string) =>
      String.fromCharCode(hex === undefined ? match.charCodeAt(0) : Number.parseInt(hex, 16)),
    )
    .split("")
    .map((char) => char.charCodeAt(0));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const [a = 0, b = 0, c = 0] = bytes.slice(index, index + 3);
    const chunk = (a << 16) | (b << 8) | c;
    const length = Math.min(3, bytes.length - index) + 1;
    for (let char = 0; char < length; char += 1) {
      encoded += alphabet[(chunk >> (18 - char * 6)) & 63];
    }
  }
  return `persist:jhin-preview-${encoded}`;
}

/** A tab the desktop app should host in a webview (D1321). */
export const PreviewDesktopTab = z.object({
  threadId: z.string(),
  tabId: PreviewTabId,
  partition: z.string().regex(PREVIEW_PARTITION_PATTERN),
  /** A human's tab: its profile, which links its page opens keep (D1323). */
  profileId: BrowserProfileId.optional(),
  /** The node connected to its webview. */
  attached: z.boolean(),
});
export type PreviewDesktopTab = z.infer<typeof PreviewDesktopTab>;

/** A loopback WebSocket of the app's relay (D1322). */
export const PREVIEW_DESKTOP_ENDPOINT_PATTERN = /^ws:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9_-]{32}$/;

export const PreviewDesktopAttachInput = z.object({
  ...TabFields,
  endpoint: z
    .string()
    .regex(PREVIEW_DESKTOP_ENDPOINT_PATTERN)
    .describe("The app's loopback CDP endpoint of the tab's webview."),
});
export type PreviewDesktopAttachInput = z.infer<typeof PreviewDesktopAttachInput>;
export const PreviewTabAdjustInput = z.object({
  ...TabFields,
  viewport: PreviewViewportSetting.optional(),
  colorScheme: PreviewAppearance.optional(),
  zoomFactor: PreviewZoomFactor.optional(),
  hardReload: z.boolean().optional(),
  clear: z.enum(["cookies", "cache"]).optional(),
});
export type PreviewTabAdjustInput = z.infer<typeof PreviewTabAdjustInput>;

export const PreviewTabControlInput = z.object({
  ...TabFields,
  viewer: PreviewViewerId,
  take: z.boolean().describe("Take control when true, release it when false."),
});

export const PreviewTabNavigateInput = z
  .object({
    ...TabFields,
    viewer: PreviewViewerId,
    url: BoundedUrl.optional(),
    delta: z.union([z.literal(-1), z.literal(1)]).optional(),
    reload: z.object({ ignoreCache: z.boolean().optional() }).optional(),
  })
  .refine(
    (input) =>
      Number(input.url !== undefined) +
        Number(input.delta !== undefined) +
        Number(input.reload !== undefined) ===
      1,
    { message: "Provide exactly one of url, delta or reload." },
  );
export type PreviewTabNavigateInput = z.infer<typeof PreviewTabNavigateInput>;

export const PreviewTabDialogInput = z.object({
  ...TabFields,
  viewer: PreviewViewerId,
  accept: z.boolean(),
  promptText: z.string().max(10_000).optional(),
});

/** What one `preview.tab.download` answer carries at most (D1331), as an upload. */
export const PREVIEW_DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

export const PreviewTabDownloadInput = z.object({
  threadId: PreviewThreadId,
  tabId: PreviewTabId,
  id: z.string().min(1).max(64),
});
export const PreviewTabDownloadResult = z.object({
  fileName: z.string(),
  /** The file, base64. */
  data: z.string(),
});

/** T3's most files a page's file picker takes in one upload (D1203). */
export const PREVIEW_UPLOAD_MAX_FILES = 20;
/**
 * The most bytes one upload carries. T3 takes 100 MB through HTTP; an upload here is one RPC
 * message of base64, which the WebSocket transport takes up to 100 MiB of (D1203).
 */
export const PREVIEW_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

/** One file the user chose for a page's file picker, its bytes in base64. */
export const PreviewUploadFile = z.object({
  name: z.string().min(1).max(255),
  mimeType: z.string().max(255).optional(),
  data: z
    .string()
    .max(Math.ceil(PREVIEW_UPLOAD_MAX_BYTES / 3) * 4)
    .refine((data) => data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data), {
      message: "File data must be base64.",
    }),
});
export type PreviewUploadFile = z.infer<typeof PreviewUploadFile>;

/** The bytes a base64 string decodes to. */
function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/**
 * Answers the open file picker of a tab with the files the viewer holding control chose,
 * or cancels it with none (T3's upload of the stream, D1203).
 */
export const PreviewTabUploadInput = z
  .object({
    ...TabFields,
    viewer: PreviewViewerId,
    files: z.array(PreviewUploadFile).max(PREVIEW_UPLOAD_MAX_FILES),
  })
  .refine(
    (input) =>
      input.files.reduce((total, file) => total + base64Bytes(file.data), 0) <=
      PREVIEW_UPLOAD_MAX_BYTES,
    { message: `An upload carries at most ${PREVIEW_UPLOAD_MAX_BYTES / 1024 / 1024} MiB.` },
  );

/** Whether a tap at a page point lands on something editable (T3's probe, D1203). */
export const PreviewTabProbeInput = z.object({
  ...TabFields,
  viewer: PreviewViewerId,
  x: z.number().finite(),
  y: z.number().finite(),
});
export const PreviewTabProbeResult = z.object({
  x: z.number(),
  y: z.number(),
  editable: z.boolean(),
});
export type PreviewTabProbeResult = z.infer<typeof PreviewTabProbeResult>;

/** Modifier bits of T3's stream input: alt 1, ctrl 2, meta 4, shift 8. */
export const PreviewModifiers = z.number().int().min(0).max(15);

/** One input of a viewer that holds control: T3's stream messages. */
export const PreviewInputEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mouse"),
    action: z.enum(["move", "down", "up"]),
    x: z.number().finite(),
    y: z.number().finite(),
    button: z.enum(["none", "left", "middle", "right"]).optional(),
    buttons: z.number().int().min(0).max(31).optional(),
    clickCount: z.number().int().min(0).max(3).optional(),
    modifiers: PreviewModifiers.optional(),
  }),
  z.object({
    type: z.literal("wheel"),
    x: z.number().finite(),
    y: z.number().finite(),
    deltaX: z.number().finite(),
    deltaY: z.number().finite(),
    modifiers: PreviewModifiers.optional(),
  }),
  z.object({
    type: z.literal("key"),
    action: z.enum(["down", "up"]),
    key: z.string().max(64),
    code: z.string().max(64),
    keyCode: z.number().int().min(0).max(1024),
    text: z.string().max(16).optional(),
    modifiers: PreviewModifiers.optional(),
  }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(10_000) }),
  z.object({
    type: z.literal("resize"),
    width: z.number().int().min(100).max(3840),
    height: z.number().int().min(100).max(2160),
    /** Device pixels per CSS pixel of the viewer: frames are at most this sharp. */
    scale: z.number().min(0.5).max(4).optional(),
  }),
]);
export type PreviewInputEvent = z.infer<typeof PreviewInputEvent>;

export const PreviewTabInputInput = z.object({
  ...TabFields,
  viewer: PreviewViewerId,
  events: z.array(PreviewInputEvent).min(1).max(256),
});

/** `preview.browser@1` for other plugins of the node; the commands use it. */
export interface PreviewBrowser {
  /** The run tab ids carry: new whenever the plugin starts. */
  readonly instance: string;
  /** The thread's tabs, oldest first. */
  tabs(threadId: string): readonly PreviewTab[];
  /** Closes every tab of a thread, or one; resolves with how many it closed. */
  close(threadId: string, tabId?: string): Promise<number>;
}
