// Follows T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/server/src/preview/ServerBrowserPage.ts
// (locators and element refs, the snapshot with masked password values, click, type, hover,
// select, drag, upload, press, scroll, evaluate, wait-for and network error codes).
import * as Crypto from "node:crypto";

import {
  PREVIEW_CONTROL_MESSAGES,
  PreviewError,
  type PreviewActionEvent,
  type PreviewClickInput,
  type PreviewConsoleEntry,
  type PreviewDragInput,
  type PreviewEvaluateInput,
  type PreviewHoverInput,
  type PreviewNetworkEntry,
  type PreviewPressInput,
  type PreviewScrollInput,
  type PreviewSelectInput,
  type PreviewTypeInput,
  type PreviewUploadInput,
  type PreviewWaitForInput,
} from "@jhin/preview-api";
import type { CDPSession, Locator, Page } from "playwright-core";

import { ControlInterrupted } from "./control.ts";

export const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_EVALUATION_BYTES = 64_000;
const MAX_VISIBLE_TEXT_LENGTH = 20_000;
const MAX_SCREENSHOT_WIDTH = 1280;
const WAIT_POLL_MS = 100;
const SNAPSHOT_TIMEOUT_MS = 10_000;
/** Console, network and action entries a tab keeps (the newest). */
export const DIAGNOSTIC_LIMIT = 200;
export const ACTION_LIMIT = 50;

/** Any failure of an operation as the error the agent reads (T3's `toOperationError`). */
export function toPreviewError(cause: unknown): PreviewError {
  if (cause instanceof PreviewError) return cause;
  if (cause instanceof ControlInterrupted) {
    return new PreviewError("PREVIEW_CONTROL", PREVIEW_CONTROL_MESSAGES[cause.reason], {
      reason: cause.reason,
      cause: cause.message,
    });
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  const firstLine = (message.split("\n")[0] ?? message).slice(0, 500);
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return new PreviewError("PREVIEW_TIMEOUT", firstLine);
  }
  if (
    /while parsing selector|Unknown engine|Unexpected token|strict mode violation/i.test(message)
  ) {
    return new PreviewError("PREVIEW_INVALID_SELECTOR", firstLine);
  }
  if (/not an <input>|not editable|not an editable/i.test(message)) {
    return new PreviewError("PREVIEW_NOT_EDITABLE", firstLine);
  }
  return new PreviewError("PREVIEW_EXECUTION", firstLine);
}

// --- Element refs -----------------------------------------------------------

const pageRefs = new WeakMap<Page, { generation: string; refs: Map<string, string> }>();
// A namespace per run keeps refs of a previous run from aliasing new ones.
const refNamespace = Crypto.randomUUID().slice(0, 8);
let snapshotSequence = 0;
const nextRefGeneration = () => `${refNamespace}-${(++snapshotSequence).toString(36)}`;

/** Revokes the refs a snapshot handed out (navigation, a dialog, a change of control). */
export function invalidateRefs(page: Page): void {
  const state = pageRefs.get(page);
  if (state === undefined) return;
  state.generation = nextRefGeneration();
  state.refs.clear();
}

function refsFor(page: Page) {
  let state = pageRefs.get(page);
  if (state === undefined) {
    state = { generation: nextRefGeneration(), refs: new Map<string, string>() };
    pageRefs.set(page, state);
    page.on("framenavigated", () => invalidateRefs(page));
    page.on("framedetached", () => invalidateRefs(page));
  }
  return state;
}

