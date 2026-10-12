/* Jhin web client runtime chunk — core.js (T300): modules 1–4 of the former
 * single-file runtime (transport, state, expr, interpolate), split verbatim at
 * the module markers. Zero dependencies, no dynamic code loading, no
 * WebSocket; every runtime-owned class or id is jhin-prefixed. Cross-chunk
 * calls run through the shared Jhin namespace (window.Jhin) exactly as they
 * ran inside the single file. */
(() => {
  "use strict";

  const Jhin = window.Jhin || (window.Jhin = {});

  /* Late-bound forward reference: module 6 (clearFieldErrorByKey) lives in
   * actions.js, which loads after this chunk. The forwarding shim keeps the
   * module bodies below verbatim; it is deliberately not exported. */
  function clearFieldErrorByKey(key) {
    return Jhin.clearFieldErrorByKey(key);
  }
  /* module 1: transport */

  function clientHeaderValue() {
    return "api=4; version="
      + (typeof window.JHIN_VERSION === "string" && window.JHIN_VERSION !== ""
        ? window.JHIN_VERSION : "0.0.0-web")
      + "; schema=5; caps=sse,open_url,secure_storage";
  }

  function readToken() {
    try {
      return window.localStorage.getItem("jhin.token");
    } catch {
      return null;
    }
  }

  function writeToken(value) {
    try {
      if (value === "") {
        window.localStorage.removeItem("jhin.token");
      } else {
        window.localStorage.setItem("jhin.token", value);
      }
    } catch {
      /* storage unavailable */
    }
  }

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

  /* module 2: state */

  const UiState = {
    values: Object.create(null),
    errors: Object.create(null)
  };

  function stateKeyFor(el) {
    const own = el.getAttribute("data-jhin-id");
    if (own) { return own; }
    const name = el.getAttribute("name");
    if (name) { return name; }
    if (el.id) { return el.id; }
    const host = el.closest("[data-jhin-id]");
    return host ? host.getAttribute("data-jhin-id") : null;
  }

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

  /* module 3: expr */


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
      if (two === "==" || two === "!=" || two === ">=" || two === "<=" || two === "&&" || two === "||") {
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
      while (peek() && (peek().t === ">" || peek().t === ">=" || peek().t === "<" || peek().t === "<=")) {
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

  function runExpr(exprString, state) {
    const tokens = tokenize(String(exprString));
    if (tokens === null) { return null; }
    const ast = parseTokens(tokens);
    if (ast === null) { return null; }
    return runNode(ast, state || {});
  }

  /* module 4: interpolate */

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

  /* The shared namespace: functions and consts are published by value (they
   * never change); the module bodies above call across chunks with the same
   * bare names as before. */
  Object.assign(Jhin, {
    clientHeaderValue, readToken, writeToken, jhinFetch,
    UiState, stateKeyFor, readControlValue, seedState, writeValue, syncDom,
    setState, onControlEvent, onSegmentClick, initState,
    isIdentStart, isIdentPart, isDigit, tokenize, parseTokens, resolveField,
    runNode, runExpr, templateParts, applyTemplates, applyWhen
  });
})();
