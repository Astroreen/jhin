// Derived from T3 Code (MIT, see THIRD_PARTY_NOTICES.md): packages/shared/src/keybindings.ts and
// apps/web/src/keybindings.ts. Commands are Jhin client command names.

export interface KeybindingShortcut {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** ⌘ on macOS, Ctrl elsewhere. */
  readonly modKey: boolean;
}

export type KeybindingWhenNode =
  | { readonly type: "identifier"; readonly name: string }
  | { readonly type: "not"; readonly node: KeybindingWhenNode }
  | {
      readonly type: "and" | "or";
      readonly left: KeybindingWhenNode;
      readonly right: KeybindingWhenNode;
    };

export interface KeybindingRuleInput {
  readonly key: string;
  readonly command: string;
  readonly when?: string | undefined;
}

export interface ResolvedKeybinding {
  readonly command: string;
  readonly key: string;
  readonly when?: string;
  readonly shortcut: KeybindingShortcut;
  readonly whenAst?: KeybindingWhenNode;
}

export interface ShortcutEventLike {
  getModifierState?: (key: "AltGraph") => boolean;
  code?: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const MAX_WHEN_EXPRESSION_DEPTH = 64;
const MAX_KEYBINDINGS_COUNT = 256;

const EVENT_CODE_SHORTCUT_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function currentPlatform(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  return normalized === "esc" ? "escape" : normalized;
}

function shortcutKeyFromEvent(event: Pick<ShortcutEventLike, "key" | "code">): string {
  const layoutKey = normalizeEventKey(event.key);
  if (/^[a-z]$/.test(layoutKey)) return layoutKey;
  const physicalKey = event.code ? EVENT_CODE_SHORTCUT_KEYS[event.code] : undefined;
  return physicalKey ?? layoutKey;
}

/** The keys an event may stand for: the layout's key, the physical letter, the physical symbol. */
function resolveEventKeys(event: ShortcutEventLike): Set<string> {
  const layoutKey = normalizeEventKey(event.key);
  const keys = new Set([layoutKey]);
  const letterCode = event.code?.match(/^Key([A-Z])$/)?.[1];
  if (letterCode && !/^[a-z]$/.test(layoutKey)) keys.add(letterCode.toLowerCase());
  keys.add(shortcutKeyFromEvent(event));
  return keys;
}

export function matchesShortcut(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform: string,
): boolean {
  // AltGr composes characters on non-Mac layouts; it is not a shortcut.
  if (
    !isMacPlatform(platform) &&
    event.getModifierState?.("AltGraph") &&
    !/^[a-z0-9]$/i.test(event.key)
  )
    return false;
  const useMetaForMod = isMacPlatform(platform);
  const expectedMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const expectedCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  if (
    event.metaKey !== expectedMeta ||
    event.ctrlKey !== expectedCtrl ||
    event.shiftKey !== shortcut.shiftKey ||
    event.altKey !== shortcut.altKey
  ) {
    return false;
  }
  return resolveEventKeys(event).has(shortcut.key);
}

function normalizeKeyToken(token: string): string {
  if (token === "space") return " ";
  if (token === "esc") return "escape";
  return token;
}

/** `mod+shift+k` → a shortcut; null when it names no key or two keys. `mod++` is the + key. */
export function parseShortcut(value: string): KeybindingShortcut | null {
  // Blank is no shortcut, not the + key.
  if (value.trim() === "") return null;
  const tokens = value
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());
  let trailingEmpty = 0;
  while (tokens.at(-1) === "") {
    trailingEmpty += 1;
    tokens.pop();
  }
  if (trailingEmpty > 0) tokens.push("+");
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) return null;
  let key: string | null = null;
  let metaKey = false;
  let ctrlKey = false;
  let shiftKey = false;
  let altKey = false;
  let modKey = false;
  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        metaKey = true;
        break;
      case "ctrl":
      case "control":
        ctrlKey = true;
        break;
      case "shift":
        shiftKey = true;
        break;
      case "alt":
      case "option":
        altKey = true;
        break;
      case "mod":
        modKey = true;
        break;
      default:
        if (key !== null) return null;
        key = normalizeKeyToken(token);
    }
  }
  return key === null ? null : { key, metaKey, ctrlKey, shiftKey, altKey, modKey };
}

type WhenToken =
  | { type: "identifier"; value: string }
  | { type: "not" }
  | { type: "and" }
  | { type: "or" }
  | { type: "lparen" }
  | { type: "rparen" };

