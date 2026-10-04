import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'when_context.dart';

/// The platform a key chord is resolved against: `mod` is Cmd (meta) on
/// macOS and Ctrl everywhere else (docs/sdui.md §1). Injectable for tests.
enum KeyPlatform {
  macOS,
  windows,
  linux,
  other;

  /// The platform the app is running on.
  static KeyPlatform get current => switch (defaultTargetPlatform) {
        TargetPlatform.macOS => KeyPlatform.macOS,
        TargetPlatform.windows => KeyPlatform.windows,
        TargetPlatform.linux => KeyPlatform.linux,
        _ => KeyPlatform.other,
      };

  /// Whether the `mod` alias resolves to `meta` (macOS) instead of `ctrl`.
  bool get modIsMeta => this == KeyPlatform.macOS;
}

/// The modifier set of a chord.
enum KeyModifier { ctrl, alt, shift, meta }

/// One keyboard chord: a modifier set plus one normalized key token.
///
/// Key tokens are the §1 spelling: named keys (`enter`, `escape`, `tab`,
/// `space`, `backspace`, `delete`, `up`, `down`, `left`, `right`, `home`,
/// `end`, `pageup`, `pagedown`), single letters `a`–`z` and digits `0`–`9`.
/// Parsing never throws; a malformed spec parses to `null` and its keymap
/// rule is ignored.
class KeyChord {
  KeyChord(Set<KeyModifier> modifiers, this.key)
      : modifiers = Set<KeyModifier>.unmodifiable(modifiers);

  /// The exact modifier set of the chord.
  final Set<KeyModifier> modifiers;

  /// The normalized key token, for example `enter`.
  final String key;

  /// Parses a chord spec like `mod+enter`, `ctrl+alt+enter`, `shift+enter`,
  /// `ctrl+k`, `ctrl+1`. [platform] decides what `mod` means. Returns null
  /// (never throws) for any malformed spec: empty key, trailing modifier
  /// (`mod+`), unknown modifier or unknown key token.
  static KeyChord? parse(String spec, {KeyPlatform? platform}) {
    try {
      final effective = platform ?? KeyPlatform.current;
      final parts = spec.split('+');
      final modifiers = <KeyModifier>{};
      for (var i = 0; i < parts.length - 1; i++) {
        final modifier = _modifierFor(parts[i].trim(), effective);
        if (modifier == null) return null;
        modifiers.add(modifier);
      }
      final key = _normalizeKey(parts.last.trim());
      if (key == null) return null;
      return KeyChord(modifiers, key);
    } catch (_) {
      return null;
    }
  }

  /// The chord of one hardware key event, or null when the event is not a
  /// chord trigger (non-down events, bare modifier presses, unknown keys).
  static KeyChord? fromKeyEvent(KeyEvent event) {
    if (event is! KeyDownEvent) return null;
    final logicalKey = event.logicalKey;
    if (_modifierKeys.contains(logicalKey)) return null;
    final key = tokenFor(logicalKey);
    if (key == null) return null;
    final modifiers = <KeyModifier>{};
    final hardware = HardwareKeyboard.instance;
    if (hardware.isControlPressed) modifiers.add(KeyModifier.ctrl);
    if (hardware.isAltPressed) modifiers.add(KeyModifier.alt);
    if (hardware.isShiftPressed) modifiers.add(KeyModifier.shift);
    if (hardware.isMetaPressed) modifiers.add(KeyModifier.meta);
    return KeyChord(modifiers, key);
  }

  /// The normalized token of one logical key, or null when the key has no
  /// token in the chord vocabulary.
  static String? tokenFor(LogicalKeyboardKey key) {
    final named = _namedTokens[key];
    if (named != null) return named;
    return _characterTokens[key];
  }

  static KeyModifier? _modifierFor(String token, KeyPlatform platform) {
    switch (token) {
      case 'mod':
        return platform.modIsMeta ? KeyModifier.meta : KeyModifier.ctrl;
      case 'ctrl':
      case 'control':
        return KeyModifier.ctrl;
      case 'alt':
        return KeyModifier.alt;
      case 'shift':
        return KeyModifier.shift;
      case 'meta':
        return KeyModifier.meta;
      default:
        return null;
    }
  }

  static String? _normalizeKey(String token) {
    if (token.isEmpty) return null;
    final lower = token.toLowerCase();
    if (_keyTokens.contains(lower)) return lower;
    return null;
  }