/** The element a locator or selector names; `aria-ref=` takes refs of the latest snapshot. */
function targetLocator(
  page: Page,
  input: { readonly locator?: string | undefined; readonly selector?: string | undefined },
): Locator | null {
  const selector = input.locator ?? input.selector;
  if (selector === undefined) return null;
  // Quoted and escaped CSS values are no selector-engine boundary.
  const engines = selector.replace(
    /\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    " ",
  );
  if (/(?:^|>>)\s*\*?aria-ref\s*=/.test(engines)) {
    const ref = /^\s*aria-ref\s*=\s*(\S+)\s*$/.exec(selector)?.[1];
    const nativeRef = ref === undefined ? undefined : pageRefs.get(page)?.refs.get(ref);
    if (nativeRef === undefined) {
      throw new PreviewError(
        "PREVIEW_INVALID_SELECTOR",
        "This element ref is stale. Navigation, dialogs, and new snapshots replace refs; take a fresh snapshot and use its refs.",
        { staleRef: true },
      );
    }
    return page.locator(`aria-ref=${nativeRef}`);
  }
  // Playwright's strict locators refuse an ambiguous control instead of acting on the first.
  return page.locator(selector);
}

export type PointerReporter = (
  point: { readonly x: number; readonly y: number },
  phase: "move" | "click",
) => Promise<void>;
const noPointer: PointerReporter = async () => {};

async function targetPoint(
  page: Page,
  locator: Locator | null,
  input: { readonly x?: number | undefined; readonly y?: number | undefined },
  timeout: number,
) {
  if (locator === null) return { x: input.x ?? 0, y: input.y ?? 0 };
  await locator.scrollIntoViewIfNeeded({ timeout });
  const box = await locator.boundingBox({ timeout });
  if (box !== null) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const viewport = page.viewportSize();
  return { x: (viewport?.width ?? 0) / 2, y: (viewport?.height ?? 0) / 2 };
}

// --- Snapshot ---------------------------------------------------------------

const SNAPSHOT_SCRIPT = `(() => ({
  url: location.href,
  title: document.title,
  loading: document.readyState !== "complete",
  visibleText: document.body?.innerText || "",
}))()`;

const MASKED_VALUE = "••••••••";

// Values the page draws as dots (password fields, and fields whose CSS draws dots),
// raw as page text shows them and normalised as the tree does. Open shadow roots included.
const DOTTED_SCRIPT = `(() => {
  const values = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) visit(element.shadowRoot);
      const field = element.localName === "input" || element.localName === "textarea";
      if (!field && !element.isContentEditable) continue;
      const dots = getComputedStyle(element).getPropertyValue("-webkit-text-security");
      if (element.type !== "password" && (dots === "none" || dots === "")) continue;
      for (const value of field ? [element.value, element.defaultValue] : [element.textContent ?? ""])
        values.push(value, value.replace(/[\\u200b\\u00ad]/g, "").trim().replace(/\\s+/g, " "));
    }
  };
  visit(document);
  return [...new Set(values.filter((value) => value.trim()))];
})()`;

const pageChanged = () =>
  new PreviewError(
    "PREVIEW_EXECUTION",
    "The page changed while capturing its snapshot. Take another snapshot.",
  );
const tooBusy = () =>
  new PreviewError(
    "PREVIEW_TIMEOUT",
    "The page was too busy to capture a snapshot in time. Wait for it to settle and take another snapshot.",
  );
const VALUE_TOO_LONG = "A password field holds a value too long to hide, so no snapshot was taken.";

/** The dotted values of every frame; a frame that does not answer in a second is skipped. */
async function readDotted(page: Page): Promise<string[]> {
  const values = await Promise.all(
    page.frames().map((frame) => {
      const read = frame.evaluate(DOTTED_SCRIPT) as Promise<string[]>;
      if (frame === page.mainFrame()) return read.catch(() => Promise.reject(pageChanged()));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<string[]>((resolve) => {
        timer = setTimeout(() => resolve([]), 1_000);
      });
      return Promise.race([read.catch(() => []), late]).finally(() => clearTimeout(timer));
    }),
  );
  return values.flat();
}

/**
 * Matches each value as the snapshot prints it: raw, as a JSON string, quoted,
 * and with '' for each quote of a quoted key. A value under four characters
 * matches only between non-word characters.
 */
