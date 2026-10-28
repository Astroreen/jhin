// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/preview/PickPreload.ts
// (its Select tool: the outline and label, Shift to add, the editor and its keys; its Region,
// Draw and Erase tools with `normalizeRect`, `pathFromPoints`, `strokeBounds`, `unionRects` and
// the marquee's selection), AnnotationKeyboard.ts and AnnotationIds.ts. The preview's own preload
// in every webview the app hosts (docs/plans/desktop.md, D1491, D1690): sandboxed and isolated,
// it draws only while the user annotates, in a closed shadow root. Built into one CommonJS
// file, as the app's preload.
import { ipcRenderer } from "electron";

import { GUEST_CHANNELS } from "@jhin/desktop-api/channels";

import {
  inside,
  isUsableRect,
  normalizeRect,
  pathFromPoints,
  strokeBounds,
  unionRects,
  type Point,
  type Rect,
} from "./preview/annotation-geometry.ts";

/** T3's marquee limit, kept for clicks. */
const MAX_ELEMENTS = 20;
/** The payload's bounds (`PreviewAnnotation`, D1691). */
const MAX_REGIONS = 20;
const MAX_STROKES = 50;
const MAX_STROKE_POINTS = 2000;
/** T3's stroke: 4 px, in the overlay's colour. */
const STROKE_WIDTH = 4;
const STROKE_COLOR = "#3b82f6";

interface Picked {
  readonly element: Element;
  readonly outline: HTMLDivElement;
}

interface Region {
  readonly id: string;
  readonly rect: Rect;
  readonly box: HTMLDivElement;
}

interface Stroke {
  readonly id: string;
  points: Point[];
  bounds: Rect;
  readonly path: SVGPathElement;
}

/** T3's tools: Select, Region (its `marquee`), Draw and Erase (D1690). */
type Tool = "select" | "marquee" | "draw" | "erase";

const TOOLS: readonly (readonly [Tool, string, string, string])[] = [
  ["select", "Select", "Select elements (V)", "v"],
  ["marquee", "Region", "Draw a region or marquee-select elements (R)", "r"],
  ["draw", "Draw", "Draw freehand (D)", "d"],
  ["erase", "Erase", "Remove an annotation target (E)", "e"],
];

/** T3's `AnnotationIds`: unique within the page load. */
const pageLoad = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) =>
  byte.toString(16).padStart(2, "0"),
).join("");
let sequence = 0;
const nextId = (kind: string) => `${kind}_${pageLoad}_${(sequence += 1)}`;
const annotationId = () => nextId("annotation");

/** A CSS selector that finds the element again: its id, else a short `nth-of-type` path. */
function selectorOf(element: Element): string {
  if (element.id !== "" && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) {
    return `#${CSS.escape(element.id)}`;
  }
  const parts: string[] = [];
  let current: Element | null = element;
  while (current !== null && current !== document.documentElement && parts.length < 5) {
    const tag = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    const same =
      parent === null
        ? []
        : Array.from(parent.children).filter((each) => each.tagName === current!.tagName);
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(current) + 1})` : tag);
    if (current.id !== "") {
      parts[0] = `#${CSS.escape(current.id)}`;
      break;
    }
    current = parent;
  }
  return parts.join(" > ");
}

/** T3's `AnnotationKeyboard`: Enter attaches, Cmd/Ctrl+Enter sends, Shift or IME does nothing. */
function submission(event: KeyboardEvent, sendEnabled: boolean): "attach" | "send" | null {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey) return sendEnabled ? "send" : null;
  return "attach";
}

