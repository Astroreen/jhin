/*
 * Jhin web client runtime (HTML wire, contract level 4).
 *
 * One plain ES2022 file, zero dependencies: no imports, no bundler, no
 * framework. Modules 1-5 of the plan only; actions, directives, SSE and the
 * keymap arrive in T204/T205 and are intentionally absent here.
 *
 * Hard rules: no dynamic code loading (the expression surface is a
 * tokenizer plus a recursive-descent parser), no client-side markdown, no
 * WebSocket, and every runtime-owned class or id is jhin- prefixed.
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

  /** Raw Response, so callers can inspect 401/403/426 themselves. */
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
    if (own) {
      return own;
    }
    const name = el.getAttribute("name");
    if (name) {
      return name;
    }
    if (el.id) {
      return el.id;
    }
    const host = el.closest("[data-jhin-id]");
    return host ? host.getAttribute("data-jhin-id") : null;
  }

  /** One control's wire value: string, bool for checkboxes, number for sliders. */
  function readControlValue(el) {
    const tag = el.tagName;
    if (tag === "TEXTAREA") {
      return el.value;
    }
    if (tag === "SELECT") {
      return el.value === "" ? undefined : el.value;
    }
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") {
        return el.checked;
      }
      if (type === "range") {
        return el.value === "" ? null : Number(el.value);
      }
      return el.value;
    }
    return undefined;
  }

  /** Writes the mirror from every rendered control (boot and screen swaps). */
  function seedState() {
    const root = document.getElementById("jhin-root");
    if (!root) {
      return;
    }
    root.querySelectorAll("input, textarea, select").forEach((el) => {
      const key = stateKeyFor(el);
      if (!key) {
        return;
      }
      writeValue(key, readControlValue(el), false);
    });
    root.querySelectorAll(".jhin-segmented").forEach((group) => {
      const key = stateKeyFor(group);
      const active = group.querySelector('.jhin-segment[aria-checked="true"]');
      if (!key || !active) {
        return;
      }
      const value = active.getAttribute("data-jhin-value");
      if (value !== null) {
        writeValue(key, value, false);
      }
    });
  }

  function writeValue(key, value, sync) {
    if (value === undefined) {
      delete UiState.values[key];
    } else {
      UiState.values[key] = value;
    }
    if (sync) {
      syncDom(key, value);
    }
  }

  /** Pushes one mirror value back into every control bound to that key. */
  function syncDom(key, value) {
    const root = document.getElementById("jhin-root");
    if (!root) {
      return;
    }
    root.querySelectorAll("input, textarea, select").forEach((el) => {
      if (stateKeyFor(el) !== key) {
        return;
      }
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (el.tagName === "INPUT" && type === "checkbox") {
        el.checked = value === true || value === "true";
      } else {
        el.value = value === undefined || value === null ? "" : String(value);
      }
    });
    root.querySelectorAll(".jhin-segmented").forEach((group) => {
      if (stateKeyFor(group) !== key) {
        return;
      }
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
    applyTemplates(UiState.values);
    applyWhen(UiState.values);
  }

  function onControlEvent(event) {
    const el = event.target;
    if (!el || !el.tagName) {
      return;
    }
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
      return;
    }
    const key = stateKeyFor(el);
    if (!key) {
      return;
    }
    setState(key, readControlValue(el));
  }

  /** Segmented buttons carry their value in data-jhin-value; only a click selects. */
  function onSegmentClick(event) {
    const target = event.target;
    if (!target || typeof target.closest !== "function") {
      return;
    }
    const seg = target.closest(".jhin-segment");
    if (!seg) {
      return;
    }
    const group = seg.closest(".jhin-segmented");
    if (!group) {
      return;
    }
    const key = stateKeyFor(group);
    const value = seg.getAttribute("data-jhin-value");
    if (!key || value === null) {
      return;
    }
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
   * The section 7 subset: field refs (state.foo or bare foo), !, ==, !=,
   * greater/less comparisons, and/or, parentheses and string/number/bool
   * literals. Tokenizer plus recursive-descent parser; the source string
   * never reaches the JS engine. A parse failure yields null so callers can
   * keep their degradation semantics.
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
            if (nx === undefined) {
              return null;
            }
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
        if (!closed) {
          return null;
        }
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
      if (!left) {
        return null;
      }
      while (peek() && peek().t === "||") {
        pos += 1;
        const right = parseAnd();
        if (!right) {
          return null;
        }
        left = { k: "or", a: left, b: right };
      }
      return left;
    }

    function parseAnd() {
      let left = parseEquality();
      if (!left) {
        return null;
      }
      while (peek() && peek().t === "&&") {
        pos += 1;
        const right = parseEquality();
        if (!right) {
          return null;
        }
        left = { k: "and", a: left, b: right };
      }
      return left;
    }

    function parseEquality() {
      let left = parseComparison();
      if (!left) {
        return null;
      }
      while (peek() && (peek().t === "==" || peek().t === "!=")) {
        const op = peek().t;
        pos += 1;
        const right = parseComparison();
        if (!right) {
          return null;
        }
        left = { k: op === "==" ? "eq" : "ne", a: left, b: right };
      }
      return left;
    }

    function parseComparison() {
      let left = parseUnary();
      if (!left) {
        return null;
      }
      while (peek()
          && (peek().t === ">" || peek().t === ">="
              || peek().t === "<" || peek().t === "<=")) {
        const op = peek().t;
        pos += 1;
        const right = parseUnary();
        if (!right) {
          return null;
        }
        const kind = op === ">" ? "gt" : op === ">=" ? "ge" : op === "<" ? "lt" : "le";
        left = { k: kind, a: left, b: right };
      }
      return left;
    }

    function parseUnary() {
      if (peek() && peek().t === "!") {
        pos += 1;
        const operand = parseUnary();
        if (!operand) {
          return null;
        }
        return { k: "not", a: operand };
      }
      return parsePrimary();
    }

    function parsePrimary() {
      const tok = tokens[pos];
      if (!tok) {
        return null;
      }
      pos += 1;
      if (tok.t === "(") {
        const inner = parseOr();
        if (!inner) {
          return null;
        }
        return accept(")") ? inner : null;
      }
      if (tok.t === "str" || tok.t === "num" || tok.t === "bool") {
        return { k: "lit", v: tok.v };
      }
      if (tok.t === "field") {
        return { k: "field", v: tok.v };
      }
      return null;
    }

    const ast = parseOr();
    if (!ast || pos !== tokens.length) {
      return null;
    }
    return ast;
  }

  /** Field refs: state.foo and bare foo both read the state values map. */
  function resolveField(name, state) {
    let path = name;
    if (path.indexOf("state.") === 0) {
      path = path.slice(6);
    }
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
    if (node.k === "lit") {
      return node.v;
    }
    if (node.k === "field") {
      return resolveField(node.v, state);
    }
    if (node.k === "not") {
      const v = runNode(node.a, state);
      return typeof v === "boolean" ? !v : null;
    }
    if (node.k === "and" || node.k === "or") {
      const a = runNode(node.a, state);
      if (typeof a !== "boolean") {
        return null;
      }
      if (node.k === "and" && a === false) {
        return false;
      }
      if (node.k === "or" && a === true) {
        return true;
      }
      const b = runNode(node.b, state);
      return typeof b === "boolean" ? b : null;
    }
    if (node.k === "eq" || node.k === "ne") {
      const a = runNode(node.a, state);
      const b = runNode(node.b, state);
      if (a === null || b === null) {
        return null;
      }
      if (a === b) {
        return node.k === "eq";
      }
      if (typeof a !== typeof b) {
        return null;
      }
      return node.k === "ne";
    }
    const a = runNode(node.a, state);
    const b = runNode(node.b, state);
    const bothNum = typeof a === "number" && typeof b === "number";
    const bothStr = typeof a === "string" && typeof b === "string";
    if (!bothNum && !bothStr) {
      return null;
    }
    if (node.k === "gt") {
      return a > b;
    }
    if (node.k === "ge") {
      return a >= b;
    }
    if (node.k === "lt") {
      return a < b;
    }
    return a <= b;
  }

  /** The expression surface: value out, or null on any parse failure. */
  function runExpr(exprString, state) {
    const tokens = tokenize(String(exprString));
    if (tokens === null) {
      return null;
    }
    const ast = parseTokens(tokens);
    if (ast === null) {
      return null;
    }
    return runNode(ast, state || {});
  }

  /* === module 4: interpolate ========================================== */

  /** Splits a raw template into literal and ${...} expression parts. */
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
    if (buf !== "") {
      parts.push({ lit: buf });
    }
    return parts;
  }

  /** Rewrites every [data-jhin-template] textContent from the state mirror. */
  function applyTemplates(state) {
    const root = document.getElementById("jhin-root");
    if (!root) {
      return;
    }
    root.querySelectorAll("[data-jhin-template]").forEach((el) => {
      const raw = el.getAttribute("data-jhin-template");
      if (raw === null) {
        return;
      }
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
    const root = document.getElementById("jhin-root");
    if (!root) {
      return;
    }
    root.querySelectorAll("[data-jhin-when]").forEach((el) => {
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
  const screenCache = new Map();
  const inlineIds = new Set();
  let currentScreenId = null;

  /** The ingested bootstrap payload (recorded, mostly consumed in T204+). */
  const bootData = {
    screens: [],
    fallbacks: { offline: null, error: null },
    entry: null,
    theme: null,
    tokens: null,
    density: null,
    keymap: [],
    screenEndpoint: "/ui/screen/{id}",
    shell: null
  };

  function cachePut(id, html) {
    if (screenCache.has(id)) {
      screenCache.delete(id);
    }
    screenCache.set(id, html);
    while (screenCache.size > SCREEN_CACHE_MAX) {
      screenCache.delete(screenCache.keys().next().value);
    }
  }

  function screenPath(id) {
    const template = bootData.screenEndpoint || "/ui/screen/{id}";
    return template.replace("{id}", encodeURIComponent(id));
  }

  /** Paints one screen: server HTML is final, so innerHTML with no hydration. */
  function renderScreen(id, html) {
    const root = document.getElementById("jhin-root");
    if (!root) {
      return;
    }
    root.innerHTML = html;
    currentScreenId = id;
    seedState();
    applyTemplates(UiState.values);
    applyWhen(UiState.values);
  }

  /** Background refresh: fresh HTML replaces the cache and the display. */
  function refreshScreen(id) {
    request(screenPath(id), { method: "GET" })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload) => {
        if (!payload || typeof payload.html !== "string") {
          return;
        }
        cachePut(id, payload.html);
        if (currentScreenId === id) {
          renderScreen(id, payload.html);
        }
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
      if (!inlineIds.has(id)) {
        refreshScreen(id);
      }
      return;
    }
    try {
      const res = await request(screenPath(id), { method: "GET" });
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
    if (!root) {
      return;
    }
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
    if (!root) {
      return;
    }
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

  /*
   * The pairing fallback: the one client-owned surface (plan section 7).
   * A server that will not talk to us cannot send a screen, so the enroll
   * form is built here and never server-driven. The action name is a stub
   * until T204.7 refines it.
   */
  function renderPairing() {
    const root = document.getElementById("jhin-root");
    if (!root) {
      return;
    }
    root.textContent = "";
    currentScreenId = null;

    const form = document.createElement("form");
    form.className = "jhin-pair-form";

    const label = document.createElement("label");
    label.setAttribute("for", "jhin-pair-code");
    label.textContent = "Enrollment code";

    const input = document.createElement("input");
    input.id = "jhin-pair-code";
    input.className = "jhin-input";
    input.type = "text";
    input.name = "code";
    input.autocomplete = "off";

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "jhin-button jhin-button-primary";
    submit.textContent = "Pair";

    form.appendChild(label);
    form.appendChild(input);
    form.appendChild(submit);
    form.addEventListener("submit", submitPairing);
    root.appendChild(form);
    input.focus();
  }

  async function submitPairing(event) {
    event.preventDefault();
    const input = document.getElementById("jhin-pair-code");
    const code = input ? input.value : "";
    try {
      const res = await jhinFetch("/ui/action/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enroll", payload: { code: code } })
      });
      if (res.ok) {
        bootstrap();
      }
    } catch (failure) {
      /* stay on the pairing form */
    }
  }

  /** The runtime-owned chrome: the two mount points and the state listeners. */
  function shell() {
    let root = document.getElementById("jhin-root");
    if (!root) {
      root = document.createElement("div");
      root.id = "jhin-root";
      document.body.appendChild(root);
    }
    if (!document.getElementById("jhin-overlays")) {
      const overlays = document.createElement("div");
      overlays.id = "jhin-overlays";
      document.body.appendChild(overlays);
    }
    initState(root);
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
