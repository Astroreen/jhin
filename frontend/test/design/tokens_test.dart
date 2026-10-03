import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/tokens.dart';

void main() {
  group('JhinTokens — built-in defaults (docs/sdui.md §1)', () {
    test('spacing: xs 4, sm 8, md 12, lg 16, xl 24, xxl 32', () {
      final tokens = JhinTokens.defaults();
      expect(tokens.spacing.xs, 4);
      expect(tokens.spacing.sm, 8);
      expect(tokens.spacing.md, 12);
      expect(tokens.spacing.lg, 16);
      expect(tokens.spacing.xl, 24);
      expect(tokens.spacing.xxl, 32);
    });

    test('radius: sm 6, md 10, lg 14, full 9999', () {
      final tokens = JhinTokens.defaults();
      expect(tokens.radius.sm, 6);
      expect(tokens.radius.md, 10);
      expect(tokens.radius.lg, 14);
      expect(tokens.radius.full, 9999);
    });

    test('typography seeds: sizes, heights, weights and the mono family', () {
      final typography = JhinTokens.defaults().typography;
      expect(typography.h1.fontSize, 28);
      expect(typography.h1.height, 1.25);
      expect(typography.h1.fontWeight, FontWeight.w700);
      expect(typography.h2.fontSize, 22);
      expect(typography.h2.height, 1.30);
      expect(typography.h2.fontWeight, FontWeight.w700);
      expect(typography.h3.fontSize, 18);
      expect(typography.h3.height, 1.35);
      expect(typography.h3.fontWeight, FontWeight.w600);
      expect(typography.body.fontSize, 14);
      expect(typography.body.height, 1.50);
      expect(typography.body.fontWeight, FontWeight.w400);
      expect(typography.small.fontSize, 12);
      expect(typography.small.height, 1.45);
      expect(typography.small.fontWeight, FontWeight.w400);
      expect(typography.mono.fontSize, 13);
      expect(typography.mono.height, 1.55);
      expect(typography.mono.fontWeight, FontWeight.w400);
      expect(typography.mono.fontFamily, 'monospace');
    });

    test('elevation: none 0, sm 1, md 4, lg 8', () {
      final tokens = JhinTokens.defaults();
      expect(tokens.elevation.none, 0);
      expect(tokens.elevation.sm, 1);
      expect(tokens.elevation.md, 4);
      expect(tokens.elevation.lg, 8);
    });

    test('motion: instant 0, fast 120, normal 200, slow 320, panel 0 (ms)',
        () {
      final motion = JhinTokens.defaults().motion;
      expect(motion.instant, Duration.zero);
      expect(motion.fast, const Duration(milliseconds: 120));
      expect(motion.normal, const Duration(milliseconds: 200));
      expect(motion.slow, const Duration(milliseconds: 320));
      expect(motion.panel, Duration.zero);
    });

    test('client \$size constants: sidebar 280, chart 160, streamList 240', () {
      final tokens = JhinTokens.defaults();
      expect(tokens.sidebarWidth, 280);
      expect(tokens.chartHeight, 160);
      expect(tokens.streamListHeight, 240);
    });
  });

  group('JhinTokens — bootstrap overrides (§1: key-by-key)', () {
    test('spacing override keeps the other keys at the built-in', () {
      final tokens = JhinTokens.fromOverrides(const {
        'spacing': {'md': 20},
      });
      expect(tokens.spacing.md, 20);
      expect(tokens.spacing.lg, 16);
      expect(tokens.spacing.sm, 8);
    });

    test('radius, elevation and motion overrides apply key-by-key', () {
      final tokens = JhinTokens.fromOverrides(const {
        'radius': {'md': 12},
        'elevation': {'lg': 16},
        'motion': {'fast': 60, 'panel': 400},
      });
      expect(tokens.radius.md, 12);
      expect(tokens.radius.sm, 6);
      expect(tokens.elevation.lg, 16);
      expect(tokens.elevation.md, 4);
      expect(tokens.motion.fast, const Duration(milliseconds: 60));
      expect(tokens.motion.panel, const Duration(milliseconds: 400));
      expect(tokens.motion.normal, const Duration(milliseconds: 200));
    });

    test('typography overrides size/height/weight/font per seed', () {
      final tokens = JhinTokens.fromOverrides(const {
        'typography': {
          'h1': {'size': 40, 'weight': 300},
          'mono': {'font': 'JetBrains Mono'},
        },
      });
      expect(tokens.typography.h1.fontSize, 40);
      expect(tokens.typography.h1.fontWeight, FontWeight.w300);
      expect(tokens.typography.h1.height, 1.25);
      expect(tokens.typography.mono.fontFamily, 'JetBrains Mono');
      expect(tokens.typography.body.fontSize, 14);
    });

    test('malformed overrides keep the built-in and never throw', () {
      final tokens = JhinTokens.fromOverrides(const {
        'spacing': {'md': 'not-a-number'},
        'motion': {'fast': -5},
        'typography': {'h1': 'garbage'},
      });
      expect(tokens.spacing.md, 12);
      expect(tokens.motion.fast, const Duration(milliseconds: 120));
      expect(tokens.typography.h1.fontSize, 28);
    });
  });

  group('JhinTokens — density scaling (§1)', () {
    test('comfortable keeps the token values', () {
      final tokens = JhinTokens.defaults(density: JhinDensity.comfortable);
      expect(tokens.spacing.md, 12);
      expect(tokens.spacing.lg, 16);
    });

    test('compact scales spacing down by 0.75', () {
      final tokens = JhinTokens.defaults(density: JhinDensity.compact);
      expect(tokens.spacing.md, 9);
      expect(tokens.spacing.lg, 12);
    });

    test('spacious scales spacing up by 1.25', () {
      final tokens = JhinTokens.defaults(density: JhinDensity.spacious);
      expect(tokens.spacing.md, 15);
      expect(tokens.spacing.lg, 20);
    });

    test('density scales server overrides too, and parses strings', () {
      final tokens = JhinTokens.fromOverrides(
        const {
          'spacing': {'md': 20},
        },
        density: 'compact',
      );
      expect(tokens.spacing.md, 15);
      expect(JhinDensity.parse('spacious'), JhinDensity.spacious);
      expect(JhinDensity.parse('nonsense'), JhinDensity.comfortable);
      expect(JhinDensity.parse(null), JhinDensity.comfortable);
    });
  });

  group('JhinTokens — resolveToken (§2.2)', () {
    test('spacing/radius/elevation resolve to numbers', () {
      final tokens = JhinTokens.defaults();
      expect(tokens.resolveToken('\$spacing.md'), 12.0);
      expect(tokens.resolveToken('\$spacing.lg'), 16.0);
      expect(tokens.resolveToken('\$radius.full'), 9999.0);
      expect(tokens.resolveToken('\$elevation.md'), 4.0);
    });

    test('motion resolves to Durations, typography to TextStyles', () {
      final tokens = JhinTokens.defaults();
      expect(tokens.resolveToken('\$motion.fast'), const Duration(milliseconds: 120));
      expect(tokens.resolveToken('\$motion.slow'), const Duration(milliseconds: 320));
      final h1 = tokens.resolveToken('\$typography.h1');
      expect(h1, isA<TextStyle>());
      expect((h1 as TextStyle).fontSize, 28);
    });

    test('color resolves through the palette when one is installed', () {
      final accent = const Color(0xFF7E57C2);
      final tokens = JhinTokens.defaults().withColors({'accent': accent});
      expect(tokens.resolveToken('\$color.accent'), accent);
      // Without a palette the lookup degrades to null.
      expect(JhinTokens.defaults().resolveToken('\$color.accent'), isNull);
    });

    test('size and font namespaces resolve', () {
      final tokens = JhinTokens.defaults();
      expect(tokens.resolveToken('\$size.sidebar'), 280.0);
      expect(tokens.resolveToken('\$font.mono'), 'monospace');
    });

    test('unknown or malformed references resolve to null', () {
      final tokens = JhinTokens.defaults();
      expect(tokens.resolveToken('\$foo.bar'), isNull);
      expect(tokens.resolveToken('\$spacing.nope'), isNull);
      expect(tokens.resolveToken('\$spacing'), isNull);
      expect(tokens.resolveToken('\$'), isNull);
      expect(tokens.resolveToken('not-a-token'), isNull);
    });
  });
}
