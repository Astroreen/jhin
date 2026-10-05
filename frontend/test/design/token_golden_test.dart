import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/palette_gen.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/design/tokens.dart';

/// T86: the token goldens — the fully resolved palette (the theme palette
/// plus the contrast-resolved `contrast-*` names) for two catalogue themes
/// × two modes, dumped as JSON for the QA evidence and asserted here.
///
/// The dumps land in `String.fromEnvironment('TOKEN_GOLDEN_DIR')` when the
/// QA harness provides it (one file per theme × mode); without the define
/// the test only asserts.
///
/// Seeds (ThemeCatalog.java, extracted from upstream themePalettes.ts at
/// commit 37de6cb): iris light/dark OKLCH triples; the jhin identity keeps
/// the pre-plan defaults for both appearances (T85 decision).
const String _tokenGoldenDir = String.fromEnvironment('TOKEN_GOLDEN_DIR');

String _hex(Lch color) => toHex(toRgb(color));

final Map<String, ({String lightCanvas, String lightAccent, String darkCanvas, String darkAccent})>
    _themes = {
  'iris': (
    lightCanvas: _hex(const Lch(0.976531, 0.003855, 303.226)),
    lightAccent: _hex(const Lch(0.525348, 0.15373, 294.176)),
    darkCanvas: _hex(const Lch(0.225975, 0.031062, 293.741)),
    darkAccent: _hex(const Lch(0.671712, 0.169136, 293.929)),
  ),
  'jhin': (
    lightCanvas: '#16161e',
    lightAccent: '#7E57C2',
    darkCanvas: '#16161e',
    darkAccent: '#7E57C2',
  ),
};

/// The contrast names the golden dumps carry (the full recipe set).
const List<String> _contrastNames = [
  'accent-foreground',
  'border',
  'card-foreground',
  'foreground',
  'icon-muted',
  'input',
  'message-foreground',
  'muted-foreground',
  'placeholder',
  'popover-foreground',
  'secondary-foreground',
  'secondary-label',
  'sidebar-border',
  'sidebar-foreground',
  'sidebar-muted-foreground',
];

String _hexColor(Color color) {
  String byte(int v) => v.toRadixString(16).padLeft(2, '0');
  return '#${byte((color.a * 255.0).round())}'
      '${byte((color.r * 255.0).round())}'
      '${byte((color.g * 255.0).round())}'
      '${byte((color.b * 255.0).round())}';
}

Map<String, dynamic> _golden(
  JhinTheme theme,
  Brightness brightness,
  String themeId,
) {
  final dark = brightness == Brightness.dark;
  final contrast = dark ? theme.contrastDark : theme.contrastLight;
  final out = <String, dynamic>{
    'theme': '$themeId-${dark ? 'dark' : 'light'}',
    'contrastBoost': theme.switches.contrast.boost,
    'colors': <String, String>{
      for (final entry in theme.tokens.colors.entries)
        if (entry.value is Color) entry.key: _hexColor(entry.value as Color),
      for (final name in _contrastNames)
        'contrast-$name': _hexColor(contrast['contrast-$name']!),
    },
  };
  return out;
}

void main() {
  group('T86 token goldens — two themes × two modes', () {
    for (final entry in _themes.entries) {
      for (final brightness in Brightness.values) {
        final id = '${entry.key}-${brightness.name}';
        test('resolves the boosted palette for $id', () {
          final seeds = entry.value;
          final dark = brightness == Brightness.dark;
          final appearance = dark ? 'dark' : 'light';
          final canvas = dark ? seeds.darkCanvas : seeds.lightCanvas;
          final accent = dark ? seeds.darkAccent : seeds.lightAccent;
          // The server pins the generated palette into theme.colors
          // (BootstrapRoute.colors); the client resolves the contrast
          // indirection over it.
          final palette = generate(appearance, canvas, accent);
          final theme = JhinTheme.from(
            appearance: appearance,
            canvas: canvas,
            accent: accent,
            colors: palette,
            prefs: const {'appearanceContrast': 130},
          );

          final contrast = dark ? theme.contrastDark : theme.contrastLight;
          final plain = JhinTheme.from(
            appearance: appearance,
            canvas: canvas,
            accent: accent,
            colors: palette,
          );
          final plainContrast =
              dark ? plain.contrastDark : plain.contrastLight;

          // The boost 30 palette differs from the neutral one and pulls the
          // foreground toward the mode target (white in dark, black in
          // light).
          final boostedForeground = contrast['contrast-foreground']!;
          final plainForeground = plainContrast['contrast-foreground']!;
          expect(boostedForeground, isNot(plainForeground),
              reason: '$id: the boost must move the foreground');
          if (dark) {
            expect(boostedForeground.computeLuminance(),
                greaterThanOrEqualTo(plainForeground.computeLuminance()));
          } else {
            expect(boostedForeground.computeLuminance(),
                lessThanOrEqualTo(plainForeground.computeLuminance()));
          }

          final golden = _golden(theme, brightness, entry.key);
          expect(golden['colors'], isA<Map<String, String>>());
          expect((golden['colors'] as Map).length,
              greaterThanOrEqualTo(_contrastNames.length));

          if (_tokenGoldenDir.isNotEmpty) {
            final file = File('$_tokenGoldenDir/token-golden-$id.json');
            file.parent.createSync(recursive: true);
            file.writeAsStringSync(
                const JsonEncoder.withIndent('  ').convert(golden));
          }
        });
      }
    }

    test('the golden set covers exactly two themes × two modes', () {
      expect(_themes.keys.toSet(), {'iris', 'jhin'});
    });
  });
}