  static const Set<String> _keyTokens = <String>{
    'enter',
    'escape',
    'tab',
    'space',
    'backspace',
    'delete',
    'up',
    'down',
    'left',
    'right',
    'home',
    'end',
    'pageup',
    'pagedown',
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  };

  static final Set<LogicalKeyboardKey> _modifierKeys = <LogicalKeyboardKey>{
    LogicalKeyboardKey.controlLeft,
    LogicalKeyboardKey.controlRight,
    LogicalKeyboardKey.shiftLeft,
    LogicalKeyboardKey.shiftRight,
    LogicalKeyboardKey.altLeft,
    LogicalKeyboardKey.altRight,
    LogicalKeyboardKey.metaLeft,
    LogicalKeyboardKey.metaRight,
  };

  static final Map<LogicalKeyboardKey, String> _namedTokens =
      <LogicalKeyboardKey, String>{
    LogicalKeyboardKey.enter: 'enter',
    LogicalKeyboardKey.escape: 'escape',
    LogicalKeyboardKey.tab: 'tab',
    LogicalKeyboardKey.space: 'space',
    LogicalKeyboardKey.backspace: 'backspace',
    LogicalKeyboardKey.delete: 'delete',
    LogicalKeyboardKey.arrowUp: 'up',
    LogicalKeyboardKey.arrowDown: 'down',
    LogicalKeyboardKey.arrowLeft: 'left',
    LogicalKeyboardKey.arrowRight: 'right',
    LogicalKeyboardKey.home: 'home',
    LogicalKeyboardKey.end: 'end',
    LogicalKeyboardKey.pageUp: 'pageup',
    LogicalKeyboardKey.pageDown: 'pagedown',
  };

  static final Map<LogicalKeyboardKey, String> _characterTokens =
      <LogicalKeyboardKey, String>{
    for (var i = 0; i < 26; i++)
      LogicalKeyboardKey(LogicalKeyboardKey.keyA.keyId + i):
          String.fromCharCode(97 + i),
    for (var i = 0; i < 10; i++)
      LogicalKeyboardKey(LogicalKeyboardKey.digit0.keyId + i): '$i',
    for (var i = 0; i < 10; i++)
      LogicalKeyboardKey(LogicalKeyboardKey.numpad0.keyId + i): '$i',
  };

  @override
  bool operator ==(Object other) =>
      other is KeyChord &&
      other.key == key &&
      setEquals(other.modifiers, modifiers);

  @override
  int get hashCode => Object.hash(key, Object.hashAllUnordered(modifiers));

  @override
  String toString() {
    final names = modifiers.map((m) => m.name).toList()..sort();
    return <String>[...names, key].join('+');
  }
}

/// One keymap rule: a chord, the command it dispatches and an optional
/// `when` expression gating it against the [WhenContext].
class KeymapRule {
  const KeymapRule({required this.chord, required this.command, this.when});

  /// The chord that triggers the rule.
  final KeyChord chord;

  /// The command id dispatched (unknown ids dispatch as no-ops).
  final String command;

  /// The `when` expression; absent means the rule is context-free (and, per
  /// the typing policy of [Keymap.commandFor], suspended while text is
  /// being entered).
  final String? when;

  /// Parses one `{key|keys, command, when?}` entry (§1 server shape and the
  /// T70 store shape `{'rules': [{command, keys}]}` both work). Returns null
  /// for any malformed entry — it is ignored, never thrown.
  static KeymapRule? fromMap(Object? entry, {KeyPlatform? platform}) {
    if (entry is! Map) return null;
    final rawKey = entry['key'] ?? entry['keys'];
    if (rawKey is! String) return null;
    final chord = KeyChord.parse(rawKey, platform: platform);
    if (chord == null) return null;
    final rawCommand = entry['command'];
    if (rawCommand is! String || rawCommand.isEmpty) return null;
    final rawWhen = entry['when'];
    if (rawWhen != null && rawWhen is! String) return null;
    final when = rawWhen is String && rawWhen.isNotEmpty ? rawWhen : null;
    return KeymapRule(chord: chord, command: rawCommand, when: when);
  }

  @override
  String toString() =>
      when == null ? '$chord -> $command' : '$chord -> $command when $when';
}