const STYLE = `
:host { all: initial; }
.outline { position: fixed; pointer-events: none; border: 2px solid #3b82f6; background: rgba(59,130,246,.08); border-radius: 3px; box-sizing: border-box; }
.outline.hover { border-style: dashed; background: transparent; }
.label { position: absolute; left: -2px; top: -22px; padding: 1px 6px; border-radius: 4px; background: #3b82f6; color: #fff; font: 500 11px/18px system-ui, sans-serif; white-space: nowrap; }
.editor { position: fixed; pointer-events: auto; width: 300px; padding: 8px; border-radius: 10px; background: #fff; color: #111; box-shadow: 0 8px 30px rgba(0,0,0,.25); border: 1px solid rgba(0,0,0,.12); font: 13px/1.4 system-ui, sans-serif; display: flex; flex-direction: column; gap: 6px; }
.editor textarea { resize: none; height: 64px; border: 1px solid rgba(0,0,0,.15); border-radius: 6px; padding: 6px; font: inherit; color: inherit; background: transparent; outline: none; }
.editor .row { display: flex; justify-content: flex-end; }
.editor button { border: 0; border-radius: 6px; padding: 4px 12px; background: #2563eb; color: #fff; font: 500 12px/18px system-ui, sans-serif; cursor: pointer; }
.editor button:disabled { opacity: .6; cursor: default; }
.toolbar { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); pointer-events: auto; display: flex; gap: 2px; padding: 4px; border-radius: 8px; background: #fff; color: #111; border: 1px solid rgba(0,0,0,.12); box-shadow: 0 8px 30px rgba(0,0,0,.2); font: 500 13px/20px system-ui, sans-serif; }
.toolbar button { border: 0; border-radius: 6px; padding: 4px 10px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.toolbar button[aria-pressed="true"] { background: rgba(59,130,246,.12); color: #2563eb; }
.region, .marquee { position: fixed; pointer-events: none; border: 2px solid #3b82f6; background: rgba(59,130,246,.06); border-radius: 3px; box-sizing: border-box; }
.marquee { border-style: dashed; }
svg { position: fixed; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
@media (prefers-color-scheme: dark) { .editor, .toolbar { background: #1c1c1c; color: #f5f5f5; border-color: rgba(255,255,255,.12); } .editor textarea { border-color: rgba(255,255,255,.2); } .toolbar button[aria-pressed="true"] { color: #93c5fd; } }
`;

let active: { stop(): void } | undefined;