function tokenizeWhen(expression: string): WhenToken[] | null {
  const tokens: WhenToken[] = [];
  let index = 0;
  while (index < expression.length) {
    const current = expression[index]!;
    if (/\s/.test(current)) {
      index += 1;
    } else if (expression.startsWith("&&", index)) {
      tokens.push({ type: "and" });
      index += 2;
    } else if (expression.startsWith("||", index)) {
      tokens.push({ type: "or" });
      index += 2;
    } else if (current === "!") {
      tokens.push({ type: "not" });
      index += 1;
    } else if (current === "(") {
      tokens.push({ type: "lparen" });
      index += 1;
    } else if (current === ")") {
      tokens.push({ type: "rparen" });
      index += 1;
    } else {
      const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(expression.slice(index));
      if (identifier === null) return null;
      tokens.push({ type: "identifier", value: identifier[0] });
      index += identifier[0].length;
    }
  }
  return tokens;
}

/** `!a && (b || c)`; `!` binds tighter than `&&`, which binds tighter than `||`. Null when invalid. */
export function parseWhen(expression: string): KeybindingWhenNode | null {
  const tokens = tokenizeWhen(expression);
  if (tokens === null || tokens.length === 0) return null;
  let index = 0;
  const parsePrimary = (depth: number): KeybindingWhenNode | null => {
    if (depth > MAX_WHEN_EXPRESSION_DEPTH) return null;
    const token = tokens[index];
    if (token?.type === "identifier") {
      index += 1;
      return { type: "identifier", name: token.value };
    }
    if (token?.type === "lparen") {
      index += 1;
      const node = parseOr(depth + 1);
      if (node === null || tokens[index]?.type !== "rparen") return null;
      index += 1;
      return node;
    }
    return null;
  };
  const parseUnary = (depth: number): KeybindingWhenNode | null => {
    let nots = 0;
    while (tokens[index]?.type === "not") {
      index += 1;
      nots += 1;
      if (nots > MAX_WHEN_EXPRESSION_DEPTH) return null;
    }
    let node = parsePrimary(depth);
    if (node === null) return null;
    for (; nots > 0; nots -= 1) node = { type: "not", node };
    return node;
  };
  const parseAnd = (depth: number): KeybindingWhenNode | null => {
    let left = parseUnary(depth);
    while (left !== null && tokens[index]?.type === "and") {
      index += 1;
      const right = parseUnary(depth);
      if (right === null) return null;
      left = { type: "and", left, right };
    }
    return left;
  };
  const parseOr = (depth: number): KeybindingWhenNode | null => {
    let left = parseAnd(depth);
    while (left !== null && tokens[index]?.type === "or") {
      index += 1;
      const right = parseAnd(depth);
      if (right === null) return null;
      left = { type: "or", left, right };
    }
    return left;
  };
  const ast = parseOr(0);
  return ast !== null && index === tokens.length ? ast : null;
}

export function evaluateWhen(
  node: KeybindingWhenNode,
  context: Readonly<Record<string, boolean>>,
): boolean {
  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return context[node.name] === true;
    case "not":
      return !evaluateWhen(node.node, context);
    case "and":
      return evaluateWhen(node.left, context) && evaluateWhen(node.right, context);
    case "or":
      return evaluateWhen(node.left, context) || evaluateWhen(node.right, context);
  }
}

/** A rule ready to match; null when its key or condition does not parse. */
function compileRule(rule: KeybindingRuleInput): ResolvedKeybinding | null {
  const shortcut = parseShortcut(rule.key);
  if (shortcut === null) return null;
  if (rule.when === undefined) return { command: rule.command, key: rule.key, shortcut };
  const whenAst = parseWhen(rule.when);
  return whenAst === null
    ? null
    : { command: rule.command, key: rule.key, when: rule.when, shortcut, whenAst };
}

/**
 * Defaults with the custom rules on top: a custom rule for a command replaces
 * every default of that command; a custom rule with an empty key only unbinds.
 */
export function mergeKeybindings(
  defaults: readonly KeybindingRuleInput[],
  custom: readonly KeybindingRuleInput[],
): ResolvedKeybinding[] {
  const overridden = new Set(custom.map((rule) => rule.command));
  const rules = [
    ...defaults.filter((rule) => !overridden.has(rule.command)),
    ...custom.filter((rule) => rule.key.trim() !== ""),
  ];
  return rules
    .map(compileRule)
    .filter((rule) => rule !== null)
    .slice(-MAX_KEYBINDINGS_COUNT);
}

/** The command an event triggers in this context: the last matching rule wins. */
export function resolveShortcutCommand(
  event: ShortcutEventLike,
  rules: readonly ResolvedKeybinding[],
  context: Readonly<Record<string, boolean>>,
  platform: string = currentPlatform(),
): ResolvedKeybinding | null {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]!;
    if (rule.whenAst !== undefined && !evaluateWhen(rule.whenAst, context)) continue;
    if (matchesShortcut(event, rule.shortcut, platform)) return rule;
  }
  return null;
}

