/* Jhin web client runtime chunk — render.js (T300): module 5 of the former
 * single-file runtime (screens + shell), split verbatim at the module
 * markers. Cross-chunk calls run through the shared Jhin namespace
 * (window.Jhin) exactly as they ran inside the single file. */
(() => {
  "use strict";

  const Jhin = window.Jhin || (window.Jhin = {});

  /* Imports from the previously loaded chunks (core.js). */
  const { jhinFetch, writeToken, seedState, applyTemplates, applyWhen, UiState } = Jhin;

  /* Late-bound forward references: module 8 (syncStreams, openOverview)
   * lives in sse.js, which loads after this chunk. The forwarding shims keep
   * the module body below verbatim; they are deliberately not exported. */
  function syncStreams() {
    return Jhin.syncStreams();
  }

  function openOverview() {
    return Jhin.openOverview();
  }
  /* module 5: screens + shell */

  const SCREEN_CACHE_MAX = 50;
  const NAV_STACK_MAX = 50;
  const screenCache = new Map();
  const inlineIds = new Set();
  const navStack = [];
  let currentScreenId = null;

  const bootData = {
    fallbacks: { offline: null, error: null },
    entry: null,
    theme: null,
    density: null,
    keymap: [],
    palette: [],
    screenEndpoint: "/ui/screen/{id}"
  };

  function cachePut(id, html) {
    if (screenCache.has(id)) {
      screenCache.delete(id);
    }
    screenCache.set(id, html);
    while (screenCache.size > SCREEN_CACHE_MAX) {
      let victim = null;
      for (const key of screenCache.keys()) {
        if (key !== currentScreenId && !inlineIds.has(key)) {
          victim = key;
          break;
        }
      }
      if (victim === null) { return; }
      screenCache.delete(victim);
    }
  }

  function navPushCurrent() {
    if (currentScreenId === null) { return; }
    navStack.push(currentScreenId);
    while (navStack.length > NAV_STACK_MAX) {
      navStack.shift();
    }
  }

  async function navGoBack() {
    if (navStack.length === 0) { return; }
    await showScreen(navStack.pop());
  }

  function screenPath(id) {
    const template = bootData.screenEndpoint || "/ui/screen/{id}";
    return template.replace("{id}", encodeURIComponent(id));
  }

  function renderScreen(id, html) {
    const root = document.getElementById("jhin-root");
    if (!root) { return; }
    root.innerHTML = html;
    currentScreenId = id;
    seedState();
    applyTemplates(UiState.values);
    applyWhen(UiState.values);
    syncStreams();
  }

  function refreshScreen(id) {
    jhinFetch(screenPath(id), { method: "GET" })
      .then((res) => {
        if (res.status === 401 || res.status === 403) {
          renderPairing();
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((payload) => {
        if (!payload || typeof payload.html !== "string") { return; }
        cachePut(id, payload.html);
        if (currentScreenId === id) { renderScreen(id, payload.html); }
      })
      .catch(() => {
        /* the stale copy stays on screen */
      });
  }

  async function showScreen(id) {
    const cached = screenCache.get(id);
    if (typeof cached === "string") {
      renderScreen(id, cached);
      if (!inlineIds.has(id)) { refreshScreen(id); }
      return;
    }
    try {
      const res = await jhinFetch(screenPath(id), { method: "GET" });
      if (res.status === 401 || res.status === 403) {
        renderPairing();
        return;
      }
      const payload = res.ok ? await res.json() : null;
      if (!payload || typeof payload.html !== "string") {
        renderUnavailable();
        return;
      }
      cachePut(id, payload.html);
      renderScreen(id, payload.html);
    } catch {
      renderUnavailable();
    }
  }

  function applyTheme(theme, density) {
    const doc = document.documentElement;
    if (theme && typeof theme.appearance === "string") {
      doc.dataset.appearance = theme.appearance;
    }
    if (typeof density === "string" && density !== "") {
      doc.dataset.density = density;
    }
  }

  function ingest(payload) {
    screenCache.clear();
    inlineIds.clear();
    const list = Array.isArray(payload.screens) ? payload.screens : [];
    list.forEach((entry) => {
      if (!entry || typeof entry.id !== "string" || typeof entry.html !== "string") {
        return;
      }
      cachePut(entry.id, entry.html);
      inlineIds.add(entry.id);
    });
    const fallbacks = payload.fallbacks && typeof payload.fallbacks === "object" ? payload.fallbacks : {};
    bootData.fallbacks.offline = typeof fallbacks.offline === "string" ? fallbacks.offline : null;
    bootData.fallbacks.error = typeof fallbacks.error === "string" ? fallbacks.error : null;
    bootData.entry = typeof payload.entry === "string" ? payload.entry : null;
    bootData.theme = payload.theme && typeof payload.theme === "object" ? payload.theme : null;
    bootData.density = typeof payload.density === "string" ? payload.density : null;
    bootData.keymap = Array.isArray(payload.keymap) ? payload.keymap : [];
    bootData.palette = Array.isArray(payload.palette) ? payload.palette : [];
    Jhin.keymapCache = null;
    bootData.screenEndpoint = typeof payload.screenEndpoint === "string"
      ? payload.screenEndpoint : "/ui/screen/{id}";

    applyTheme(bootData.theme, bootData.density);
    openOverview();

    if (payload.empty === true) {
      renderNotice(typeof payload.message === "string" ? payload.message
        : "This server has no UI plugin installed.");
      return;
    }
    if (bootData.entry !== null && bootData.entry !== "") {
      showScreen(bootData.entry);
      return;
    }
    if (list.length > 0 && typeof list[0].id === "string") {
      showScreen(list[0].id);
      return;
    }
    renderUnavailable();
  }

  async function bootstrap() {
    let res;
    try {
      res = await jhinFetch("/_jhin/bootstrap", { method: "GET" });
    } catch {
      renderOffline();
      return;
    }
    if (res.status === 401 || res.status === 403) {
      renderPairing();
      return;
    }
    if (res.status === 426) {
      renderNotice("This server speaks the HTML UI contract (api=4). Upgrade your client.");
      return;
    }
    if (!res.ok) {
      renderUnavailable();
      return;
    }
    let payload;
    try {
      payload = await res.json();
    } catch {
      renderUnavailable();
      return;
    }
    ingest(payload);
  }

  function renderNotice(text) {
    const root = document.getElementById("jhin-root");
    if (!root) { return; }
    root.textContent = "";
    const note = document.createElement("p");
    note.className = "jhin-notice";
    note.setAttribute("role", "status");
    note.textContent = text;
    root.appendChild(note);
    currentScreenId = null;
  }

  function renderHtmlOr(fallbackHtml, noticeText) {
    const root = document.getElementById("jhin-root");
    if (!root) { return; }
    if (typeof fallbackHtml === "string" && fallbackHtml !== "") {
      root.innerHTML = fallbackHtml;
      currentScreenId = null;
      seedState();
      applyTemplates(UiState.values);
      applyWhen(UiState.values);
      return;
    }
    renderNotice(noticeText);
  }

  function renderOffline() {
    renderHtmlOr(bootData.fallbacks.offline,
      "The server is unreachable. Check the connection and reload the page.");
  }

  function renderUnavailable() {
    renderHtmlOr(bootData.fallbacks.error,
      "This server cannot render a screen right now. Reload the page to retry.");
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) { node.className = cls; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function renderPairing() {
    const root = document.getElementById("jhin-root");
    if (!root) { return; }
    root.textContent = "";
    currentScreenId = null;
    const form = el("form", "jhin-pair-form");
    form.appendChild(el("p", "jhin-surface-title", "Pair this device"));
    const error = el("div", "jhin-banner jhin-pair-error");
    error.id = "jhin-pair-error";
    error.setAttribute("role", "alert");
    error.hidden = true;
    form.appendChild(error);
    const codeInput = pairField(form, "jhin-pair-code", "code", "Enrollment code");
    pairField(form, "jhin-pair-name", "deviceName", "Device name");
    const submit = el("button", "jhin-button jhin-button-primary", "Pair");
    submit.type = "submit";
    form.appendChild(submit);
    form.addEventListener("submit", submitPairing);
    root.appendChild(form);
    syncStreams();
    codeInput.focus();
  }

  function pairField(form, id, name, label) {
    const lab = el("label", null, label);
    lab.setAttribute("for", id);
    const input = el("input", "jhin-input");
    input.id = id;
    input.type = "text";
    input.name = name;
    input.autocomplete = "off";
    form.appendChild(lab);
    form.appendChild(input);
    return input;
  }

  function showPairError(message) {
    const box = document.getElementById("jhin-pair-error");
    if (!box) { return; }
    box.hidden = !message;
    box.textContent = message || "";
  }

  function htmlFragmentText(html) {
    return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  function pairFailureMessage(body) {
    if (body && typeof body.message === "string" && body.message !== "") {
      return body.message;
    }
    const client = body && Array.isArray(body.client) ? body.client : [];
    for (const item of client) {
      if (item && item.op === "patch" && typeof item.html === "string") {
        const text = htmlFragmentText(item.html);
        if (text !== "") { return text; }
      }
    }
    return "Enrollment failed. Check the code and try again.";
  }

  async function submitPairing(event) {
    event.preventDefault();
    const code = (document.getElementById("jhin-pair-code") || { value: "" }).value.trim();
    const deviceName = (document.getElementById("jhin-pair-name") || { value: "" }).value.trim();
    if (code === "" || deviceName === "") {
      showPairError("The enrollment code and a device name are required.");
      return;
    }
    let res;
    try {
      res = await jhinFetch("/ui/action/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enroll", payload: { code: code, deviceName: deviceName } })
      });
    } catch {
      showPairError("The server is unreachable. Try again.");
      return;
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const client = body && Array.isArray(body.client) ? body.client : [];
    const tokenOp = client.find((d) => d && d.op === "setToken" && typeof d.value === "string");
    if (res.ok && tokenOp) {
      writeToken(tokenOp.value);
      showPairError(null);
      bootstrap();
      return;
    }
    showPairError(pairFailureMessage(body));
  }

  /* The shared namespace: functions and consts by value; the one mutable
   * binding other chunks read (currentScreenId) is published as a live
   * accessor so writes below stay visible across chunks. */
  Object.assign(Jhin, {
    SCREEN_CACHE_MAX, NAV_STACK_MAX, screenCache, inlineIds, navStack,
    bootData, cachePut, navPushCurrent, navGoBack, screenPath, renderScreen,
    refreshScreen, showScreen, applyTheme, ingest, bootstrap, renderNotice,
    renderHtmlOr, renderOffline, renderUnavailable, el, renderPairing,
    pairField, showPairError, htmlFragmentText, pairFailureMessage,
    submitPairing
  });
  Object.defineProperty(Jhin, "currentScreenId", {
    get() { return currentScreenId; },
    set(value) { currentScreenId = value; },
    configurable: true
  });
})();
