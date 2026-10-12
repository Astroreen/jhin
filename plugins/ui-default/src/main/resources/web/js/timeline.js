/* Jhin web client runtime chunk — timeline.js (T300): the three drawer and
 * overlay focus behaviours plus the boot tail of the former single-file
 * runtime. This chunk loads last; every helper it needs is already on the
 * shared Jhin namespace (window.Jhin). Its document keydown listener runs in
 * the bubble phase so keymap.js (capture phase) always sees a key first and
 * event.defaultPrevented short-circuits the handling below. */
(() => {
  "use strict";

  const Jhin = window.Jhin || (window.Jhin = {});

  /* Imports from the previously loaded chunks (core.js, render.js,
   * actions.js, keymap.js). */
  const { initState } = Jhin;
  const { bootstrap } = Jhin;
  const { initActions, closeDialogOverlay } = Jhin;
  const { initKeymap } = Jhin;

  /* --- T300.1: drawer open-state driver (jhin-drawer-open) -------------
   * The stylesheet hook is #jhin-root.jhin-drawer-open; the class is also
   * mirrored on document.body so any future body-level hook works. Open and
   * close are idempotent. */
  function setDrawerOpen(open) {
    const root = document.getElementById("jhin-root");
    const cl = document.body.classList;
    if (open) {
      cl.add("jhin-drawer-open");
      if (root) root.classList.add("jhin-drawer-open");
    } else {
      cl.remove("jhin-drawer-open");
      if (root) root.classList.remove("jhin-drawer-open");
    }
  }

  function drawerOpen() {
    return document.body.classList.contains("jhin-drawer-open");
  }

  function drawerEl() {
    return document.querySelector("#jhin-root .jhin-nav-sidebar");
  }

  /* The topmost overlay: the last dialog layer in #jhin-overlays, else the
   * open drawer. A native <dialog open> owns its own focus, so the trap
   * stands down while one is open. */
  function topOverlay() {
    if (document.querySelector("#jhin-overlays dialog[open]")) return null;
    const layers = document.querySelectorAll("#jhin-overlays .jhin-dialog-layer");
    if (layers.length > 0) return layers[layers.length - 1];
    if (drawerOpen()) return drawerEl();
    return null;
  }

  /* --- T300.2: focus trap — Tab and Shift+Tab cycle inside the topmost
   * overlay. Focusable filter matches the runtime's own controls. */
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function trapTab(event) {
    const overlay = topOverlay();
    if (!overlay) return;
    const items = Array.from(overlay.querySelectorAll(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement
    );
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = overlay.contains(active);
    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  /* --- T300.3: Escape closes only the topmost overlay — the dialog layer
   * through closeDialogOverlay, else the drawer. keymap.js runs first in the
   * capture phase and may have handled Escape already (defaultPrevented). */
  function escapeTopmost() {
    const layers = document.querySelectorAll("#jhin-overlays .jhin-dialog-layer");
    if (layers.length > 0) {
      closeDialogOverlay();
      return;
    }
    if (drawerOpen()) setDrawerOpen(false);
  }

  function onKeydownBubble(event) {
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      escapeTopmost();
      return;
    }
    if (event.key === "Tab") trapTab(event);
  }

  /* --- drawer driver triggers ------------------------------------------ */
  function isInteractive(target) {
    return !!target.closest(FOCUSABLE);
  }

  function initDrawerDriver() {
    document.addEventListener("keydown", onKeydownBubble);

    document.addEventListener("focusin", (event) => {
      const sidebar = drawerEl();
      if (sidebar && sidebar.contains(event.target)) setDrawerOpen(true);
    });

    document.addEventListener("focusout", (event) => {
      const sidebar = drawerEl();
      if (!sidebar || !sidebar.contains(event.target)) return;
      /* Keep the drawer open while another overlay owns focus. */
      if (document.querySelector("#jhin-overlays .jhin-dialog-layer, #jhin-overlays dialog[open]")) {
        return;
      }
      setDrawerOpen(false);
    });

    document.addEventListener("click", (event) => {
      const sidebar = drawerEl();
      if (sidebar && sidebar.contains(event.target) && !isInteractive(event.target)) {
        setDrawerOpen(!drawerOpen());
        return;
      }
      if (event.target === document.getElementById("jhin-root")) setDrawerOpen(false);
    });

    const narrow = window.matchMedia("(max-width: 768px)");
    const onBreakpoint = () => setDrawerOpen(false);
    if (typeof narrow.addEventListener === "function") {
      narrow.addEventListener("change", onBreakpoint);
    } else if (typeof narrow.addListener === "function") {
      narrow.addListener(onBreakpoint);
    }
  }  function shell() {
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
  initDrawerDriver();
})();