function formatShortcutKeyLabel(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  if (key === "escape") return "Esc";
  if (key === "arrowup") return "Up";
  if (key === "arrowdown") return "Down";
  if (key === "arrowleft") return "Left";
  if (key === "arrowright") return "Right";
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

/** "⌃⌥⇧⌘K" on macOS, "Ctrl+Alt+Shift+K" elsewhere. */
export function formatShortcutLabel(
  shortcut: KeybindingShortcut,
  platform: string = currentPlatform(),
): string {
  const keyLabel = formatShortcutKeyLabel(shortcut.key);
  const mac = isMacPlatform(platform);
  const showMeta = shortcut.metaKey || (shortcut.modKey && mac);
  const showCtrl = shortcut.ctrlKey || (shortcut.modKey && !mac);
  if (mac) {
    return `${showCtrl ? "⌃" : ""}${shortcut.altKey ? "⌥" : ""}${shortcut.shiftKey ? "⇧" : ""}${showMeta ? "⌘" : ""}${keyLabel}`;
  }
  return [
    showCtrl && "Ctrl",
    shortcut.altKey && "Alt",
    shortcut.shiftKey && "Shift",
    showMeta && "Meta",
    keyLabel,
  ]
    .filter(Boolean)
    .join("+");
}

/** The keys a shortcut presses on `platform`, so ⌘K and mod+K match on a Mac. */
function pressedKeys(shortcut: KeybindingShortcut, platform: string): string {
  const mac = isMacPlatform(platform);
  const meta = shortcut.metaKey || (shortcut.modKey && mac);
  const ctrl = shortcut.ctrlKey || (shortcut.modKey && !mac);
  return `${shortcut.key}|${meta}|${ctrl}|${shortcut.shiftKey}|${shortcut.altKey}`;
}

/**
 * The other rules a rule conflicts with (T3's keybindingConflictLabels): the
 * same keys, and `when` clauses that can both apply, which T3 tells cheaply:
 * either has none (always), or both are the same text. `rules[index]` is the
 * rule asked about; the answer is indices into `rules`.
 */
export function keybindingConflicts(
  rules: readonly KeybindingRuleInput[],
  index: number,
  platform: string = currentPlatform(),
): number[] {
  const rule = rules[index];
  const shortcut = rule === undefined ? null : parseShortcut(rule.key);
  if (rule === undefined || shortcut === null) return [];
  const keys = pressedKeys(shortcut, platform);
  const when = rule.when?.trim() ?? "";
  const conflicts: number[] = [];
  rules.forEach((other, otherIndex) => {
    // Two rules of one command on the same keys run the same thing: no conflict.
    if (otherIndex === index || other.command === rule.command) return;
    const otherShortcut = parseShortcut(other.key);
    if (otherShortcut === null || pressedKeys(otherShortcut, platform) !== keys) return;
    const otherWhen = other.when?.trim() ?? "";
    if (when === "" || otherWhen === "" || when === otherWhen) conflicts.push(otherIndex);
  });
  return conflicts;
}

/**
 * The label of the first shortcut of `command` that applies in `context` and
 * is not shadowed by a later rule with the same keys.
 */
export function shortcutLabelForCommand(
  rules: readonly ResolvedKeybinding[],
  command: string,
  context: Readonly<Record<string, boolean>> = {},
  platform: string = currentPlatform(),
): string | undefined {
  const claimed = new Set<string>();
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index]!;
    if (rule.whenAst !== undefined && !evaluateWhen(rule.whenAst, context)) continue;
    const conflictKey = pressedKeys(rule.shortcut, platform);
    if (claimed.has(conflictKey)) continue;
    claimed.add(conflictKey);
    if (rule.command === command) return formatShortcutLabel(rule.shortcut, platform);
  }
  return undefined;
}

/** What a key press would record as a rule's key, or null for a lone modifier. */
export function keyFromEvent(
  event: Pick<ShortcutEventLike, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  platform: string = currentPlatform(),
): string | null {
  const key = normalizeEventKey(event.key);
  if (["meta", "control", "alt", "shift", "os"].includes(key)) return null;
  const mac = isMacPlatform(platform);
  const parts: string[] = [];
  if (mac ? event.metaKey : event.ctrlKey) parts.push("mod");
  if (mac ? event.ctrlKey : event.metaKey) parts.push(mac ? "ctrl" : "meta");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  const token = shortcutKeyFromEvent(event);
  parts.push(token === " " ? "space" : token === "escape" ? "esc" : token);
  return parts.join("+");
}
