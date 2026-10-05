import 'package:flutter/material.dart';

import '../../design/theme.dart';
import '../../design/tokens.dart';
import '../render_context.dart';
import '../ui_node.dart';
import '../ui_registry.dart';

/// `kbd` (§2.6, contract level 3): `chord` (string, required).
///
/// Renders a keyboard-hint chord as key pills (t3code
/// `components/ui/kbd.tsx`, commit 37de6cb): the chord splits on `+`, every
/// token becomes one pill — `h-5` (20 px) tall, `min-w-5` (20 px) wide,
/// `px-1` (4 px) inset, the `--control-radius` corner (the §4.3 `radius.md`
/// token, 8 px), the `text-2xs` size (the §4.3 `text.xs2` token, 11 px), the
/// muted fill and the muted foreground — and the pills sit in a `gap-1`
/// (4 px) row.
///
/// Modifier mapping per platform (t3code `lib/snapShotShortcut.ts:62-77` and
/// `keybindings.ts:255-288`): `mod` is Cmd (⌘) on the Apple platforms and
/// Ctrl elsewhere; `shift` is ⇧ everywhere; on the Apple platforms
/// `ctrl`/`alt`/`meta` are ⌃/⌥/⌘, on Windows `meta` is ⊞ and elsewhere
/// `Super`. Modifiers render in the upstream canonical order (ctrl, alt,
/// shift, meta) before the key. Key labels follow
/// `keybindings.ts:255-265`: `Space`, single chars uppercased, `Esc`, the
/// arrow abbreviations, anything else capitalized. An unknown token renders
/// literally and logs — the client never throws.
Widget buildKbd(BuildContext context, UiNode node, RenderContext ctx) {
  final chord = node.stringProp('chord');
  if (chord == null || chord.trim().isEmpty) {
    return degradedBox(context, 'Missing chord');
  }
  final design = JhinDesignScope.of(context);
  final tokens = design.tokens;
  final material = JhinDesignScope.materialOf(context);
  final brightness = Theme.brightnessOf(context);
  final remPx = design.switches.fontSizes.sizeInterface.toDouble();
  final radius = jhinSurfaceRadius(tokens.surface, 'md', remPx: remPx) ??
      BorderRadius.circular(8);
  final fontSize = _textTokenPx(tokens.surface, 'xs2', remPx) ?? 11;
  final fill = design.colorOf('muted', brightness: brightness) ??
      material.colorScheme.surfaceContainerHighest;
  final foreground =
      design.colorOf('muted-foreground', brightness: brightness) ??
          material.colorScheme.onSurfaceVariant;

  final labels =
      kbdChordLabels(chord, Theme.of(context).platform);
  return Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      for (var i = 0; i < labels.length; i++) ...[
        if (i > 0) const SizedBox(width: 4),
        Container(
          height: 20,
          constraints: const BoxConstraints(minWidth: 20),
          padding: const EdgeInsets.symmetric(horizontal: 4),
          alignment: Alignment.center,
          decoration: BoxDecoration(color: fill, borderRadius: radius),
          child: Text(
            labels[i],
            textAlign: TextAlign.center,
            style: TextStyle(
              fontSize: fontSize,
              height: 1,
              fontWeight: FontWeight.w500,
              color: foreground,
            ),
          ),
        ),
      ],
    ],
  );
}

/// The modifier kinds of a chord, in the canonical render order (upstream
/// `snapShotShortcut.ts:66-77`: control, alt, shift, meta).
enum _KbdModifier { ctrl, alt, shift, meta }

