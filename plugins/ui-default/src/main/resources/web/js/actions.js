/* Jhin web client runtime chunk — actions.js (T300): modules 6–7 of the
 * former single-file runtime (actions + directives), split verbatim at the
 * module markers. Cross-chunk calls run through the shared Jhin namespace
 * (window.Jhin) exactly as they ran inside the single file. */
(() => {
  "use strict";

  const Jhin = window.Jhin || (window.Jhin = {});

  /* Imports from the previously loaded chunks (core.js, render.js). */
  const {
    jhinFetch, setState, seedState, applyTemplates, applyWhen, UiState,
    stateKeyFor
  } = Jhin;
  const {
    renderPairing, navPushCurrent, showScreen, navGoBack, refreshScreen,
    bootstrap, cachePut, inlineIds, renderScreen, el
  } = Jhin;
  /* module 6: actions */


  const OMIT = {};

  function decodeAttrEntities(text) {
    return text
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  function readActionJson(raw) {
    if (typeof raw !== "string" || raw === "") { return null; }
    try {
      return JSON.parse(raw);
    } catch {
      /* entity-laden source */
    }
    try {
      return JSON.parse(decodeAttrEntities(raw));
    } catch {
      return null;
    }
  }

  function nodeById(id) {
    if (typeof id !== "string" || id === "") { return null; }
    return document.getElementById(id)
      || document.querySelector('[data-jhin-id="' + id.replace(/(["\\])/g, "\\$1") + '"]');
  }

  function boundNumber(raw) {
    if (raw === null || raw === "") { return null; }
    const n = Number(raw);
    return Number.isNaN(n) ? null : n;
  }

  function fieldProblem(field, value) {
    if (!field) { return null; }
    const type = field.getAttribute("data-jhin-type");
    if (type !== "input" && type !== "textarea") { return null; }
    const text = value === undefined || value === null ? "" : String(value);
    const errorText = field.getAttribute("data-jhin-error-text") || "Invalid value";
    if (field.hasAttribute("required") && text === "") { return errorText; }
    if (text === "") { return null; }
    const pattern = field.getAttribute("pattern");
    if (pattern !== null && pattern !== "") {
      let regex = null;
      try {
        regex = new RegExp(pattern);
      } catch {
        regex = null;
      }
      if (regex !== null && !regex.test(text)) { return errorText; }
    }
    const min = boundNumber(field.getAttribute("min"));
    const max = boundNumber(field.getAttribute("max"));
    if (min !== null || max !== null) {
      const asNumber = Number(text);
      const numeric = text.trim() !== "" && !Number.isNaN(asNumber);
      if (numeric) {
        if ((min !== null && asNumber < min) || (max !== null && asNumber > max)) {
          return errorText;
        }
      } else if ((min !== null && text.length < min) || (max !== null && text.length > max)) {
        return errorText;
      }
    }
    return null;
  }

  function setFieldError(field, message) {
    if (!field) { return; }
    field.removeAttribute("aria-invalid");
    field.classList.remove("jhin-invalid");
    const next = field.nextElementSibling;
    if (next && next.classList.contains("jhin-field-error")) { next.remove(); }
    if (message === null) { return; }
    field.setAttribute("aria-invalid", "true");
    field.classList.add("jhin-invalid");
    const note = document.createElement("span");
    note.className = "jhin-field-error";
    note.setAttribute("role", "alert");
    note.textContent = message;
    if (field.parentNode) {
      field.parentNode.insertBefore(note, field.nextSibling);
    }
  }

  function clearFieldErrorByKey(key) {
    document.querySelectorAll(".jhin-invalid").forEach((el) => {
      if (stateKeyFor(el) === key) { setFieldError(el, null); }
    });
  }

  function includeValue(type, value) {
    const missing = value === undefined || value === null;
    if (type === "input" || type === "textarea") { return missing ? "" : String(value); }
    if (type === "checkbox" || type === "switch") { return value === true; }
    if (type === "slider") {
      if (typeof value === "number" && Number.isFinite(value)) { return value; }
      const n = Number(value);
      return missing || Number.isNaN(n) ? 0 : n;
    }
    return missing ? OMIT : value;
  }

  async function serverAction(action, payload) {
    const name = typeof action.name === "string" ? action.name : "";
    let body;
    try {
      const res = await jhinFetch(action.path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: name, payload: payload || {} })
      });
      if (res.status === 401 || res.status === 403) {
        renderPairing();
        return;
      }
      if (!res.ok) {
        console.warn("jhin: action post failed:", action.path, res.status);
        showToast("The action failed. Try again.", "error");
        return;
      }
      body = await res.json();
    } catch (failure) {
      console.warn("jhin: action post failed:", failure);
      showToast("The server is unreachable.", "error");
      return;
    }
    if (body && Array.isArray(body.client)) {
      await runDirectiveList(body.client);
    }
  }

  async function dispatchAction(action, host) {
    if (!action || typeof action !== "object") { return; }
    const path = action.path;
    if (typeof path !== "string" || path === "") {
      const inline = action.client;
      if (Array.isArray(inline) && inline.length > 0) {
        await runDirectiveList(inline);
        return;
      }
      if (typeof action.op === "string" && action.op !== "") {
        await runDirectiveList([action]);
        return;
      }
      console.warn("jhin: ignoring action without a path:", action);
      return;
    }
    const include = Array.isArray(action.include) ? action.include.filter((id) => typeof id === "string") : [];
    let failed = false;
    for (const id of include) {
      const field = nodeById(id);
      const problem = fieldProblem(field, UiState.values[id]);
      setFieldError(field, problem);
      if (problem === null) {
        delete UiState.errors[id];
      } else {
        UiState.errors[id] = problem;
        failed = true;
      }
    }
    if (failed) { return; }
    const payload = {};
    const staticPayload = action.payload;
    if (staticPayload && typeof staticPayload === "object") {
      Object.assign(payload, staticPayload);
    }
    for (const id of include) {
      const field = nodeById(id);
      const value = includeValue(field ? field.getAttribute("data-jhin-type") : null, UiState.values[id]);
      if (value !== OMIT) { payload[id] = value; }
    }
    const message = host ? host.getAttribute("data-jhin-confirm") : null;
    if (message && !(await confirmPrompt(message))) { return; }
    await serverAction(action, payload);
  }

  function actionHostFrom(target) {
    if (!target || typeof target.closest !== "function") { return null; }
    return target.closest("[data-jhin-action]");
  }

  function onActionEvent(event) {
    const host = actionHostFrom(event.target);
    if (!host) { return; }
    event.preventDefault();
    const action = readActionJson(host.getAttribute("data-jhin-action"));
    if (!action) {
      console.warn("jhin: ignoring unparseable action:",
        host.getAttribute("data-jhin-action"));
      return;
    }
    dispatchAction(action, host);
  }

  function initActions(root, overlays) {
    root.addEventListener("click", onActionEvent);
    root.addEventListener("submit", onActionEvent);
    if (overlays) {
      overlays.addEventListener("click", onActionEvent);
      overlays.addEventListener("submit", onActionEvent);
    }
  }

  /* module 7: directives */


  let dialogLayer = null;

  function malformedDirective(op, directive) {
    console.warn("jhin: ignoring malformed directive:", op, directive);
  }

  async function runDirectiveList(list) {
    for (const item of list) {
      if (!item || typeof item !== "object") {
        console.warn("jhin: ignoring malformed directive:", item);
        continue;
      }
      try {
        await runDirective(item);
      } catch (failure) {
        console.warn("jhin: directive failed:", item, failure);
      }
    }
  }

  async function runDirective(directive) {
    const op = directive.op;
    if (typeof op !== "string" || op === "") {
      console.warn("jhin: ignoring directive without an op:", directive);
      return;
    }
    switch (op) {
      case "navigate": {
        const screen = directive.screen;
        if (typeof screen !== "string" || screen === "") { return malformedDirective(op, directive); }
        navPushCurrent();
        await showScreen(screen);
        break;
      }
      case "back":
        await navGoBack();
        break;
      case "replace": {
        const screen = directive.screen;
        if (typeof screen !== "string" || screen === "") { return malformedDirective(op, directive); }
        await showScreen(screen);
        break;
      }
      case "refresh":
        if (Jhin.currentScreenId !== null) {
          refreshScreen(Jhin.currentScreenId);
        }
        break;
      case "reloadBootstrap":
        await bootstrap();
        break;
      case "setToken": {
        const value = directive.value;
        if (typeof value !== "string") { return malformedDirective(op, directive); }
        writeToken(value);
        break;
      }
      case "clearToken":
        writeToken("");
        break;
      case "setServerUrl":
        console.warn("jhin: setServerUrl is not available in the web runtime");
        break;
      case "openProfiles":
        console.warn("jhin: openProfiles is not available in the web runtime");
        break;
      case "toast": {
        const text = directive.text;
        if (typeof text !== "string") { return malformedDirective(op, directive); }
        if (directive.action && typeof directive.action === "object") {
          showUndoNotice(text, directive.action,
            typeof directive.duration === "number" ? directive.duration : 5000);
        } else {
          showToast(text, typeof directive.style === "string" ? directive.style : null);
        }
        break;
      }
      case "dialog": {
        const html = directive.html;
        if (typeof html !== "string") {
          return malformedDirective(op, directive);
        }
        openDialogOverlay(html, typeof directive.kind === "string" ? directive.kind : null);
        break;
      }
      case "dismissDialog":
        closeDialogOverlay();
        break;
      case "setState": {
        const id = directive.id;
        if (typeof id !== "string" || id === "") { return malformedDirective(op, directive); }
        setState(id, directive.value);
        break;
      }
      case "patch": {
        const id = directive.id;
        const html = directive.html;
        if (typeof id !== "string" || typeof html !== "string") { return malformedDirective(op, directive); }
        applyPatch(id, html);
        break;
      }
      case "setScreen": {
        const id = directive.id;
        const html = directive.html;
        if (typeof id !== "string" || typeof html !== "string") { return malformedDirective(op, directive); }
        cachePut(id, html);
        inlineIds.add(id);
        if (Jhin.currentScreenId === id) {
          renderScreen(id, html);
        }
        break;
      }
      case "openUrl": {
        const value = directive.value;
        if (typeof value !== "string") { return malformedDirective(op, directive); }
        window.open(value, "_blank", "noopener");
        break;
      }
      case "undo":
        await serverAction({ path: "/ui/action/undo", name: "undo" }, {});
        break;
      default:
        console.warn("jhin: ignoring unknown directive op:", op);
    }
  }

  function applyPatch(id, html) {
    const target = nodeById(id);
    if (!target) {
      console.warn("jhin: patch target not found:", id);
      return;
    }
    swapInner(target, html);
    seedState();
  }

  function withFocusRestore(el, swap) {
    const active = document.activeElement;
    let key = null;
    let start = null;
    let end = null;
    if (active && el.contains(active)) {
      key = active.getAttribute("data-jhin-id") || active.id || null;
      try {
        start = active.selectionStart;
        end = active.selectionEnd;
      } catch {
        /* not a text control */
      }
    }
    swap();
    if (key === null) { return; }
    const back = nodeById(key);
    if (!back || typeof back.focus !== "function") { return; }
    back.focus();
    if (start !== null && typeof back.setSelectionRange === "function") {
      try {
        back.setSelectionRange(start, end);
      } catch {
        /* selection not restorable */
      }
    }
  }

  function swapInner(el, html) {
    withFocusRestore(el, () => { el.innerHTML = html; });
  }

  function swapOuter(el, html) {
    withFocusRestore(el, () => { el.outerHTML = html; });
  }

  function overlaysRoot() {
    let overlays = document.getElementById("jhin-overlays");
    if (!overlays) {
      overlays = document.createElement("div");
      overlays.id = "jhin-overlays";
      document.body.appendChild(overlays);
    }
    return overlays;
  }

  function confirmPrompt(message) {
    return new Promise((resolve) => {
      const dialog = el("dialog", "jhin-confirm");
      dialog.appendChild(el("p", "jhin-confirm-message", message));
      const actions = el("div", "jhin-confirm-actions");
      const cancel = el("button", "jhin-button jhin-button-text", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", () => dialog.close("cancel"));
      const accept = el("button", "jhin-button jhin-button-primary", "Accept");
      accept.type = "button";
      accept.addEventListener("click", () => dialog.close("accept"));
      actions.appendChild(cancel);
      actions.appendChild(accept);
      dialog.appendChild(actions);
      dialog.addEventListener("close", () => {
        dialog.remove();
        resolve(dialog.returnValue === "accept");
      });
      overlaysRoot().appendChild(dialog);
      dialog.showModal();
      accept.focus();
    });
  }

  function showToast(text, style) {
    let stack = document.querySelector("#jhin-overlays .jhin-toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "jhin-toast-stack";
      overlaysRoot().appendChild(stack);
    }
    const toast = document.createElement("div");
    toast.className = "jhin-toast" + (style === "error" ? " jhin-toast-error" : "");
    toast.setAttribute("role", "status");
    toast.textContent = text;
    stack.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function showUndoNotice(text, action, duration) {
    const notice = el("div", "jhin-undo");
    notice.setAttribute("role", "status");
    notice.appendChild(el("span", "jhin-undo-label", text));
    const undo = el("button", "jhin-toast-action jhin-undo-action", "Undo");
    undo.type = "button";
    undo.addEventListener("click", () => {
      notice.remove();
      dispatchAction(action, null);
    });
    const close = el("button", "jhin-toast-action jhin-undo-close", "Close");
    close.type = "button";
    close.addEventListener("click", () => notice.remove());
    notice.appendChild(undo);
    notice.appendChild(close);
    overlaysRoot().appendChild(notice);
    setTimeout(() => notice.remove(), duration);
  }

  function openDialogOverlay(html, kind) {
    closeDialogOverlay();
    const layer = document.createElement("div");
    layer.className = "jhin-dialog-layer" + (kind === "sheet" ? " jhin-dialog-layer-sheet" : "");
    layer.innerHTML = html;
    overlaysRoot().appendChild(layer);
    dialogLayer = layer;
    seedState();
    applyTemplates(UiState.values);
    applyWhen(UiState.values);
  }

  function closeDialogOverlay() {
    if (dialogLayer !== null) {
      dialogLayer.remove();
      dialogLayer = null;
    }
  }

  /* The shared namespace: functions and consts by value; the one mutable
   * binding other chunks read (dialogLayer) is published as a live accessor
   * so writes below stay visible across chunks. */
  Object.assign(Jhin, {
    nodeById, readActionJson, dispatchAction, runDirectiveList, applyPatch,
    swapInner, swapOuter, closeDialogOverlay, overlaysRoot, showToast,
    clearFieldErrorByKey, initActions
  });
  Object.defineProperty(Jhin, "dialogLayer", {
    get() { return dialogLayer; },
    set(value) { dialogLayer = value; },
    configurable: true
  });
})();