function start(sendEnabled: boolean): void {
  active?.stop();
  const host = document.createElement("jhin-annotation");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  root.append(style);
  // The strokes below the boxes and the chrome.
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  root.append(svg);
  const hover = document.createElement("div");
  hover.className = "outline hover";
  hover.style.display = "none";
  const marquee = document.createElement("div");
  marquee.className = "marquee";
  marquee.style.display = "none";
  root.append(hover, marquee);
  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Annotation tools");
  const toolButtons = new Map<Tool, HTMLButtonElement>();
  for (const [candidate, label, title] of TOOLS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", () => choose(candidate));
    toolButtons.set(candidate, button);
    toolbar.append(button);
  }
  root.append(toolbar);
  const editor = document.createElement("div");
  editor.className = "editor";
  editor.style.display = "none";
  const comment = document.createElement("textarea");
  comment.placeholder = "Describe the change…";
  comment.setAttribute("aria-label", "Describe the change…");
  const row = document.createElement("div");
  row.className = "row";
  const attach = document.createElement("button");
  attach.textContent = "Attach";
  attach.title = sendEnabled
    ? "Attach annotation and screenshot (Enter). Send with Cmd/Ctrl+Enter."
    : "Attach annotation and screenshot (Enter)";
  row.append(attach);
  editor.append(comment, row);
  root.append(editor);
  host.style.cssText =
    "position:fixed;inset:0;z-index:2147483646;pointer-events:none;cursor:crosshair";
  document.documentElement.append(host);
  const previousCursor = document.documentElement.style.cursor;
  document.documentElement.style.cursor = "crosshair";

  let tool: Tool = "select";
  const picked: Picked[] = [];
  const regions: Region[] = [];
  const strokes: Stroke[] = [];
  let dragStart: Point | undefined;
  let drawing: Stroke | undefined;
  let editorShown = false;
  let capturing = false;
  const ours = (event: Event) => event.composedPath().includes(host);
  const place = (box: HTMLElement, rect: Rect) => {
    Object.assign(box.style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  };
  const rectOf = (element: Element): Rect => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  };
  const describe = (element: Element) => {
    const id = element.id === "" ? "" : `#${element.id}`;
    return `${element.tagName.toLowerCase()}${id}`;
  };
  const choose = (next: Tool) => {
    tool = next;
    for (const [candidate, button] of toolButtons) {
      button.setAttribute("aria-pressed", String(candidate === tool));
    }
    if (tool !== "select") hover.style.display = "none";
    if (tool !== "marquee") marquee.style.display = "none";
  };
  choose("select");
  const bounds = () =>
    unionRects([
      ...picked.map(({ element }) => rectOf(element)),
      ...regions.map((region) => region.rect),
      ...strokes.map((stroke) => stroke.bounds),
    ]);
  const layout = () => {
    for (const each of picked) place(each.outline, rectOf(each.element));
    const area = bounds();
    if (area === undefined) {
      editor.style.display = "none";
      return;
    }
    editor.style.display = "flex";
    const top = Math.min(window.innerHeight - 130, area.y + area.height + 8);
    editor.style.top = `${Math.max(8, top)}px`;
    editor.style.left = `${Math.max(8, Math.min(window.innerWidth - 316, area.x))}px`;
    // T3's `updateStatus`: the comment takes the focus once, when the first target comes.
    if (!editorShown) {
      editorShown = true;
      comment.focus();
    }
  };
  const outlineFor = (element: Element) => {
    const outline = document.createElement("div");
    outline.className = "outline";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = describe(element);
    outline.append(label);
    root.append(outline);
    place(outline, rectOf(element));
    return outline;
  };
  const pickAt = (x: number, y: number) => {
    const element = document.elementFromPoint(x, y);
    return element === null || element === host ? undefined : element;
  };
  const select = (element: Element, adding: boolean) => {
    const known = picked.findIndex((each) => each.element === element);
    if (!adding) {
      for (const each of picked.splice(0)) each.outline.remove();
      if (known >= 0) return;
    } else if (known >= 0) {
      picked.splice(known, 1)[0]!.outline.remove();
      return;
    }
    if (picked.length >= MAX_ELEMENTS) return;
    picked.push({ element, outline: outlineFor(element) });
  };
  /** T3's marquee selection: leaves, buttons and links whose centres it holds, smallest first. */
  const selectInside = (rect: Rect): number => {
    const found = Array.from(document.querySelectorAll("body *"))
      .filter((element) => !picked.some((each) => each.element === element))
      .map((element) => ({ element, rect: rectOf(element) }))
      .filter(
        ({ element, rect: candidate }) =>
          candidate.width >= 2 &&
          candidate.height >= 2 &&
          inside(rect, candidate.x + candidate.width / 2, candidate.y + candidate.height / 2) &&
          (element.children.length === 0 ||
            element instanceof HTMLButtonElement ||
            element instanceof HTMLAnchorElement ||
            element.getAttribute("role") === "button"),
      )
      .toSorted((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)
      .slice(0, MAX_ELEMENTS - picked.length);
    for (const { element } of found) picked.push({ element, outline: outlineFor(element) });
    return found.length;
  };
  /** T3's Erase: the element, region or stroke under the pointer, the latest first. */
  const eraseAt = (x: number, y: number) => {
    const element = picked.findLastIndex((each) => inside(rectOf(each.element), x, y));
    if (element >= 0) {
      picked.splice(element, 1)[0]!.outline.remove();
      return;
    }
    const region = regions.findLastIndex((each) => inside(each.rect, x, y));
    if (region >= 0) {
      regions.splice(region, 1)[0]!.box.remove();
      return;
    }
    const stroke = strokes.findLastIndex((each) => inside(each.bounds, x, y));
    if (stroke >= 0) strokes.splice(stroke, 1)[0]!.path.remove();
  };

  const swallow = (event: Event) => {
    if (ours(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onMove = (event: PointerEvent) => {
    // A drag whose button came up outside the page ends where the pointer came back.
    if (dragStart !== undefined && event.buttons === 0) {
      onUp(event);
      return;
    }
    if (ours(event) || capturing) {
      hover.style.display = "none";
      return;
    }
    if (tool === "select") {
      const element = pickAt(event.clientX, event.clientY);
      hover.style.display = element === undefined ? "none" : "block";
      if (element !== undefined) place(hover, rectOf(element));
      return;
    }
    if (tool === "marquee" && dragStart !== undefined) {
      marquee.style.display = "block";
      place(marquee, normalizeRect(dragStart.x, dragStart.y, event.clientX, event.clientY));
      return;
    }
    if (tool === "draw" && drawing !== undefined) {
      // Every point of a fast stroke: Chromium sends one move a frame and keeps the rest.
      const moves = event.getCoalescedEvents?.() ?? [];
      for (const move of moves.length > 0 ? moves : [event]) {
        if (drawing.points.length >= MAX_STROKE_POINTS) break;
        drawing.points.push({ x: move.clientX, y: move.clientY });
      }
      drawing.bounds = strokeBounds(drawing.points, STROKE_WIDTH);
      drawing.path.setAttribute("d", pathFromPoints(drawing.points));
    }
  };
  const onDown = (event: PointerEvent) => {
    if (ours(event) || capturing || event.button !== 0) return;
    swallow(event);
    if (tool === "select") {
      const element = pickAt(event.clientX, event.clientY);
      if (element !== undefined) select(element, event.shiftKey);
      layout();
      return;
    }
    if (tool === "erase") {
      eraseAt(event.clientX, event.clientY);
      layout();
      return;
    }
    dragStart = { x: event.clientX, y: event.clientY };
    if (tool === "draw" && strokes.length < MAX_STROKES) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      for (const [name, value] of [
        ["fill", "none"],
        ["stroke", STROKE_COLOR],
        ["stroke-width", String(STROKE_WIDTH)],
        ["stroke-linecap", "round"],
        ["stroke-linejoin", "round"],
      ] as const) {
        path.setAttribute(name, value);
      }
      svg.append(path);
      drawing = {
        id: nextId("stroke"),
        points: [dragStart],
        bounds: strokeBounds([dragStart], STROKE_WIDTH),
        path,
      };
    }
  };
  const onUp = (event: PointerEvent) => {
    if (dragStart === undefined) return;
    swallow(event);
    if (tool === "marquee") {
      const rect = normalizeRect(dragStart.x, dragStart.y, event.clientX, event.clientY);
      marquee.style.display = "none";
      if (isUsableRect(rect) && selectInside(rect) === 0 && regions.length < MAX_REGIONS) {
        const box = document.createElement("div");
        box.className = "region";
        place(box, rect);
        root.insertBefore(box, toolbar);
        regions.push({ id: nextId("region"), rect, box });
      }
    } else if (tool === "draw" && drawing !== undefined) {
      // A click draws nothing.
      if (drawing.points.length > 1) strokes.push(drawing);
      else drawing.path.remove();
      drawing = undefined;
    }
    dragStart = undefined;
    layout();
  };
  /** A cancelled pointer (the system took it) leaves no half-drawn stroke or marquee. */
  const onCancel = () => {
    if (dragStart === undefined) return;
    marquee.style.display = "none";
    drawing?.path.remove();
    drawing = undefined;
    dragStart = undefined;
  };
  const submit = (how: "attach" | "send") => {
    const area = bounds();
    if (area === undefined || capturing) return;
    capturing = true;
    attach.disabled = true;
    attach.textContent = "Capturing…";
    const rects = picked.map(({ element }) => rectOf(element));
    // The chrome leaves the picture before it is taken; regions and strokes are what the user
    // drew, so they stay in it (D1690).
    root.querySelectorAll<HTMLElement>(".outline, .editor, .toolbar, .marquee").forEach((node) => {
      node.style.visibility = "hidden";
    });
    ipcRenderer.send(GUEST_CHANNELS.elementPicked, {
      annotation: {
        id: annotationId(),
        pageUrl: location.href.slice(0, 4096),
        pageTitle: document.title.slice(0, 1000),
        comment: comment.value.slice(0, 20_000),
        elements: picked.map(({ element }, index) => ({
          selector: selectorOf(element).slice(0, 2000),
          tagName: element.tagName.toLowerCase(),
          text: ((element as HTMLElement).innerText ?? element.textContent ?? "")
            .trim()
            .slice(0, 2000),
          htmlPreview: element.outerHTML.slice(0, 500),
          rect: rects[index]!,
        })),
        regions: regions.map(({ id, rect }) => ({ id, rect })),
        strokes: strokes.map(({ id, points, bounds: strokeArea }) => ({
          id,
          color: STROKE_COLOR,
          width: STROKE_WIDTH,
          points,
          bounds: strokeArea,
        })),
        createdAt: new Date().toISOString(),
      },
      submission: how,
      cropRect: area,
    });
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      stop();
      ipcRenderer.send(GUEST_CHANNELS.pickCancelled);
      return;
    }
    // T3's keys pick a tool while the focus is on the page, not in the overlay.
    if (ours(event) || event.metaKey || event.ctrlKey || event.altKey) return;
    const next = TOOLS.find(([, , , key]) => key === event.key.toLowerCase());
    if (next === undefined) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    choose(next[0]);
  };
  // On the field itself: a listener outside a closed shadow root never sees inside it.
  comment.addEventListener("keydown", (event) => {
    const how = submission(event, sendEnabled);
    if (how === null) return;
    event.preventDefault();
    submit(how);
  });
  attach.addEventListener("click", () => submit("attach"));
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  for (const type of ["mousedown", "mouseup", "click", "dblclick"] as const) {
    window.addEventListener(type, swallow, true);
  }
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", layout, true);
  window.addEventListener("resize", layout);

  const stop = () => {
    if (active?.stop !== stop) return;
    active = undefined;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    for (const type of ["mousedown", "mouseup", "click", "dblclick"] as const) {
      window.removeEventListener(type, swallow, true);
    }
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", layout, true);
    window.removeEventListener("resize", layout);
    document.documentElement.style.cursor = previousCursor;
    host.remove();
  };
  active = { stop };
}

ipcRenderer.on(GUEST_CHANNELS.startPick, (_event, options: { sendEnabled?: unknown } | undefined) =>
  start(options?.sendEnabled === true),
);
ipcRenderer.on(GUEST_CHANNELS.cancelPick, () => active?.stop());
// The picture is taken: the overlay goes (T3's `ANNOTATION_CAPTURED`).
ipcRenderer.on(GUEST_CHANNELS.annotationCaptured, () => active?.stop());
