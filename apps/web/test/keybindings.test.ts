import { describe, expect, it } from "vite-plus/test";

import {
  evaluateWhen,
  formatShortcutLabel,
  holdsShortcutModifiers,
  keybindingConflicts,
  keyFromEvent,
  matchesShortcut,
  mergeKeybindings,
  parseShortcut,
  parseWhen,
  resolveShortcutCommand,
  shortcutLabelForCommand,
  type ShortcutEventLike,
} from "../src/lib/keybindings.ts";

const MAC = "MacIntel";
const LINUX = "Linux x86_64";

const press = (key: string, modifiers: Partial<ShortcutEventLike> = {}): ShortcutEventLike => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

describe("parseShortcut", () => {
  it("reads modifiers and one key", () => {
    expect(parseShortcut("mod+shift+K")).toEqual({
      key: "k",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      modKey: true,
    });
    expect(parseShortcut("ctrl+alt+esc")?.key).toBe("escape");
    expect(parseShortcut("space")?.key).toBe(" ");
  });

  it("reads mod++ as the plus key", () => {
    expect(parseShortcut("mod++")).toMatchObject({ key: "+", modKey: true });
  });

  it("refuses two keys, no key, or empty parts", () => {
    expect(parseShortcut("a+b")).toBeNull();
    expect(parseShortcut("mod+shift")).toBeNull();
    expect(parseShortcut("")).toBeNull();
    expect(parseShortcut("mod++k")).toBeNull();
  });
});

describe("when clauses", () => {
  it("binds ! tighter than && and && tighter than ||", () => {
    const ast = parseWhen("!a && b || c");
    expect(ast).not.toBeNull();
    expect(evaluateWhen(ast!, { a: false, b: true })).toBe(true);
    expect(evaluateWhen(ast!, { a: true, b: true })).toBe(false);
    expect(evaluateWhen(ast!, { a: true, c: true })).toBe(true);
  });

  it("honours parentheses and the true/false literals", () => {
    const ast = parseWhen("!(a || b)");
    expect(evaluateWhen(ast!, {})).toBe(true);
    expect(evaluateWhen(ast!, { b: true })).toBe(false);
    expect(evaluateWhen(parseWhen("true")!, {})).toBe(true);
    expect(evaluateWhen(parseWhen("false || a")!, { a: true })).toBe(true);
  });

  it("refuses malformed expressions", () => {
    expect(parseWhen("a &&")).toBeNull();
    expect(parseWhen("(a")).toBeNull();
    expect(parseWhen("a b")).toBeNull();
    expect(parseWhen("a & b")).toBeNull();
    expect(parseWhen("")).toBeNull();
  });
});

describe("matchesShortcut", () => {
  const modK = parseShortcut("mod+k")!;

  it("maps mod to ⌘ on macOS and to Ctrl elsewhere", () => {
    expect(matchesShortcut(press("k", { metaKey: true }), modK, MAC)).toBe(true);
    expect(matchesShortcut(press("k", { ctrlKey: true }), modK, MAC)).toBe(false);
    expect(matchesShortcut(press("k", { ctrlKey: true }), modK, LINUX)).toBe(true);
    expect(matchesShortcut(press("k", { metaKey: true }), modK, LINUX)).toBe(false);
  });

  it("needs exactly the modifiers of the shortcut", () => {
    expect(matchesShortcut(press("k", { ctrlKey: true, shiftKey: true }), modK, LINUX)).toBe(false);
    expect(matchesShortcut(press("K", { ctrlKey: true }), modK, LINUX)).toBe(true);
  });

  it("matches the physical letter on layouts whose key is another character", () => {
    // A Russian layout reports "л" for the K key.
    expect(matchesShortcut(press("л", { ctrlKey: true, code: "KeyK" }), modK, LINUX)).toBe(true);
    // Shifted digits report a symbol; the physical digit still matches.
    const jump = parseShortcut("mod+shift+1")!;
    expect(
      matchesShortcut(press("!", { ctrlKey: true, shiftKey: true, code: "Digit1" }), jump, LINUX),
    ).toBe(true);
  });

  it("ignores AltGr compositions outside macOS", () => {
    const altGr = press("@", {
      ctrlKey: true,
      altKey: true,
      getModifierState: (key) => key === "AltGraph",
    });
    expect(matchesShortcut(altGr, parseShortcut("ctrl+alt+@")!, LINUX)).toBe(false);
  });
});