/// An ordered keymap: the effective list of rules a chord is resolved
/// against. **The last matching rule wins** (§1) — later entries override
/// earlier ones for the same chord.
class Keymap {
  const Keymap(this.rules);

  /// The keymap with no rules.
  static const Keymap empty = Keymap(<KeymapRule>[]);

  /// The effective rules, in order.
  final List<KeymapRule> rules;

  /// Parses a keymap entry list; malformed entries are dropped, never
  /// thrown on.
  static Keymap parse(List<Object?>? entries, {KeyPlatform? platform}) {
    final rules = <KeymapRule>[];
    for (final entry in entries ?? const <Object?>[]) {
      final rule = KeymapRule.fromMap(entry, platform: platform);
      if (rule != null) rules.add(rule);
    }
    return Keymap(List<KeymapRule>.unmodifiable(rules));
  }

  /// The effective keymap (§1): server defaults merged with user overrides.
  ///
  /// User overrides win **per command** — a rebinding replaces every default
  /// rule of that command; commands without overrides keep their server
  /// defaults (newly added server defaults on upgrade are never dropped);
  /// user rules not matching any default command are added as-is. User rules
  /// sit last so they also win the last-match tie-break against a default
  /// rule of a different command on the same chord.
  ///
  /// A user rule without its own `when` inherits the `when` of the default
  /// rule it replaces (the store shape carries only `{command, keys}`, so
  /// without inheritance a rebinding would drop the command's context gate —
  /// `composer.send` would lose `composerFocus` and stop working in the
  /// composer). A user rule with an explicit `when` keeps it.
  static Keymap resolve(
    List<Object?>? defaultsFromServer,
    List<Object?>? userOverrides, {
    KeyPlatform? platform,
  }) {
    final defaults = parse(defaultsFromServer, platform: platform).rules;
    final overrides = parse(userOverrides, platform: platform).rules;
    final overridden = overrides.map((rule) => rule.command).toSet();
    final inheritedWhen = <String, String?>{
      for (final rule in defaults)
        if (overridden.contains(rule.command) && rule.when != null)
          rule.command: rule.when,
    };
    final effective = <KeymapRule>[
      for (final rule in defaults)
        if (!overridden.contains(rule.command)) rule,
      for (final rule in overrides)
        rule.when == null && inheritedWhen.containsKey(rule.command)
            ? KeymapRule(
                chord: rule.chord,
                command: rule.command,
                when: inheritedWhen[rule.command],
              )
            : rule,
    ];
    return Keymap(List<KeymapRule>.unmodifiable(effective));
  }

  /// The effective keymap plus client fallback rules (T68): one fallback is
  /// appended for every command no existing rule binds, so the default
  /// composer chords work when the server keymap does not carry them yet.
  /// Existing rules are never replaced or reordered.
  Keymap withDefaults(List<Object?> fallbackEntries, {KeyPlatform? platform}) {
    try {
      final bound = rules.map((rule) => rule.command).toSet();
      final extra = <KeymapRule>[
        for (final rule in parse(fallbackEntries, platform: platform).rules)
          if (!bound.contains(rule.command)) rule,
      ];
      if (extra.isEmpty) return this;
      return Keymap(List<KeymapRule>.unmodifiable([...rules, ...extra]));
    } catch (_) {
      return this;
    }
  }

  /// The command a chord resolves to in the current [context], or null when
  /// no rule matches. **The last matching rule wins.**
  ///
  /// Typing policy: a context-free rule (no `when`) is suspended while text
  /// is being entered ([textEntryActive] — derived from the context's
  /// `composerFocus`/`editableFocus` unless given explicitly), so plain
  /// shortcuts never hijack typing. A rule with a `when` follows its
  /// expression exactly and may fire while typing when it says so. Never
  /// throws.
  String? commandFor(
    KeyChord chord,
    WhenContext context, {
    bool? textEntryActive,
  }) {
    try {
      final typing =
          textEntryActive ?? (context.composerFocus || context.editableFocus);
      String? matched;
      for (final rule in rules) {
        if (rule.chord != chord) continue;
        final when = rule.when;
        if (when == null) {
          if (typing) continue;
          matched = rule.command;
        } else if (context.evaluate(when)) {
          matched = rule.command;
        }
      }
      return matched;
    } catch (_) {
      return null;
    }
  }
}
