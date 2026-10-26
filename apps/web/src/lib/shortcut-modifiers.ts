// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): apps/web/src/shortcutModifierState.ts
// (the modifier keys held now, reset by a paste or a lost focus) and lib/editableFocus.ts.
// docs/plans/source-control.md D1453.
import { useEffect, useRef, useState } from "react";

export interface ShortcutModifierState {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

const EMPTY: ShortcutModifierState = {
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

const EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
].join(",");

/** Focus inside an open shadow root counts: a key event's target is its shadow host. */
function isEditableFocused(target: EventTarget | null = document.activeElement): boolean {
  let element = target instanceof Element ? target : null;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element !== null && element.closest(EDITABLE_SELECTOR) !== null;
}

const same = (left: ShortcutModifierState, right: ShortcutModifierState) =>
  left.metaKey === right.metaKey &&
  left.ctrlKey === right.ctrlKey &&
  left.altKey === right.altKey &&
  left.shiftKey === right.shiftKey;

function modifierOf(key: string): keyof ShortcutModifierState | null {
  switch (key) {
    case "Meta":
    case "OS":
    case "Command":
      return "metaKey";
    case "Control":
      return "ctrlKey";
    case "Alt":
    case "Option":
      return "altKey";
    case "Shift":
      return "shiftKey";
    default:
      return null;
  }
}

/**
 * The state after a key event: a modifier's own key sets or clears it; another key only
 * clears one its event no longer reports (a dictation tool's synthetic ⌘V never sends ⌘'s
 * key up, and the browser can keep reporting it on later keys).
 */
function modifiersAfter(
  current: ShortcutModifierState,
  event: Pick<KeyboardEvent, "key" | "type" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): ShortcutModifierState {
  const modifier = modifierOf(event.key);
  const next: ShortcutModifierState =
    modifier !== null
      ? { ...current, [modifier]: event.type === "keydown" }
      : {
          metaKey: current.metaKey && event.metaKey,
          ctrlKey: current.ctrlKey && event.ctrlKey,
          altKey: current.altKey && event.altKey,
          shiftKey: current.shiftKey && event.shiftKey,
        };
  return same(current, next) ? current : next;
}

/** T3's useShortcutModifierState: the modifiers held now; none while typing with `ignoreEditable`. */
export function useShortcutModifierState(ignoreEditable = false): ShortcutModifierState {
  const [state, setState] = useState(EMPTY);
  const stateRef = useRef(EMPTY);
  useEffect(() => {
    const update = (next: ShortcutModifierState) => {
      // Ordinary typing returns before any React update.
      if (same(stateRef.current, next)) return;
      stateRef.current = next;
      setState(next);
    };
    const onKey = (event: KeyboardEvent) =>
      update(
        ignoreEditable && isEditableFocused(event.target)
          ? EMPTY
          : modifiersAfter(stateRef.current, event),
      );
    const reset = () => update(EMPTY);
    const onFocus = (event: FocusEvent) => {
      if (ignoreEditable && isEditableFocused(event.target)) reset();
    };
    window.addEventListener("focusin", onFocus);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("paste", reset, true);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("focusin", onFocus);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("paste", reset, true);
      window.removeEventListener("blur", reset);
    };
  }, [ignoreEditable]);
  return state;
}