describe("mergeKeybindings and resolveShortcutCommand", () => {
  const defaults = [
    { key: "mod+k", command: "palette.toggle" },
    { key: "mod+n", command: "chat.new" },
    { key: "mod+shift+n", command: "chat.new" },
    { key: "escape", command: "chat.stop", when: "turnRunning" },
  ];

  it("lets a custom rule replace every default of its command", () => {
    const rules = mergeKeybindings(defaults, [{ key: "mod+t", command: "chat.new" }]);
    expect(rules.filter((rule) => rule.command === "chat.new").map((rule) => rule.key)).toEqual([
      "mod+t",
    ]);
  });

  it("unbinds a command with an empty key", () => {
    const rules = mergeKeybindings(defaults, [{ key: "", command: "palette.toggle" }]);
    expect(rules.some((rule) => rule.command === "palette.toggle")).toBe(false);
  });

  it("drops rules that do not parse", () => {
    const rules = mergeKeybindings(
      [],
      [
        { key: "a+b", command: "x" },
        { key: "mod+j", command: "y", when: "(" },
        { key: "mod+j", command: "z" },
      ],
    );
    expect(rules.map((rule) => rule.command)).toEqual(["z"]);
  });

  it("resolves the last matching rule whose condition holds", () => {
    const rules = mergeKeybindings(defaults, [{ key: "mod+k", command: "custom.k" }]);
    expect(resolveShortcutCommand(press("k", { ctrlKey: true }), rules, {}, LINUX)?.command).toBe(
      "custom.k",
    );
    expect(resolveShortcutCommand(press("Escape"), rules, {}, LINUX)).toBeNull();
    expect(
      resolveShortcutCommand(press("Escape"), rules, { turnRunning: true }, LINUX)?.command,
    ).toBe("chat.stop");
  });
});

describe("labels", () => {
  it("formats per platform", () => {
    const shortcut = parseShortcut("mod+alt+shift+a")!;
    expect(formatShortcutLabel(shortcut, MAC)).toBe("⌥⇧⌘A");
    expect(formatShortcutLabel(shortcut, LINUX)).toBe("Ctrl+Alt+Shift+A");
    expect(formatShortcutLabel(parseShortcut("escape")!, LINUX)).toBe("Esc");
  });

  it("labels a command by its first shortcut that is not shadowed", () => {
    const rules = mergeKeybindings(
      [
        { key: "mod+o", command: "chat.new" },
        { key: "mod+b", command: "ui.sidebar.toggle" },
      ],
      [{ key: "mod+o", command: "other" }],
    );
    // `other` claims mod+o after chat.new's default, so chat.new has no label.
    expect(shortcutLabelForCommand(rules, "chat.new", {}, LINUX)).toBeUndefined();
    expect(shortcutLabelForCommand(rules, "ui.sidebar.toggle", {}, LINUX)).toBe("Ctrl+B");
  });

  it("only counts rules whose condition holds", () => {
    const rules = mergeKeybindings(
      [{ key: "mod+.", command: "chat.stop", when: "turnRunning" }],
      [],
    );
    expect(shortcutLabelForCommand(rules, "chat.stop", {}, LINUX)).toBeUndefined();
    expect(shortcutLabelForCommand(rules, "chat.stop", { turnRunning: true }, LINUX)).toBe(
      "Ctrl+.",
    );
  });
});

describe("keyFromEvent", () => {
  it("records presses as rule keys with mod for the platform's primary modifier", () => {
    expect(keyFromEvent(press("k", { ctrlKey: true, shiftKey: true }), LINUX)).toBe("mod+shift+k");
    expect(keyFromEvent(press("k", { metaKey: true }), MAC)).toBe("mod+k");
    expect(keyFromEvent(press("k", { ctrlKey: true }), MAC)).toBe("ctrl+k");
    expect(keyFromEvent(press(" ", { altKey: true }), LINUX)).toBe("alt+space");
    expect(keyFromEvent(press("Escape"), LINUX)).toBe("esc");
  });

  it("records nothing for a lone modifier", () => {
    expect(keyFromEvent(press("Shift", { shiftKey: true }), LINUX)).toBeNull();
    expect(keyFromEvent(press("Control", { ctrlKey: true }), LINUX)).toBeNull();
  });

  it("round-trips through parseShortcut and matchesShortcut", () => {
    const event = press("л", { ctrlKey: true, altKey: true, code: "KeyK" });
    const key = keyFromEvent(event, LINUX);
    expect(key).not.toBeNull();
    expect(matchesShortcut(event, parseShortcut(key!)!, LINUX)).toBe(true);
  });
});

