/* Jhin web client runtime chunk — keymap.js (T300): module 9 of the former
 * single-file runtime (keymap + overrides), split verbatim at the module
 * markers. Cross-chunk calls run through the shared Jhin namespace
 * (window.Jhin) exactly as they ran inside the single file. */
(() => {
  "use strict";

  const Jhin = window.Jhin || (window.Jhin = {});

  /* Imports from the previously loaded chunks (core.js, render.js,
   * actions.js). */
  const { runExpr, UiState } = Jhin;
  const { bootData, navGoBack, el } = Jhin;
  const {
    nodeById, readActionJson, dispatchAction, closeDialogOverlay,
    overlaysRoot, showToast
  } = Jhin;
  /* module 9: keymap */

  /* Section 4.1 keybinding runtime: chords (mod = Cmd on macOS), live
     contexts, last-match-wins, a command table. */

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
    if (!raw || raw === "Shift" || raw === "Control" || raw === "Alt" || raw === "Meta") { return null; }
    const key = KEY_ALIASES[raw.toLowerCase()] || raw.toLowerCase();
    return KEY_TOKENS.has(key) ? chordId({
      ctrl: event.ctrlKey === true, alt: event.altKey === true,
      shift: event.shiftKey === true, meta: event.metaKey === true
    }, key) : null;
  }

  let keymapCache = null;

  /* User keymap overrides: the jhin.keybindings store (sdui.md sec. 8). */
  function readKeyOverrides() {
    let raw = null;
    try { raw = window.localStorage.getItem("jhin.keybindings"); }
    catch { return []; }
    if (!raw) { return []; }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch {
      console.warn("jhin: unparseable jhin.keybindings");
      return [];
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn("jhin: jhin.keybindings is not a map");
      return [];
    }
    const out = [];
    Object.keys(parsed).forEach((spec) => {
      const value = parsed[spec];
      if (parseChord(spec) === null) {
        console.warn("jhin: bad keybinding chord:", spec);
        return;
      }
      const isStr = typeof value === "string" && value !== "";
      const isObj = !!value && typeof value === "object";
      const command = isStr ? value
        : isObj && typeof value.command === "string" && value.command !== "" ? value.command : null;
      const action = isObj
        ? (value.action && typeof value.action === "object" ? value.action
          : (Array.isArray(value.client) || typeof value.path === "string"
            || typeof value.op === "string") ? value : null)
        : null;
      if (command === null && action === null) {
        console.warn("jhin: bad keybinding entry:", spec);
        return;
      }
      out.push({
        key: spec, command: command, when: value.when, action: action
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
      command: typeof raw.command === "string" && raw.command !== "" ? raw.command : null,
      when: typeof raw.when === "string" && raw.when !== "" ? raw.when : null,
      action: raw.action && typeof raw.action === "object" ? raw.action : null
    };
  }

  /* Effective keymap: overrides replace per-command defaults, inherit when. */
  function effectiveKeymap() {
    if (keymapCache !== null) { return keymapCache; }
    const defaults = (Array.isArray(bootData.keymap) ? bootData.keymap : [])
      .map(normalizeRule).filter((rule) => rule !== null);
    const overrides = readKeyOverrides()
      .map(normalizeRule).filter((rule) => rule !== null);
    const replaced = new Map();
    overrides.forEach((rule) => {
      if (rule.command !== null) { replaced.set(rule.command, null); }
    });
    defaults.forEach((rule) => {
      if (rule.command !== null && rule.when && replaced.has(rule.command) && !replaced.get(rule.command)) {
        replaced.set(rule.command, rule.when);
      }
    });
    keymapCache = defaults.filter(
      (rule) => rule.command === null || !replaced.has(rule.command));
    overrides.forEach((rule) => {
      keymapCache.push({
        chord: rule.chord, command: rule.command,
        when: rule.when || replaced.get(rule.command) || null,
        action: rule.action
      });
    });
    return keymapCache;
  }

  const NON_TEXT_TYPES = /checkbox|radio|range|button|submit|reset|file|color|image/;

  function keyContexts() {
    const active = document.activeElement;
    const tag = active ? active.tagName : "";
    const type = active && active.getAttribute ? (active.getAttribute("type") || "text").toLowerCase() : "";
    const editable = !!active && (tag === "TEXTAREA" || tag === "SELECT"
      || (tag === "INPUT" && !NON_TEXT_TYPES.test(type))
      || active.isContentEditable === true);
    const inside = (sel) => !!active && typeof active.closest === "function" && !!active.closest(sel);
    const dialogOpen = Jhin.dialogLayer !== null || !!document.querySelector("#jhin-overlays dialog[open]");
    const ctx = Object.create(null);
    ctx.terminalFocus = inside('[data-jhin-id*="terminal"], [data-jhin-type*="terminal"]');
    ctx.terminalOpen = UiState.values.chat_terminal === true || UiState.values.chat_terminal === "true";
    ctx.previewFocus = inside('[data-jhin-id*="preview"]');
    ctx.previewOpen = !!document.querySelector('[data-jhin-id*="preview"]');
    ctx.modelPickerOpen = Jhin.dialogLayer !== null && !!Jhin.dialogLayer.querySelector('[data-jhin-id*="model"]');
    ctx.usagePageOpen = Jhin.currentScreenId === "usage";
    ctx.composerFocus = editable && inside('[data-jhin-id="composer"], [data-jhin-id="messageInput"]');
    ctx.composerDraft = typeof UiState.values.messageInput === "string"
      && UiState.values.messageInput.trim() !== "";
    ctx.turnRunning = !!document.querySelector('[data-jhin-id$="-working"]');
    ctx.editableFocus = editable;
    ctx.isWeb = true;
    ctx.isDesktop = false;
    ctx.sidebarFocus = inside('[data-jhin-type="nav"], [data-jhin-id*="sidebar"], [role="navigation"]');
    ctx.paletteOpen = Jhin.dialogLayer !== null && Jhin.dialogLayer.classList.contains("jhin-palette-layer");
    ctx.modalOpen = dialogOpen;
    ctx.inputFocus = editable;
    ctx.dialogOpen = dialogOpen;
    ctx.listFocus = inside('[data-jhin-type="list"], [role="list"], [role="listbox"], [role="menu"]');
    return ctx;
  }

  function whenHolds(exprString, contexts) {
    const proxy = new Proxy(contexts, {
      get(target, name) {
        return typeof name === "string" && name in target ? target[name] : false;
      }
    });
    return runExpr(exprString, proxy);
  }

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

  function actionByActionName(name) {
    const nodes = document.querySelectorAll("[data-jhin-action]");
    for (let i = 0; i < nodes.length; i += 1) {
      const parsed = readActionJson(nodes[i].getAttribute("data-jhin-action"));
      if (parsed && parsed.name === name) { return { el: nodes[i], action: parsed }; }
    }
    return null;
  }

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
      if (chord === "escape" && Jhin.dialogLayer !== null) {
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

  /* The shared namespace: functions and consts by value; the one mutable
   * binding this chunk owns (keymapCache) is published as a live accessor so
   * render.js can invalidate it across chunks. */
  Object.assign(Jhin, {
    chordId, parseChord, chordFromEvent, readKeyOverrides, normalizeRule,
    effectiveKeymap, keyContexts, whenHolds, matchKeyRule, clickHook,
    actionByActionName, dispatchCommand, openPalette, onKeydown, initKeymap
  });
  Object.defineProperty(Jhin, "keymapCache", {
    get() { return keymapCache; },
    set(value) { keymapCache = value; },
    configurable: true
  });
})();
