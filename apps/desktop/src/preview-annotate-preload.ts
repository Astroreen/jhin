// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/desktop/src/preview/PickPreload.ts
// (its Select tool: the outline and label, Shift to add, the editor and its keys),
// AnnotationKeyboard.ts and AnnotationIds.ts. The preview's own preload in every webview the app
// hosts (docs/plans/desktop.md, D1491): sandboxed and isolated, it draws only while the user
// annotates, in a closed shadow root. Built into one CommonJS file, as the app's preload.
import { ipcRenderer } from "electron";

import { GUEST_CHANNELS } from "@jhin/desktop-api/channels";

/** T3's marquee limit, kept for clicks. */
const MAX_ELEMENTS = 20;

interface Picked {
  readonly element: Element;
  readonly outline: HTMLDivElement;
}

/** T3's `AnnotationIds`: unique within the page load. */
const pageLoad = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) =>
  byte.toString(16).padStart(2, "0"),
).join("");
let sequence = 0;
const annotationId = () => `annotation_${pageLoad}_${(sequence += 1)}`;

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
@media (prefers-color-scheme: dark) { .editor { background: #1c1c1c; color: #f5f5f5; border-color: rgba(255,255,255,.12); } .editor textarea { border-color: rgba(255,255,255,.2); } }
`;

let active: { stop(): void } | undefined;

function start(sendEnabled: boolean): void {
  active?.stop();
  const host = document.createElement("jhin-annotation");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  root.append(style);
  const hover = document.createElement("div");
  hover.className = "outline hover";
  hover.style.display = "none";
  root.append(hover);
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

  const picked: Picked[] = [];
  let capturing = false;
  const ours = (event: Event) => event.composedPath().includes(host);
  const place = (outline: HTMLDivElement, element: Element) => {
    const rect = element.getBoundingClientRect();
    Object.assign(outline.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  };
  const describe = (element: Element) => {
    const id = element.id === "" ? "" : `#${element.id}`;
    return `${element.tagName.toLowerCase()}${id}`;
  };
  const layout = () => {
    for (const each of picked) place(each.outline, each.element);
    const last = picked.at(-1);
    if (last === undefined) {
      editor.style.display = "none";
      return;
    }
    editor.style.display = "flex";
    const rect = last.element.getBoundingClientRect();
    const top = Math.min(window.innerHeight - 130, rect.bottom + 8);
    editor.style.top = `${Math.max(8, top)}px`;
    editor.style.left = `${Math.max(8, Math.min(window.innerWidth - 316, rect.left))}px`;
  };
  const outlineFor = (element: Element) => {
    const outline = document.createElement("div");
    outline.className = "outline";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = describe(element);
    outline.append(label);
    root.append(outline);
    place(outline, element);
    return outline;
  };

  const onMove = (event: MouseEvent) => {
    if (ours(event) || capturing) return;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (element === null || element === host) {
      hover.style.display = "none";
      return;
    }
    hover.style.display = "block";
    place(hover, element);
  };
  const swallow = (event: Event) => {
    if (ours(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onClick = (event: MouseEvent) => {
    if (ours(event) || capturing) return;
    swallow(event);
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (element === null || element === host) return;
    const known = picked.findIndex((each) => each.element === element);
    if (!event.shiftKey) {
      for (const each of picked.splice(0)) each.outline.remove();
      if (known >= 0) {
        layout();
        return;
      }
    } else if (known >= 0) {
      picked.splice(known, 1)[0]!.outline.remove();
      layout();
      return;
    }
    if (picked.length >= MAX_ELEMENTS) return;
    picked.push({ element, outline: outlineFor(element) });
    layout();
    comment.focus();
  };
  const submit = (how: "attach" | "send") => {
    if (picked.length === 0 || capturing) return;
    capturing = true;
    attach.disabled = true;
    attach.textContent = "Capturing…";
    hover.style.display = "none";
    const rects = picked.map(({ element }) => element.getBoundingClientRect());
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    // The outlines and the editor leave the picture before it is taken.
    root.querySelectorAll<HTMLElement>(".outline, .editor").forEach((node) => {
      node.style.visibility = "hidden";
    });
    ipcRenderer.send(GUEST_CHANNELS.elementPicked, {
      annotation: {
        id: annotationId(),
        pageUrl: location.href.slice(0, 4096),
        pageTitle: document.title.slice(0, 1000),
        comment: comment.value.slice(0, 20_000),
        elements: picked.map(({ element }, index) => {
          const rect = rects[index]!;
          return {
            selector: selectorOf(element).slice(0, 2000),
            tagName: element.tagName.toLowerCase(),
            text: ((element as HTMLElement).innerText ?? element.textContent ?? "")
              .trim()
              .slice(0, 2000),
            htmlPreview: element.outerHTML.slice(0, 500),
            rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          };
        }),
        createdAt: new Date().toISOString(),
      },
      submission: how,
      cropRect: { x: left, y: top, width: right - left, height: bottom - top },
    });
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stop();
    ipcRenderer.send(GUEST_CHANNELS.pickCancelled);
  };
  // On the field itself: a listener outside a closed shadow root never sees inside it.
  comment.addEventListener("keydown", (event) => {
    const how = submission(event, sendEnabled);
    if (how === null) return;
    event.preventDefault();
    submit(how);
  });
  attach.addEventListener("click", () => submit("attach"));
  window.addEventListener("mousemove", onMove, true);
  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"] as const) {
    window.addEventListener(type, swallow, true);
  }
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("scroll", layout, true);
  window.addEventListener("resize", layout);

  const stop = () => {
    if (active?.stop !== stop) return;
    active = undefined;
    window.removeEventListener("mousemove", onMove, true);
    for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick"] as const) {
      window.removeEventListener(type, swallow, true);
    }
    window.removeEventListener("click", onClick, true);
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