function dottedPattern(values: readonly string[]): RegExp | undefined {
  const sources = values
    .flatMap((value) => {
      const json = JSON.stringify(value).slice(1, -1);
      const quoted = value.replace(/[\\"\p{Cc}]/gu, (char) =>
        '\\"\b\f\n\r\t'.includes(char)
          ? JSON.stringify(char).slice(1, -1)
          : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
      );
      const forms = [value, json, quoted].flatMap((form) => [form, form.replaceAll("'", "''")]);
      return [...new Set(forms)].map((form) => ({ form, word: value.length < 4 }));
    })
    // Longest first, so a form inside another never leaves the rest showing.
    .toSorted((a, b) => b.form.length - a.form.length)
    .map(({ form, word }) => {
      const literal = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return word ? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])` : literal;
    });
  if (sources.length === 0) return undefined;
  const pattern = new RegExp(sources.join("|"), "gu");
  try {
    pattern.test("");
    pattern.test("\u2022");
  } catch {
    throw new PreviewError("PREVIEW_EXECUTION", VALUE_TOO_LONG);
  }
  return pattern;
}

// `- role "name" [attribute]...: value`; only Playwright's own attributes count.
const TREE_LINE =
  /^(\s*- '?[^\s"':]+)( "(?:[^"\\]|\\.)*"| \/(?:.*?\/)?)?((?: \[(?:active|checked(?:=mixed)?|disabled|expanded|level=\d+|pressed(?:=mixed)?|selected|ref=(?:f\d+)?e\d+|cursor=pointer|box=-?\d+,-?\d+,\d+,\d+)\])*'?)(:.*)?$/;

/** Masks values on each line, except inside the role and attributes, so refs keep working. */
function maskTree(tree: string, dotted: RegExp): string {
  return tree
    .split("\n")
    .map((line) => {
      const node = TREE_LINE.exec(line);
      const name = node?.[1]?.length ?? 0;
      const attributes = name + (node?.[2]?.length ?? 0);
      const end = attributes + (node?.[3]?.length ?? 0);
      const kept = (from: number, to: number) => to <= name || (from >= attributes && to <= end);
      return line.replace(dotted, (match: string, offset: number) =>
        kept(offset, offset + match.length) ? match : MASKED_VALUE,
      );
    })
    .join("\n");
}

/** A screenshot of the viewport; `scale` below 1 shrinks it. */
export async function captureViewport(
  page: Page,
  cdp: CDPSession,
  options: { readonly format: "png" | "jpeg"; readonly quality?: number; readonly scale: number },
): Promise<string> {
  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  if (options.scale < 1) {
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    const { cssVisualViewport } = await cdp.send("Page.getLayoutMetrics");
    clip = {
      x: cssVisualViewport.pageX,
      y: cssVisualViewport.pageY,
      ...viewport,
      scale: options.scale,
    };
  }
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: options.format,
    ...(options.quality === undefined ? {} : { quality: options.quality }),
    ...(clip === undefined ? {} : { clip }),
  });
  return data;
}

export interface SnapshotInput {
  readonly page: Page;
  readonly cdp: CDPSession;
  /** Device pixels per CSS pixel the browser renders at. */
  readonly renderScale: number;
  /** The page's size in CSS pixels, when Playwright does not set it (a desktop webview's). */
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly consoleEntries: readonly PreviewConsoleEntry[];
  readonly networkEntries: readonly PreviewNetworkEntry[];
  readonly actionTimeline: readonly PreviewActionEvent[];
}

export interface CapturedSnapshot {
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly visibleText: string;
  readonly interactiveElements: readonly unknown[];
  readonly accessibilityTree: string;
  readonly consoleEntries: readonly PreviewConsoleEntry[];
  readonly networkEntries: readonly PreviewNetworkEntry[];
  readonly actionTimeline: readonly PreviewActionEvent[];
  readonly screenshot: {
    readonly mimeType: "image/png";
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
}

async function capture(input: SnapshotInput, deadline: number): Promise<CapturedSnapshot> {
  const viewport = input.page.viewportSize() ?? input.viewport ?? { width: 1280, height: 800 };
  const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / (viewport.width * input.renderScale));
  const state = refsFor(input.page);
  invalidateRefs(input.page);
  const generation = state.generation;
  const before = await readDotted(input.page);
  const pageAndScreenshot = Promise.all([
    input.page.evaluate(SNAPSHOT_SCRIPT) as Promise<{
      url: string;
      title: string;
      loading: boolean;
      visibleText: string;
    }>,
    captureViewport(input.page, input.cdp, { format: "png", scale }),
  ]);
  void pageAndScreenshot.catch(() => undefined);
  const tree = await input.page.ariaSnapshot({
    mode: "ai",
    timeout: Math.max(1, deadline - Date.now() - 2_000),
  });
  const after = await readDotted(input.page);
  // A value that changed meanwhile may be in the tree under neither reading.
  if (JSON.stringify(after) !== JSON.stringify(before)) throw pageChanged();
  const dotted = dottedPattern(after);
  const [page, data] = await pageAndScreenshot;
  if (state.generation !== generation) throw pageChanged();
  const mask = (text: string) => (dotted === undefined ? text : text.replace(dotted, MASKED_VALUE));
  const accessibilityTree = (dotted === undefined ? tree : maskTree(tree, dotted))
    .slice(0, MAX_VISIBLE_TEXT_LENGTH)
    .replace(/\[ref=((?:f\d+)?e\d+)\]/g, (_match, nativeRef: string) => {
      const ref = `t3-${generation}-${nativeRef}`;
      state.refs.set(ref, nativeRef);
      return `[ref=${ref}]`;
    });
  return {
    ...page,
    // Masked before the cut, so a value crossing it cannot leave its start showing.
    visibleText: mask(page.visibleText).slice(0, MAX_VISIBLE_TEXT_LENGTH),
    interactiveElements: [],
    accessibilityTree,
    consoleEntries: [...input.consoleEntries],
    networkEntries: [...input.networkEntries],
    actionTimeline: [...input.actionTimeline],
    screenshot: {
      mimeType: "image/png",
      data,
      width: Math.round(viewport.width * input.renderScale * scale),
      height: Math.round(viewport.height * input.renderScale * scale),
    },
  };
}

const snapshotTurns = new WeakMap<Page, number>();

/** The page as the agent inspects it; one retry when the page changed while it was read. */
export async function snapshot(input: SnapshotInput): Promise<CapturedSnapshot> {
  const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(tooBusy()), SNAPSHOT_TIMEOUT_MS);
  });
  const turn = (snapshotTurns.get(input.page) ?? 0) + 1;
  snapshotTurns.set(input.page, turn);
  const captured = capture(input, deadline).catch((cause: unknown) =>
    Date.now() < deadline &&
    snapshotTurns.get(input.page) === turn &&
    !(cause instanceof Error && cause.message === VALUE_TOO_LONG)
      ? capture(input, deadline)
      : Promise.reject(cause),
  );
  void captured.catch(() => undefined);
  try {
    return await Promise.race([captured, expired]);
  } catch (cause) {
    throw cause instanceof Error && cause.name === "TimeoutError" ? tooBusy() : cause;
  } finally {
    clearTimeout(timer);
  }
}

// --- Actions ----------------------------------------------------------------

/** A click whose handler opens a dialog returns as soon as the dialog opens. */
export async function click(
  page: Page,
  input: PreviewClickInput,
  pointer: PointerReporter = noPointer,
): Promise<void> {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const locator = targetLocator(page, input);
  const point = await targetPoint(page, locator, input, timeout);
  await pointer(point, "click");
  const options = { button: input.button ?? "left", clickCount: input.clickCount ?? 1 } as const;
  const clicked =
    locator === null
      ? page.mouse.click(point.x, point.y, options)
      : locator.click({ ...options, timeout });
  let onDialog = () => {};
  const dialogOpened = new Promise<"dialog">((resolve) => {
    onDialog = () => resolve("dialog");
    page.once("dialog", onDialog);
  });
  try {
    if ((await Promise.race([clicked, dialogOpened])) === "dialog") {
      void clicked.catch(() => undefined);
    }
  } finally {
    page.off("dialog", onDialog);
  }
}

export async function type(page: Page, input: PreviewTypeInput): Promise<void> {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const locator = targetLocator(page, input);
  if (locator !== null && input.clear === true) {
    await locator.fill(input.text, { timeout });
    return;
  }
  // A shadow host also matches :focus; its innermost focused descendant is last.
  const target = locator ?? page.locator("*:focus").last();
  const focused =
    (locator !== null || (await target.count()) > 0) &&
    (await target.evaluate(
      (element) => {
        // An enabled text control or contenteditable that takes focus; anything else
        // would swallow the text or send it to the field focused before.
        const control = element as unknown as {
          readonly type?: string;
          readonly disabled?: boolean;
          readonly readOnly?: boolean;
          readonly isContentEditable?: boolean;
          readonly focus?: () => void;
        };
        const nonText = [
          "button",
          "checkbox",
          "color",
          "file",
          "hidden",
          "image",
          "radio",
          "range",
          "reset",
          "submit",
        ];
        const textControl =
          element.tagName === "TEXTAREA" ||
          (element.tagName === "INPUT" && !nonText.includes(control.type ?? "text"));
        if (!(textControl || control.isContentEditable === true)) return false;
        if (control.disabled === true || control.readOnly === true) return false;
        control.focus?.();
        const root = element.getRootNode() as { readonly activeElement?: typeof element | null };
        const active = root.activeElement;
        return active != null && (active === element || element.contains(active));
      },
      undefined,
      { timeout },
    ));
  if (focused !== true) {
    throw new PreviewError(
      "PREVIEW_NOT_EDITABLE",
      "The target is not an enabled text field, so no text was typed.",
    );
  }
  if (input.clear === true) {
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Delete");
  }
  await page.keyboard.insertText(input.text);
}

export async function hover(
  page: Page,
  input: PreviewHoverInput,
  pointer: PointerReporter = noPointer,
): Promise<void> {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const locator = targetLocator(page, input);
  await pointer(await targetPoint(page, locator, input, timeout), "move");
  if (locator === null) {
    await page.mouse.move(input.x ?? 0, input.y ?? 0);
    return;
  }
  await locator.hover({ timeout });
}

export async function select(page: Page, input: PreviewSelectInput): Promise<string[]> {
  const locator = targetLocator(page, input)!;
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const options = await locator.evaluate(
    (element) =>
      element.tagName === "SELECT"
        ? Array.from(
            (element as unknown as { options: ArrayLike<{ value: string; label: string }> })
              .options,
            ({ value, label }) => ({ value, label: label.trim() }),
          )
        : null,
    undefined,
    { timeout },
  );
  if (options === null) {
    throw new PreviewError(
      "PREVIEW_NOT_EDITABLE",
      "This element is not a <select>. Click a custom dropdown, then click its option.",
    );
  }
  const values = input.values.map(
    (entry) =>
      (
        options.find((option) => option.value === entry) ??
        options.find((option) => option.label === entry.trim())
      )?.value ?? entry,
  );
  return locator.selectOption(values, { timeout });
}

export async function drag(
  page: Page,
  input: PreviewDragInput,
  pointer: PointerReporter = noPointer,
): Promise<void> {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const source = targetLocator(page, { locator: input.source })!;
  const target = targetLocator(page, { locator: input.target })!;
  await pointer(await targetPoint(page, source, {}, timeout), "move");
  // Watched from the start: a rejection nobody handles while the cursor moves would escape.
  const dragFailure = source.dragTo(target, { timeout }).then(
    () => null,
    (error: unknown) => ({ error }),
  );
  const end = await target.boundingBox({ timeout }).catch(() => null);
  if (end !== null) await pointer({ x: end.x + end.width / 2, y: end.y + end.height / 2 }, "move");
  const failure = await dragFailure;
  if (failure !== null) throw failure.error;
}

/** Sets a file input's files; `false` when no locator names one (the open chooser answers). */
export async function setInputFiles(page: Page, input: PreviewUploadInput): Promise<boolean> {
  const locator = targetLocator(page, input);
  if (locator === null) return false;
  await locator.setInputFiles([...input.paths], { timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  return true;
}

export async function press(page: Page, input: PreviewPressInput): Promise<void> {
  await page.keyboard.press([...(input.modifiers ?? []), input.key].join("+"));
}

export async function scroll(page: Page, input: PreviewScrollInput): Promise<void> {
  const delta = [input.deltaX ?? 0, input.deltaY ?? 0] as const;
  const locator = targetLocator(page, input);
  if (locator === null) {
    await page.evaluate(`scrollBy(${delta[0]}, ${delta[1]})`);
    return;
  }
  await locator.evaluate((element, [x, y]) => element.scrollBy(x, y), delta);
}

/** Runs an agent's expression; past its deadline the page's script is stopped. */
export async function evaluate(
  cdp: CDPSession,
  input: PreviewEvaluateInput,
  timeoutMs: number,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void cdp.send("Runtime.terminateExecution").catch(() => undefined);
      reject(
        new PreviewError(
          "PREVIEW_TIMEOUT",
          `Evaluation did not finish within ${timeoutMs}ms and was stopped.`,
        ),
      );
    }, timeoutMs);
  });
  const evaluation = cdp.send("Runtime.evaluate", {
    expression: input.expression,
    awaitPromise: input.awaitPromise ?? true,
    returnByValue: input.returnByValue ?? true,
  });
  void evaluation.catch(() => undefined);
  const result = await Promise.race([evaluation, expired]).finally(() => clearTimeout(timer));
  if (result.exceptionDetails !== undefined) {
    throw new PreviewError(
      "PREVIEW_EXECUTION",
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
  }
  const value =
    "value" in result.result ? result.result.value : (result.result.description ?? null);
  const bytes = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  if (bytes > MAX_EVALUATION_BYTES) {
    throw new PreviewError(
      "PREVIEW_RESULT_TOO_LARGE",
      `Evaluation result is ${bytes} bytes; the limit is ${MAX_EVALUATION_BYTES}.`,
      { maximumBytes: MAX_EVALUATION_BYTES },
    );
  }
  return value ?? null;
}

/** Checks every 100 ms until every condition holds (T3's wait). */
export async function waitFor(page: Page, input: PreviewWaitForInput): Promise<void> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const locator = targetLocator(page, input);
  const { text, urlIncludes } = input;
  const checks: (() => Promise<boolean>)[] = [];
  if (locator !== null) checks.push(async () => (await locator.count()) > 0);
  if (text !== undefined) {
    // A navigation can destroy the context mid-check; that counts as not yet.
    checks.push(() =>
      page
        .evaluate(`(document.body?.innerText ?? "").includes(${JSON.stringify(text)})`)
        .then((found) => found === true)
        .catch(() => false),
    );
  }
  if (urlIncludes !== undefined) checks.push(async () => page.url().includes(urlIncludes));
  for (;;) {
    const results = await Promise.all(checks.map((check) => check()));
    if (results.every(Boolean)) return;
    if (Date.now() >= deadline) {
      throw new PreviewError(
        "PREVIEW_TIMEOUT",
        `Waited ${timeoutMs}ms without every condition holding.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
}

const NET_ERROR_CODES: Readonly<Record<string, number>> = {
  ERR_FAILED: -2,
  ERR_TIMED_OUT: -7,
  ERR_CONNECTION_CLOSED: -100,
  ERR_CONNECTION_RESET: -101,
  ERR_CONNECTION_REFUSED: -102,
  ERR_NAME_NOT_RESOLVED: -105,
  ERR_INTERNET_DISCONNECTED: -106,
  ERR_ADDRESS_UNREACHABLE: -109,
  ERR_CERT_AUTHORITY_INVALID: -202,
  ERR_EMPTY_RESPONSE: -324,
};

/** A failed navigation's `ERR_*` name and Chromium's number for it. */
export function parseNetError(errorText: string): { description: string; code: number } {
  const description = /ERR_[A-Z_]+/.exec(errorText)?.[0] ?? errorText;
  return { description, code: NET_ERROR_CODES[description] ?? -2 };
}
