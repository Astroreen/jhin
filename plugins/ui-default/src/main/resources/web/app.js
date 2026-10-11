/*
 * Jhin web client runtime (HTML wire, contract level 4): one plain ES2022
 * file, zero dependencies. No dynamic code loading (the expression surface
 * is a tokenizer plus a recursive-descent parser), no client-side markdown,
 * no WebSocket; every runtime-owned class or id is jhin- prefixed.
 */
(() => {
  "use strict";

  /* === module 1: transport ============================================ */

  const CLIENT_API = "4";
  const CLIENT_SCHEMA = "5";
  const CLIENT_CAPS = "sse,open_url,secure_storage";

  function clientVersion() {
    return typeof window.JHIN_VERSION === "string" && window.JHIN_VERSION !== ""
      ? window.JHIN_VERSION
      : "0.0.0-web";
  }

  function clientHeaderValue() {
    return "api=" + CLIENT_API
      + "; version=" + clientVersion()
      + "; schema=" + CLIENT_SCHEMA
      + "; caps=" + CLIENT_CAPS;
  }

  function readToken() {
    try {
      return window.localStorage.getItem("jhin.token");
    } catch (failure) {
      return null;
    }
  }

  /** setToken/clearToken storage: an empty value clears the bearer token. */
  function writeToken(value) {
    try {
      if (value === "") {
        window.localStorage.removeItem("jhin.token");
      } else {
        window.localStorage.setItem("jhin.token", value);
      }
    } catch (failure) {
      /* storage unavailable */
    }
  }

  /** fetch wrapper: every request carries X-Jhin-Client and the bearer token. */
  function jhinFetch(path, options) {
    const init = Object.assign({}, options || {});
    const headers = new Headers(init.headers || {});
    headers.set("X-Jhin-Client", clientHeaderValue());
    const token = readToken();
    if (token) {
      headers.set("Authorization", "Bearer " + token);
    }
    init.headers = headers;
    return fetch(path, init);
  }

  function request(path, options) {
    return jhinFetch(path, options);
  }

  async function get(path) {
    const res = await jhinFetch(path, { method: "GET" });
    return res.json();
  }

  async function post(path, body) {
    const res = await jhinFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return res.json();
  }

  /* === module 2: state ================================================ */

  /** The UiState mirror: values plus the inline error map. */
  const UiState = {
    values: Object.create(null),
    errors: Object.create(null)
  };

  /** The binding key of a control: data-jhin-id, else name, else id. */
  function stateKeyFor(el) {
    const own = el.getAttribute("data-jhin-id");
    if (own) { return own; }
    const name = el.getAttribute("name");
    if (name) { return name; }
    if (el.id) { return el.id; }
    const host = el.closest("[data-jhin-id]");
    return host ? host.getAttribute("data-jhin-id") : null;
  }

  /** One control's wire value: string, bool for checkboxes, number for sliders. */
  function readControlValue(el) {
    const tag = el.tagName;
    if (tag === "TEXTAREA") { return el.value; }
    if (tag === "SELECT") { return el.value === "" ? undefined : el.value; }
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") { return el.checked; }
      if (type === "range") { return el.value === "" ? null : Number(el.value); }
      return el.value;
    }
    return undefined;
  }

  /** Writes the mirror from every rendered control (boot and screen swaps). */
  function seedState() {
    document.querySelectorAll("input, textarea, select").forEach((el) => {
      const key = stateKeyFor(el);
      if (!key) { return; }
      writeValue(key, readControlValue(el), false);
    });
    document.querySelectorAll(".jhin-segmented").forEach((group) => {
      const key = stateKeyFor(group);
      const active = group.querySelector('.jhin-segment[aria-checked="true"]');
      if (!key || !active) { return; }
      const value = active.getAttribute("data-jhin-value");
      if (value !== null) { writeValue(key, value, false); }
    });
  }

  function writeValue(key, value, sync) {
    if (value === undefined) {
      delete UiState.values[key];
    } else {
      UiState.values[key] = value;
    }
    if (sync) { syncDom(key, value); }
  }

  /** Pushes one mirror value back into every control bound to that key. */
  function syncDom(key, value) {
    document.querySelectorAll("input, textarea, select").forEach((el) => {
      if (stateKeyFor(el) !== key) { return; }
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (el.tagName === "INPUT" && type === "checkbox") {
        el.checked = value === true || value === "true";
      } else {
        el.value = value === undefined || value === null ? "" : String(value);
      }
    });
    document.querySelectorAll(".jhin-segmented").forEach((group) => {
      if (stateKeyFor(group) !== key) { return; }
      group.querySelectorAll(".jhin-segment").forEach((seg) => {
        const mine = seg.getAttribute("data-jhin-value");
        const on = value !== undefined && value !== null && mine === String(value);
        seg.setAttribute("aria-checked", on ? "true" : "false");
      });
    });
  }

  /** setState: mirror plus DOM, then the module 4 re-pass. */
  function setState(key, value) {
    writeValue(key, value, true);
    delete UiState.errors[key];
    clearFieldErrorByKey(key);
    applyTemplates(UiState.values);
    applyWhen(UiState.values);
  }

  function onControlEvent(event) {
    const el = event.target;
    if (!el || !el.tagName) { return; }
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") { return; }
    const key = stateKeyFor(el);
    if (!key) { return; }
    setState(key, readControlValue(el));
  }

  /** Segmented buttons carry their value in data-jhin-value; only a click selects. */
  function onSegmentClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== "function") { return; }
    const seg = target.closest(".jhin-segment");
    if (!seg) { return; }
    const group = seg.closest(".jhin-segmented");
    if (!group) { return; }
    const key = stateKeyFor(group);
    const value = seg.getAttribute("data-jhin-value");
    if (!key || value === null) { return; }
    setState(key, value);
  }

  function initState(root) {
    root.addEventListener("input", onControlEvent);
    root.addEventListener("change", onControlEvent);
    root.addEventListener("click", onSegmentClick);
    seedState();
  }

  /* === module 3: expr ================================================= */

  /*
   * The section 7 subset: tokenizer plus recursive-descent parser over
   * field refs, !, comparisons, and/or, parens and literals; a parse
   * failure yields null so callers keep their degradation semantics.
   */

  function isIdentStart(ch) {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
  }

  function isIdentPart(ch) {
    return isIdentStart(ch) || (ch >= "0" && ch <= "9");
  }

  function isDigit(ch) {
    return ch >= "0" && ch <= "9";
  }

  function tokenize(src) {
    const tokens = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
      const ch = src[i];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        i += 1;
        continue;
      }
      if (ch === "(" || ch === ")") {
        tokens.push({ t: ch });
        i += 1;
        continue;
      }
      const two = src.slice(i, i + 2);
      if (two === "==" || two === "!=" || two === ">=" || two === "<="
          || two === "&&" || two === "||") {
        tokens.push({ t: two });
        i += 2;
        continue;
      }
      if (ch === "!" || ch === ">" || ch === "<") {
        tokens.push({ t: ch });
        i += 1;
        continue;
      }
      if (ch === "=" || ch === "&" || ch === "|") {
        return null;
      }
      if (ch === '"' || ch === "'") {
        let out = "";
        let j = i + 1;
        let closed = false;
        while (j < n) {
          const c = src[j];
          if (c === "\\") {
            const nx = src[j + 1];
            if (nx === undefined) { return null; }
            out += nx === "n" ? "\n" : nx === "t" ? "\t" : nx;
            j += 2;
            continue;
          }
          if (c === ch) {
            closed = true;
            j += 1;
            break;
          }
          out += c;
          j += 1;
        }
        if (!closed) { return null; }
        tokens.push({ t: "str", v: out });
        i = j;
        continue;
      }
      if (isDigit(ch) || (ch === "-" && isDigit(src[i + 1]))) {
        let j = ch === "-" ? i + 1 : i;
        while (j < n && isDigit(src[j])) {
          j += 1;
        }
        if (j < n && src[j] === ".") {
          j += 1;
          while (j < n && isDigit(src[j])) {
            j += 1;
          }
        }
        tokens.push({ t: "num", v: Number(src.slice(i, j)) });
        i = j;
        continue;
      }
      if (isIdentStart(ch)) {
        let j = i + 1;
        while (j < n && isIdentPart(src[j])) {
          j += 1;
        }
        while (j + 1 < n && src[j] === "." && isIdentStart(src[j + 1])) {
          j += 2;
          while (j < n && isIdentPart(src[j])) {
            j += 1;
          }
        }
        const word = src.slice(i, j);
        if (word === "true") {
          tokens.push({ t: "bool", v: true });
        } else if (word === "false") {
          tokens.push({ t: "bool", v: false });
        } else {
          tokens.push({ t: "field", v: word });
        }
        i = j;
        continue;
      }
      return null;
    }
    return tokens;
  }

  /** or -> and -> equality -> comparison -> unary -> primary. */
  function parseTokens(tokens) {
    let pos = 0;

    function peek() {
      return tokens[pos];
    }

    function accept(type) {
      const tok = tokens[pos];
      if (tok && tok.t === type) {
        pos += 1;
        return true;
      }
      return false;
    }

    function parseOr() {
      let left = parseAnd();
      if (!left) { return null; }
      while (peek() && peek().t === "||") {
        pos += 1;
        const right = parseAnd();
        if (!right) { return null; }
        left = { k: "or", a: left, b: right };
      }
      return left;
    }

    function parseAnd() {
      let left = parseEquality();
      if (!left) { return null; }
      while (peek() && peek().t === "&&") {
        pos += 1;
        const right = parseEquality();
        if (!right) { return null; }
        left = { k: "and", a: left, b: right };
      }
      return left;
    }

    function parseEquality() {
      let left = parseComparison();
      if (!left) { return null; }
      while (peek() && (peek().t === "==" || peek().t === "!=")) {
        const op = peek().t;
        pos += 1;
        const right = parseComparison();
        if (!right) { return null; }
        left = { k: op === "==" ? "eq" : "ne", a: left, b: right };
      }
      return left;
    }

    function parseComparison() {
      let left = parseUnary();
      if (!left) { return null; }
      while (peek()
          && (peek().t === ">" || peek().t === ">="
              || peek().t === "<" || peek().t === "<=")) {
        const op = peek().t;
        pos += 1;
        const right = parseUnary();
        if (!right) { return null; }
        const kind = op === ">" ? "gt" : op === ">=" ? "ge" : op === "<" ? "lt" : "le";
        left = { k: kind, a: left, b: right };
      }
      return left;
    }

    function parseUnary() {
      if (peek() && peek().t === "!") {
        pos += 1;
        const operand = parseUnary();
        if (!operand) { return null; }
        return { k: "not", a: operand };
      }
      return parsePrimary();
    }

    function parsePrimary() {
      const tok = tokens[pos];
      if (!tok) { return null; }
      pos += 1;
      if (tok.t === "(") {
        const inner = parseOr();
        if (!inner) { return null; }
        return accept(")") ? inner : null;
      }
      if (tok.t === "str" || tok.t === "num" || tok.t === "bool") {
        return { k: "lit", v: tok.v };
      }
      if (tok.t === "field") { return { k: "field", v: tok.v }; }
      return null;
    }

    const ast = parseOr();
    if (!ast || pos !== tokens.length) { return null; }
    return ast;
  }

  /** Field refs: state.foo and bare foo both read the state values map. */
  function resolveField(name, state) {
    let path = name;
    if (path.indexOf("state.") === 0) { path = path.slice(6); }
    const parts = path.split(".");
    let cur = state;
    for (let i = 0; i < parts.length; i += 1) {
      if (cur === null || cur === undefined || typeof cur !== "object") {
        return undefined;
      }
      cur = cur[parts[i]];
    }
    return cur;
  }

  function runNode(node, state) {
    if (node.k === "lit") { return node.v; }
    if (node.k === "field") { return resolveField(node.v, state); }
    if (node.k === "not") {
      const v = runNode(node.a, state);
      return typeof v === "boolean" ? !v : null;
    }
    if (node.k === "and" || node.k === "or") {
      const a = runNode(node.a, state);
      if (typeof a !== "boolean") { return null; }
      if (node.k === "and" && a === false) { return false; }
      if (node.k === "or" && a === true) { return true; }
      const b = runNode(node.b, state);
      return typeof b === "boolean" ? b : null;
    }
    if (node.k === "eq" || node.k === "ne") {
      const a = runNode(node.a, state);
      const b = runNode(node.b, state);
      if (a === null || b === null) { return null; }
      if (a === b) { return node.k === "eq"; }
      if (typeof a !== typeof b) { return null; }
      return node.k === "ne";
    }
    const a = runNode(node.a, state);
    const b = runNode(node.b, state);
    const bothNum = typeof a === "number" && typeof b === "number";
    const bothStr = typeof a === "string" && typeof b === "string";
    if (!bothNum && !bothStr) { return null; }
    if (node.k === "gt") { return a > b; }
    if (node.k === "ge") { return a >= b; }
    if (node.k === "lt") { return a < b; }
    return a <= b;
  }

  /** The expression surface: value out, or null on any parse failure. */
  function runExpr(exprString, state) {
    const tokens = tokenize(String(exprString));
    if (tokens === null) { return null; }
    const ast = parseTokens(tokens);
    if (ast === null) { return null; }
    return runNode(ast, state || {});
  }

  /* === module 4: interpolate ========================================== */

  function templateParts(raw) {
    const parts = [];
    let buf = "";
    let i = 0;
    const n = raw.length;
    while (i < n) {
      const ch = raw[i];
      if (ch === "$" && raw[i + 1] === "{") {
        let j = i + 2;
        let quote = null;
        let closed = false;
        while (j < n) {
          const c = raw[j];
          if (quote) {
            if (c === "\\") {
              j += 2;
              continue;
            }
            if (c === quote) {
              quote = null;
            }
            j += 1;
            continue;
          }
          if (c === '"' || c === "'") {
            quote = c;
            j += 1;
            continue;
          }
          if (c === "}") {
            closed = true;
            break;
          }
          j += 1;
        }
        if (!closed) {
          buf += raw.slice(i);
          i = n;
          break;
        }
        if (buf !== "") {
          parts.push({ lit: buf });
          buf = "";
        }
        parts.push({ expr: raw.slice(i + 2, j) });
        i = j + 1;
        continue;
      }
      buf += ch;
      i += 1;
    }
    if (buf !== "") { parts.push({ lit: buf }); }
    return parts;
  }

  /** Rewrites every [data-jhin-template] textContent from the state mirror. */
  function applyTemplates(state) {
    document.querySelectorAll("[data-jhin-template]").forEach((el) => {
      const raw = el.getAttribute("data-jhin-template");
      if (raw === null) { return; }
      let out = "";
      templateParts(raw).forEach((part) => {
        if (part.lit !== undefined) {
          out += part.lit;
          return;
        }
        const value = runExpr(part.expr, state);
        if (value === null || value === undefined) {
          out += "${" + part.expr + "}";
        } else {
          out += String(value);
        }
      });
      el.textContent = out;
    });
  }

  /** Toggles [hidden] from [data-jhin-when]; only an explicit false hides. */
  function applyWhen(state) {
    document.querySelectorAll("[data-jhin-when]").forEach((el) => {
      const result = runExpr(el.getAttribute("data-jhin-when"), state);
      if (result === false) {
        el.setAttribute("hidden", "hidden");
      } else {
        el.removeAttribute("hidden");
      }
    });
  }

  /* === module 5: screens + shell ====================================== */

  const SCREEN_CACHE_MAX = 50;
  const NAV_STACK_MAX = 50;
  const screenCache = new Map();
  const inlineIds = new Set();
  const navStack = [];
  let currentScreenId = null;

  const bootData = {
    screens: [],
    fallbacks: { offline: null, error: null },
    entry: null,
    theme: null,
    tokens: null,
    density: null,
    keymap: [],
    palette: [],
    screenEndpoint: "/ui/screen/{id}",
    shell: null
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

  /** back: an empty stack is a no-op. */
  async function navGoBack() {
    if (navStack.length === 0) { return; }
    await showScreen(navStack.pop());
  }

  function screenPath(id) {
    const template = bootData.screenEndpoint || "/ui/screen/{id}";
    return template.replace("{id}", encodeURIComponent(id));
  }

  /** Paints one screen: server HTML is final, so innerHTML with no hydration. */
  function renderScreen(id, html) {
    const root = document.getElementById("jhin-root");
    if (!root) { return; }
    root.innerHTML = html;
    currentScreenId = id;
    seedState();
    applyTemplates(UiState.values);
    applyWhen(UiState.values);
  }

  /** Background refresh: fresh HTML replaces the cache and the display. */
  function refreshScreen(id) {
    request(screenPath(id), { method: "GET" })
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

  /** Cached screens paint immediately; inline ids are never re-fetched. */
  async function showScreen(id) {
    const cached = screenCache.get(id);
    if (typeof cached === "string") {
      renderScreen(id, cached);
      if (!inlineIds.has(id)) { refreshScreen(id); }
      return;
    }
    try {
      const res = await request(screenPath(id), { method: "GET" });
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
    } catch (failure) {
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
    bootData.screens = list;
    list.forEach((entry) => {
      if (!entry || typeof entry.id !== "string" || typeof entry.html !== "string") {
        return;
      }
      cachePut(entry.id, entry.html);
      inlineIds.add(entry.id);
    });
    const fallbacks = payload.fallbacks && typeof payload.fallbacks === "object"
      ? payload.fallbacks : {};
    bootData.fallbacks.offline = typeof fallbacks.offline === "string"
      ? fallbacks.offline : null;
    bootData.fallbacks.error = typeof fallbacks.error === "string"
      ? fallbacks.error : null;
    bootData.entry = typeof payload.entry === "string" ? payload.entry : null;
    bootData.theme = payload.theme && typeof payload.theme === "object"
      ? payload.theme : null;
    // Recorded only: the token CSS is already inlined in the document.
    bootData.tokens = payload.tokens && typeof payload.tokens === "object"
      ? payload.tokens : null;
    bootData.density = typeof payload.density === "string" ? payload.density : null;
    bootData.keymap = Array.isArray(payload.keymap) ? payload.keymap : [];
    bootData.palette = Array.isArray(payload.palette) ? payload.palette : [];
    keymapCache = null;
    bootData.screenEndpoint = typeof payload.screenEndpoint === "string"
      ? payload.screenEndpoint : "/ui/screen/{id}";
    bootData.shell = payload.shell && typeof payload.shell === "object"
      ? payload.shell : null;

    applyTheme(bootData.theme, bootData.density);

    if (payload.empty === true) {
      renderNotice(typeof payload.message === "string"
        ? payload.message
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
      res = await request("/_jhin/bootstrap", { method: "GET" });
    } catch (failure) {
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
    } catch (failure) {
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

  /*
   * The pairing fallback: the one client-owned surface (docs/web-client.md
   * section 7). Submit posts the enroll action (payload `code` +
   * `deviceName`); success stores the setToken value and re-runs
   * bootstrap, a refusal keeps the form and shows the message inline.
   */
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

  /** Text of one HTML fragment: tags stripped, rendered as plain text. */
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
    } catch (failure) {
      showPairError("The server is unreachable. Try again.");
      return;
    }
    let body = null;
    try {
      body = await res.json();
    } catch (failure) {
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

  /* === module 6: actions =============================================== */

  /*
   * The section 3 dispatch order: validate the included inputs (zero
   * round-trips on failure), merge the payload (include wins, typed per
   * field kind), run confirm, post {action, payload}, run the response's
   * client directives.
   */

  const OMIT = {};

  function decodeAttrEntities(text) {
    return text
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  /** Parses one data-jhin-action value (entity pass for double-encoded text). */
  function readActionJson(raw) {
    if (typeof raw !== "string" || raw === "") { return null; }
    try {
      return JSON.parse(raw);
    } catch (first) {
      /* entity-laden source */
    }
    try {
      return JSON.parse(decodeAttrEntities(raw));
    } catch (second) {
      return null;
    }
  }

  /** The addressed node: the id attribute, else the data-jhin-id protocol. */
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

  /** One field's inline error, or null when valid (section 3). */
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
      } catch (failure) {
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

  /** Sets (or with null clears) the inline error of one control. */
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

  /** Drops the inline error of every control bound to one state key. */
  function clearFieldErrorByKey(key) {
    document.querySelectorAll(".jhin-invalid").forEach((el) => {
      if (stateKeyFor(el) === key) { setFieldError(el, null); }
    });
  }

  /**
   * The typed include value (section 3): input/textarea -> string,
   * checkbox/switch -> bool, slider -> double; OMIT drops the key.
   */
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

  /** Posts {action, payload} and runs the response's client directives. */
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
    const include = Array.isArray(action.include)
      ? action.include.filter((id) => typeof id === "string")
      : [];
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
      const value = includeValue(
        field ? field.getAttribute("data-jhin-type") : null,
        UiState.values[id]);
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

  function onActionClick(event) {
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

  function onActionSubmit(event) {
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
    root.addEventListener("click", onActionClick);
    root.addEventListener("submit", onActionSubmit);
    if (overlays) {
      overlays.addEventListener("click", onActionClick);
      overlays.addEventListener("submit", onActionSubmit);
    }
  }

  /* === module 7: directives ============================================ */

  /*
   * The seventeen ops of section 4; the three level-4 shapes (patch,
   * setScreen, dialog) carry an html fragment. An unknown op is ignored
   * with a console warning, never thrown.
   */

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
        if (currentScreenId !== null) {
          refreshScreen(currentScreenId);
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
        if (currentScreenId === id) {
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

  /** patch(id, html): the innerHTML swap of section 9.5. */
  function applyPatch(id, html) {
    const target = nodeById(id);
    if (!target) {
      console.warn("jhin: patch target not found:", id);
      return;
    }
    swapInner(target, html);
    seedState();
  }

  /** Section 9.5: innerHTML swap keeping focus and the text selection. */
  function swapInner(el, html) {
    const active = document.activeElement;
    let key = null;
    let start = null;
    let end = null;
    if (active && el.contains(active)) {
      key = active.getAttribute("data-jhin-id") || active.id || null;
      try {
        start = active.selectionStart;
        end = active.selectionEnd;
      } catch (failure) {
        /* not a text control */
      }
    }
    el.innerHTML = html;
    if (key === null) { return; }
    const back = nodeById(key);
    if (!back || typeof back.focus !== "function") { return; }
    back.focus();
    if (start !== null && typeof back.setSelectionRange === "function") {
      try {
        back.setSelectionRange(start, end);
      } catch (failure) {
        /* selection not restorable */
      }
    }
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

  /** The runtime confirm dialog: Escape cancels, Accept accepts. */
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

  /** The undo notice (T98): label + Undo + close card for its window. */
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
    layer.className = "jhin-dialog-layer"
      + (kind === "sheet" ? " jhin-dialog-layer-sheet" : "");
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

  /* === module 9: keymap ================================================ */

  /*
   * Section 4.1 keybinding runtime: chord vocabulary (mod = Cmd on macOS,
   * Ctrl elsewhere), live command contexts, last-match-wins over the
   * bootstrap keymap merged with the localStorage overrides, and a command
   * table. Only handled chords are preventDefault-ed.
   */

  const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

  const KEY_ALIASES = {
    arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right",
    esc: "escape", " ": "space", spacebar: "space", del: "delete"
  };

  const KEY_TOKENS = new Set();
  "enter escape tab space backspace delete up down left right home end pageup pagedown"
    .split(" ").forEach((token) => KEY_TOKENS.add(token));
  for (let i = 0; i < 36; i += 1) {
    KEY_TOKENS.add(i < 26 ? String.fromCharCode(97 + i) : String(i - 26));
  }
  for (let i = 1; i <= 12; i += 1) {
    KEY_TOKENS.add("f" + i);
  }
  KEY_TOKENS.add("[");
  KEY_TOKENS.add("]");

  function chordId(mods, key) {
    return (mods.ctrl ? "ctrl+" : "") + (mods.alt ? "alt+" : "")
      + (mods.shift ? "shift+" : "") + (mods.meta ? "meta+" : "") + key;
  }

  /** Chord spec to canonical id; null (never throws) for malformed specs. */
  function parseChord(spec) {
    if (typeof spec !== "string") { return null; }
    const parts = spec.split("+").map((part) => part.trim().toLowerCase());
    const key = KEY_ALIASES[parts[parts.length - 1]] || parts[parts.length - 1];
    if (!KEY_TOKENS.has(key)) { return null; }
    const mods = { ctrl: false, alt: false, shift: false, meta: false };
    for (let i = 0; i < parts.length - 1; i += 1) {
      const mod = parts[i];
      if (mod === "mod") {
        mods[IS_MAC ? "meta" : "ctrl"] = true;
      } else if (mod === "ctrl" || mod === "control") {
        mods.ctrl = true;
      } else if (mod === "alt" || mod === "shift" || mod === "meta") {
        mods[mod] = true;
      } else {
        return null;
      }
    }
    return chordId(mods, key);
  }

  function chordFromEvent(event) {
    const raw = event.key;
    if (!raw || raw === "Shift" || raw === "Control" || raw === "Alt"
        || raw === "Meta") { return null; }
    const key = KEY_ALIASES[raw.toLowerCase()] || raw.toLowerCase();
    return KEY_TOKENS.has(key) ? chordId({
      ctrl: event.ctrlKey === true, alt: event.altKey === true,
      shift: event.shiftKey === true, meta: event.metaKey === true
    }, key) : null;
  }

  let keymapCache = null;

  /** Override rules from the chord->action map [{key, command, when, action}]. */
  function readKeyOverrides() {
    let raw = null;
    try {
      raw = window.localStorage.getItem("jhin.keybindings");
    } catch (failure) {
      return [];
    }
    if (!raw) { return []; }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (failure) {
      console.warn("jhin: ignoring unparseable jhin.keybindings");
      return [];
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn("jhin: ignoring jhin.keybindings of unknown shape");
      return [];
    }
    const out = [];
    Object.keys(parsed).forEach((chord) => {
      const value = parsed[chord];
      if (!value || typeof value !== "object") {
        if (typeof value === "string") { out.push({ key: chord, command: value }); }
        return;
      }
      out.push({
        key: chord,
        command: typeof value.command === "string" && value.command !== ""
          ? value.command : null,
        when: typeof value.when === "string" && value.when !== ""
          ? value.when : null,
        action: value.action && typeof value.action === "object" ? value.action
          : (Array.isArray(value.client) || typeof value.path === "string"
            || typeof value.op === "string") ? value : null
      });
    });
    return out;
  }

  function normalizeRule(raw) {
    if (!raw || typeof raw !== "object") { return null; }
    const chord = parseChord(raw.key);
    if (chord === null) { return null; }
    return {
      chord: chord,
      command: typeof raw.command === "string" && raw.command !== ""
        ? raw.command : null,
      when: typeof raw.when === "string" && raw.when !== "" ? raw.when : null,
      action: raw.action && typeof raw.action === "object" ? raw.action : null
    };
  }

  /**
   * The effective keymap: defaults with overrides merged; a command-keyed
   * override replaces every default rule of that command (inheriting its
   * `when`) and sits last.
   */
  function effectiveKeymap() {
    if (keymapCache !== null) { return keymapCache; }
    const defaults = (Array.isArray(bootData.keymap) ? bootData.keymap : [])
      .map(normalizeRule).filter((rule) => rule !== null);
    const overrides = readKeyOverrides()
      .map(normalizeRule).filter((rule) => rule !== null);
    const replaced = new Set();
    overrides.forEach((rule) => {
      if (rule.command !== null) { replaced.add(rule.command); }
    });
    const inheritedWhen = new Map();
    defaults.forEach((rule) => {
      if (rule.command !== null && replaced.has(rule.command) && rule.when
          && !inheritedWhen.has(rule.command)) {
        inheritedWhen.set(rule.command, rule.when);
      }
    });
    const merged = defaults.filter(
      (rule) => !(rule.command !== null && replaced.has(rule.command)));
    overrides.forEach((rule) => {
      const inherit = rule.command !== null && !rule.when
        ? inheritedWhen.get(rule.command) : undefined;
      merged.push(inherit !== undefined ? {
        chord: rule.chord, command: rule.command,
        when: inherit, action: rule.action
      } : rule);
    });
    keymapCache = merged;
    return merged;
  }

  /* --- section 4.1 command contexts, computed live per keystroke ------- */

  const NON_TEXT_TYPES = /checkbox|radio|range|button|submit|reset|file|color|image/;

  function keyContexts() {
    const active = document.activeElement;
    const tag = active ? active.tagName : "";
    const type = active && active.getAttribute
      ? (active.getAttribute("type") || "text").toLowerCase() : "";
    const editable = !!active && (tag === "TEXTAREA" || tag === "SELECT"
      || (tag === "INPUT" && !NON_TEXT_TYPES.test(type))
      || active.isContentEditable === true);
    const inside = (sel) => !!active && typeof active.closest === "function"
      && !!active.closest(sel);
    const dialogOpen = dialogLayer !== null
      || !!document.querySelector("#jhin-overlays dialog[open]");
    const ctx = Object.create(null);
    ctx.terminalFocus = inside('[data-jhin-id*="terminal"], [data-jhin-type*="terminal"]');
    ctx.terminalOpen = UiState.values.chat_terminal === true
      || UiState.values.chat_terminal === "true";
    ctx.previewFocus = inside('[data-jhin-id*="preview"]');
    ctx.previewOpen = !!document.querySelector('[data-jhin-id*="preview"]');
    ctx.modelPickerOpen = dialogLayer !== null
      && !!dialogLayer.querySelector('[data-jhin-id*="model"]');
    ctx.usagePageOpen = currentScreenId === "usage";
    ctx.composerFocus = editable
      && inside('[data-jhin-id="composer"], [data-jhin-id="messageInput"]');
    ctx.composerDraft = typeof UiState.values.messageInput === "string"
      && UiState.values.messageInput.trim() !== "";
    ctx.turnRunning = false;
    ctx.editableFocus = editable;
    ctx.isWeb = true;
    ctx.isDesktop = false;
    ctx.sidebarFocus = inside('[data-jhin-type="nav"], [data-jhin-id*="sidebar"], [role="navigation"]');
    ctx.paletteOpen = dialogLayer !== null
      && dialogLayer.classList.contains("jhin-palette-layer");
    ctx.modalOpen = dialogOpen;
    ctx.inputFocus = editable;
    ctx.dialogOpen = dialogOpen;
    ctx.listFocus = inside('[data-jhin-type="list"], [role="list"], [role="listbox"], [role="menu"]');
    return ctx;
  }

  /** Section 4.1 when: unknown names read false; failure degrades to false. */
  function whenHolds(exprString, contexts) {
    const proxy = new Proxy(contexts, {
      get(target, name) {
        return typeof name === "string" && name in target ? target[name] : false;
      }
    });
    return runExpr(exprString, proxy);
  }

  /** Last match wins: the first rule from the end whose chord + when hold. */
  function matchKeyRule(chord, contexts) {
    const rules = effectiveKeymap();
    const typing = contexts.composerFocus || contexts.editableFocus;
    for (let i = rules.length - 1; i >= 0; i -= 1) {
      const rule = rules[i];
      if (rule.chord !== chord) { continue; }
      if (!rule.when) {
        if (typing) { continue; }
        return rule;
      }
      if (whenHolds(rule.when, contexts) === true) { return rule; }
    }
    return null;
  }

  /* --- the client command table --------------------------------------- */

  const PICKER_HOOKS = {
    "modelPicker.toggle": "composer-model-picker",
    "composer.host": "composer-host-picker",
    "composer.effort": "composer-effort-picker",
    "composer.mode": "composer-mode-picker",
    "composer.workspace": "composer-workspace-picker",
    "composer.branch": "composer-branch-picker",
    "composer.previousWorktree": "composer-worktree-picker"
  };

  function clickHook(id) {
    const el = nodeById(id);
    if (el && typeof el.click === "function") {
      el.click();
      return true;
    }
    return false;
  }

  /** The action host whose action JSON carries this name (the send button). */
  function actionByActionName(name) {
    const nodes = document.querySelectorAll("[data-jhin-action]");
    for (let i = 0; i < nodes.length; i += 1) {
      const parsed = readActionJson(nodes[i].getAttribute("data-jhin-action"));
      if (parsed && parsed.name === name) { return { el: nodes[i], action: parsed }; }
    }
    return null;
  }

  /** One command id to runtime behaviour; false = not handled (no swallow). */
  function dispatchCommand(command) {
    if (command === "composer.send" || command === "composer.sendAndNew") {
      const send = actionByActionName("send");
      if (!send) { return false; }
      dispatchAction(send.action, send.el);
      if (command === "composer.sendAndNew") {
        const create = actionByActionName("create-session");
        if (create) { dispatchAction(create.action, create.el); }
      }
      return true;
    }
    if (command === "nav.back" || command === "navigation.back") {
      navGoBack();
      return true;
    }
    if (command === "thread.undo") {
      dispatchAction({ path: "/ui/action/undo", name: "undo" }, null);
      return true;
    }
    if (command === "thread.new" || command === "chat.newWithoutProject") {
      if (clickHook("new-thread") || clickHook("new-session")) { return true; }
      const create = actionByActionName("create-session");
      if (!create) { return false; }
      dispatchAction(create.action, create.el);
      return true;
    }
    if (command === "palette.open") {
      openPalette();
      return true;
    }
    if (PICKER_HOOKS[command]) { return clickHook(PICKER_HOOKS[command]); }
    return false;
  }

  /** The command palette overlay: the bootstrap palette metadata as chrome. */
  function openPalette() {
    closeDialogOverlay();
    const layer = el("div", "jhin-dialog-layer jhin-palette-layer");
    const box = el("div", "jhin-palette");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Command palette");
    const list = el("div", "jhin-palette-list");
    (Array.isArray(bootData.palette) ? bootData.palette : []).forEach((group) => {
      (group && Array.isArray(group.items) ? group.items : []).forEach((item) => {
        if (!item || typeof item.id !== "string" || item.id === "") { return; }
        const row = el("button", "jhin-palette-row");
        row.type = "button";
        row.appendChild(el("span", "jhin-palette-label",
          typeof item.label === "string" ? item.label : item.id));
        if (typeof item.chord === "string" && item.chord !== "") {
          row.appendChild(el("kbd", "jhin-palette-chord", item.chord));
        }
        row.addEventListener("click", () => {
          if (item.demo === true) {
            showToast("Preview only — not available in this build");
            return;
          }
          closeDialogOverlay();
          dispatchCommand(item.id);
        });
        list.appendChild(row);
      });
    });
    box.appendChild(list);
    layer.appendChild(box);
    overlaysRoot().appendChild(layer);
    dialogLayer = layer;
    const first = list.querySelector(".jhin-palette-row");
    if (first) { first.focus(); }
  }

  /** The keydown capture: rule dispatch, then the dialog-layer Escape. */
  function onKeydown(event) {
    if (event.defaultPrevented) { return; }
    const chord = chordFromEvent(event);
    if (chord === null) { return; }
    const contexts = keyContexts();
    const key = chord.slice(chord.lastIndexOf("+") + 1);
    if (key === "f5" || chord === (IS_MAC ? "meta+r" : "ctrl+r")) { return; }
    if (contexts.editableFocus && (chord === "ctrl+c" || chord === "ctrl+v"
        || chord === "ctrl+x" || chord === "ctrl+a" || chord === "meta+c"
        || chord === "meta+v" || chord === "meta+x" || chord === "meta+a")) {
      return;
    }
    if (document.querySelector("#jhin-overlays dialog[open]")) { return; }
    const rule = matchKeyRule(chord, contexts);
    if (!rule) {
      if (chord === "escape" && dialogLayer !== null) {
        closeDialogOverlay();
        event.preventDefault();
      }
      return;
    }
    let handled = false;
    if (rule.action) {
      dispatchAction(rule.action, null);
      handled = true;
    } else if (rule.command) {
      handled = dispatchCommand(rule.command);
    }
    if (handled) { event.preventDefault(); }
  }

  function initKeymap() {
    document.addEventListener("keydown", onKeydown, true);
    window.addEventListener("storage", (event) => {
      if (!event || event.key === null || event.key === "jhin.keybindings") {
        keymapCache = null;
      }
    });
  }

  /** The runtime-owned chrome: the two mount points and the state listeners. */
  function shell() {
    let root = document.getElementById("jhin-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "jhin-root";
      document.body.appendChild(root);
    }
    let overlays = document.getElementById("jhin-overlays");
    if (!overlays) {
      overlays = document.createElement("div");
      overlays.id = "jhin-overlays";
      document.body.appendChild(overlays);
    }
    initState(root);
    initActions(root, overlays);
    initKeymap();
  }

  function boot() {
    shell();
    bootstrap();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