describe("keybindingConflicts (D441)", () => {
  it("finds rules with the same keys whose conditions can both apply", () => {
    const rules = [
      { key: "mod+k", command: "palette.toggle" },
      { key: "mod+k", command: "chat.clear", when: "composerFocus" },
      { key: "mod+k", command: "terminal.clear", when: "terminalFocus" },
      { key: "mod+k", command: "terminal.find", when: "terminalFocus" },
      { key: "mod+j", command: "terminal.toggle" },
    ];
    // No condition applies always, so it conflicts with every rule on its keys.
    expect(keybindingConflicts(rules, 0, LINUX)).toEqual([1, 2, 3]);
    // Different conditions are taken to exclude each other, as T3 tells it cheaply.
    expect(keybindingConflicts(rules, 1, LINUX)).toEqual([0]);
    expect(keybindingConflicts(rules, 2, LINUX)).toEqual([0, 3]);
    expect(keybindingConflicts(rules, 4, LINUX)).toEqual([]);
  });

  it("compares the keys pressed on the platform, not how the rule spells them", () => {
    const rules = [
      { key: "mod+shift+p", command: "a" },
      { key: "ctrl+shift+p", command: "b" },
      { key: "Shift+Mod+P", command: "c" },
    ];
    expect(keybindingConflicts(rules, 0, LINUX)).toEqual([1, 2]);
    // On a Mac, mod is ⌘: Ctrl+Shift+P is other keys.
    expect(keybindingConflicts(rules, 0, MAC)).toEqual([2]);
  });

  it("does not count a rule of the same command as a conflict", () => {
    const rules = [
      { key: "mod+b", command: "ui.sidebar.toggle", when: "composerFocus" },
      { key: "mod+b", command: "ui.sidebar.toggle" },
      { key: "mod+b", command: "chat.bold", when: "composerFocus" },
    ];
    expect(keybindingConflicts(rules, 0, LINUX)).toEqual([2]);
    expect(keybindingConflicts(rules, 1, LINUX)).toEqual([2]);
  });

  it("leaves rules without a valid shortcut alone", () => {
    const rules = [
      { key: "", command: "a" },
      { key: "", command: "b" },
      { key: "mod+", command: "c" },
    ];
    expect(keybindingConflicts(rules, 0, LINUX)).toEqual([]);
    expect(keybindingConflicts(rules, 5, LINUX)).toEqual([]);
  });
});

describe("holdsShortcutModifiers (D453)", () => {
  const rules = [1, 2, 3].map((n) => ({ key: `mod+${n}`, command: `sidebar.thread.jump.${n}` }));
  const jumps = new Set(rules.map((rule) => rule.command));
  const held = (
    modifiers: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>>,
  ) => ({
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...modifiers,
  });

  it("is true while exactly the jump shortcuts' modifiers are held", () => {
    expect(holdsShortcutModifiers(held({ metaKey: true }), rules, jumps, MAC)).toBe(true);
    expect(holdsShortcutModifiers(held({ ctrlKey: true }), rules, jumps, LINUX)).toBe(true);
    // Another modifier with it, or the other platform's: no hints.
    expect(holdsShortcutModifiers(held({ metaKey: true, shiftKey: true }), rules, jumps, MAC)).toBe(
      false,
    );
    expect(holdsShortcutModifiers(held({ ctrlKey: true }), rules, jumps, MAC)).toBe(false);
    expect(holdsShortcutModifiers(held({}), rules, jumps, MAC)).toBe(false);
  });

  it("follows the rules: other commands' shortcuts do not count", () => {
    expect(
      holdsShortcutModifiers(
        held({ altKey: true }),
        [{ key: "alt+1", command: "other" }],
        jumps,
        MAC,
      ),
    ).toBe(false);
  });
});