/// Splits a chord string into the per-platform pill labels: modifiers in the
/// canonical order (ctrl, alt, shift, meta), then the key. A token that is
/// neither a known modifier nor a known key renders literally and logs —
/// never throws. [isWindows] selects the ⊞ glyph for `meta`/`win` tokens off
/// the Apple platforms.
List<String> kbdChordLabels(String chord, TargetPlatform platform) {
  final apple =
      platform == TargetPlatform.macOS || platform == TargetPlatform.iOS;
  final windows = platform == TargetPlatform.windows;
  final modifiers = <_KbdModifier>{};
  final keys = <String>[];
  final unknown = <String>[];
  for (final raw in chord.split('+')) {
    // A single-space token is the Space key; any other whitespace around
    // the '+' separators is trimmed away.
    final token = raw == ' ' ? ' ' : raw.trim();
    if (token.isEmpty) continue;
    final modifier = _modifierKind(token.toLowerCase(), apple);
    if (modifier != null) {
      modifiers.add(modifier);
      continue;
    }
    final key = _knownKeyLabel(token);
    if (key == null) {
      unknown.add(token);
      keys.add(token);
      continue;
    }
    keys.add(key);
  }
  if (unknown.isNotEmpty) {
    debugPrint(
        'Jhin SDUI: kbd chord "$chord" carries unknown token(s) '
        '${unknown.join(", ")}; rendering them literally');
  }
  if (modifiers.isEmpty && keys.isEmpty) {
    debugPrint('Jhin SDUI: kbd chord "$chord" produced no pills');
    return const [];
  }
  final ranks = modifiers.toList()..sort((a, b) => a.index.compareTo(b.index));
  return [
    for (final modifier in ranks) _modifierLabel(modifier, apple, windows),
    ...keys,
  ];
}

/// The modifier kind of one chord token; null when the token is not a known
/// modifier (it renders literally). `mod` is the platform-dependent one: the
/// meta kind on the Apple platforms, ctrl elsewhere (upstream
/// `keybindings.ts:272-277`).
_KbdModifier? _modifierKind(String token, bool apple) {
  switch (token) {
    case 'mod':
      return apple ? _KbdModifier.meta : _KbdModifier.ctrl;
    case 'meta':
    case 'cmd':
    case 'command':
    case 'super':
    case 'win':
      return _KbdModifier.meta;
    case 'ctrl':
    case 'control':
      return _KbdModifier.ctrl;
    case 'alt':
    case 'option':
    case 'opt':
      return _KbdModifier.alt;
    case 'shift':
      return _KbdModifier.shift;
    default:
      return null;
  }
}

/// The per-platform label of one modifier kind (upstream
/// `snapShotShortcut.ts:62-77`): shift is ⇧ everywhere; the Apple platforms
/// map ctrl/alt/meta to ⌃/⌥/⌘; elsewhere ctrl/alt are text and meta is ⊞ on
/// Windows, `Super` on the rest.
String _modifierLabel(_KbdModifier modifier, bool apple, bool isWindows) {
  switch (modifier) {
    case _KbdModifier.shift:
      return '\u21e7';
    case _KbdModifier.ctrl:
      return apple ? '\u2303' : 'Ctrl';
    case _KbdModifier.alt:
      return apple ? '\u2325' : 'Alt';
    case _KbdModifier.meta:
      return apple ? '\u2318' : (isWindows ? '\u229e' : 'Super');
  }
}

/// The label of one known key token (`keybindings.ts:255-265` plus the
/// upstream accepted-key set in `snapShotShortcut.ts:68-71`): `Space`,
/// uppercased single chars, `Esc`, the arrow abbreviations, the named keys
/// capitalized. Null for an unknown token — it renders literally.
String? _knownKeyLabel(String token) {
  if (token == ' ') return 'Space';
  if (token.length == 1) return token.toUpperCase();
  switch (token.toLowerCase()) {
    case 'escape':
      return 'Esc';
    case 'arrowup':
      return 'Up';
    case 'arrowdown':
      return 'Down';
    case 'arrowleft':
      return 'Left';
    case 'arrowright':
      return 'Right';
    case 'enter':
    case 'return':
      return 'Enter';
    case 'tab':
      return 'Tab';
    case 'backspace':
      return 'Backspace';
    case 'delete':
      return 'Delete';
    case 'insert':
      return 'Insert';
    case 'home':
      return 'Home';
    case 'end':
      return 'End';
    case 'pageup':
      return 'Pageup';
    case 'pagedown':
      return 'Pagedown';
    case 'space':
      return 'Space';
  }
  final function = RegExp(r'^f([1-9]|1\d|2[0-4])$', caseSensitive: false)
      .firstMatch(token);
  if (function != null) return 'F${function.group(1)}';
  return null;
}

/// One §4.3 text token's px size (`text.xs2` → 11); null when malformed.
double? _textTokenPx(JhinTokenSurface surface, String key, double remPx) {
  final raw = surface.value('text', key);
  if (raw is Map && raw['size'] != null) {
    return parseCssLength(raw['size'], remPx: remPx);
  }
  return null;
}
