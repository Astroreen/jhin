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

  group('T86 — font roles (settings.ts:122-139)', () {
    test('defaults: interface 16, prompt 14 (effective 16), code 13', () {
      final sizes = resolveFontSizes();
      expect(sizes.sizeInterface, 16);
      expect(sizes.sizePrompt, 16);
      expect(sizes.sizeCode, 13);
    });

    test('clamps: interface 12-20, prompt 12-20, code 10-18', () {
      expect(resolveFontSizes(interface: 5).sizeInterface, 12);
      expect(resolveFontSizes(interface: 99).sizeInterface, 20);
      expect(resolveFontSizes(prompt: 5).sizePrompt, 16);
      expect(resolveFontSizes(prompt: 99).sizePrompt, 20);
      expect(resolveFontSizes(code: 5).sizeCode, 10);
      expect(resolveFontSizes(code: 99).sizeCode, 18);
    });

    test('the prompt floor is max(size, 16)', () {
      expect(resolveFontSizes(prompt: 12).sizePrompt, 16);
      expect(resolveFontSizes(prompt: 15).sizePrompt, 16);
      expect(resolveFontSizes(prompt: 17).sizePrompt, 17);
    });

    test('malformed values degrade to the defaults', () {
      expect(resolveFontSizes(interface: 'nope').sizeInterface, 16);
      expect(resolveFontSizes(prompt: true).sizePrompt, 16);
    });
  });

  group('T86 — font stacks (appearanceFonts.ts:16-61)', () {
    test('the default stacks are the stylesheet strings verbatim', () {
      expect(kSansFontStack,
          '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif');
      expect(kMonoFontStack,
          'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas,'
          ' "Liberation Mono", monospace');
    });

    test('a user family is prepended to the stack', () {
      final families = resolveFontFamilies(sans: 'Comic Sans');
      // A multi-word name gets quoted (appearanceFonts.ts:33-44).
      expect(families.sans, '"Comic Sans", $kSansFontStack');
      expect(families.mono, kMonoFontStack);
    });

    test('multi-family lists keep their order and get quoted', () {
      final families = resolveFontFamilies(mono: 'My Mono, System Mono');
      // Multi-word names get quoted (appearanceFonts.ts:33-44).
      expect(families.mono, '"My Mono", "System Mono", $kMonoFontStack');
    });

    test('already-quoted and ident names pass through unquoted', () {
      final families = resolveFontFamilies(sans: '"My Font", Roboto');
      expect(families.sans, '"My Font", Roboto, $kSansFontStack');
    });

    test('an empty or blank pref keeps the default stack', () {
      expect(resolveFontFamilies(sans: '  ').sans, kSansFontStack);
      expect(resolveFontFamilies(sans: null).sans, kSansFontStack);
    });

    test('the composer falls back to the resolved sans stack', () {
      final families = resolveFontFamilies(sans: 'A', composer: 'B');
      expect(families.composer, 'B, A, $kSansFontStack');
      expect(resolveFontFamilies().composer, isNull);
    });
  });

  group('T86 — contrast percentages (settings.ts:100-107, appearanceContrast.ts)', () {
    test('the default pref 100 mixes nothing', () {
      const c = JhinContrast.neutral;
      expect(c.base, 100);
      expect(c.boost, 0);
      expect(c.borderBoost, 0);
    });

    test('pref 130 boosts 30% and the border a quarter of it', () {
      final c = JhinContrast.fromPref(130);
      expect(c.base, 100);
      expect(c.boost, 30);
      expect(c.borderBoost, 7);
    });

    test('pref 200 boosts 100% and the border 25%', () {
      final c = JhinContrast.fromPref(200);
      expect(c.boost, 100);
      expect(c.borderBoost, 25);
    });

    test('pref 70 softens the base to 70% with no boost', () {
      final c = JhinContrast.fromPref(70);
      expect(c.base, 70);
      expect(c.boost, 0);
      expect(c.borderBoost, 0);
    });

    test('out-of-range and malformed prefs degrade to the default', () {
      expect(JhinContrast.fromPref(10).pref, 100);
      expect(JhinContrast.fromPref(999).pref, 100);
      expect(JhinContrast.fromPref('nope').pref, 100);
    });
  });

  group('T86 — contrast mixes', () {
    test('srgb mix lerps the channels and the alpha', () {
      final mixed = jhinMixSrgb(
          const Color(0xFF000000), const Color(0xFFFFFFFF), 0.5);
      expect(mixed, const Color(0xFF808080));
      final faded = jhinMixSrgb(
          const Color(0xFF102030), const Color(0x00000000), 0.5);
      expect(faded.a, closeTo(0.5, 0.001));
    });

    test('oklab mix moves toward the target monotonically', () {
      const black = Color(0xFF000000);
      const white = Color(0xFFFFFFFF);
      final quarter = jhinMixOklab(black, white, 0.25);
      final half = jhinMixOklab(black, white, 0.5);
      final threeQuarters = jhinMixOklab(black, white, 0.75);
      expect(quarter.computeLuminance(), lessThan(half.computeLuminance()));
      expect(half.computeLuminance(), lessThan(threeQuarters.computeLuminance()));
      // The mix endpoints are the inputs.
      expect(jhinMixOklab(black, white, 0.0), black);
      expect(jhinMixOklab(black, white, 1.0), white);
    });

    test('resolveContrastColors boosts the foreground toward the dark target',
        () {
      final palette = {
        'foreground': const Color(0xFFAAAAAA),
        'background': const Color(0xFF111111),
      };
      final neutral = resolveContrastColors(
          palette: palette, dark: true, contrast: JhinContrast.neutral);
      final boosted = resolveContrastColors(
          palette: palette,
          dark: true,
          contrast: JhinContrast.fromPercent(130));
      expect(neutral['contrast-foreground'], const Color(0xFFAAAAAA));
      final boostedColor = boosted['contrast-foreground']!;
      // The boost pulls the foreground toward white in dark mode.
      expect(boostedColor.computeLuminance(),
          greaterThan(const Color(0xFFAAAAAA).computeLuminance()));
    });

    test('the border boost mixes toward the palette foreground, not the target',
        () {
      final palette = {
        'border': const Color(0x66222222),
        'foreground': const Color(0xFFEEEEEE),
      };
      final boosted = resolveContrastColors(
          palette: palette,
          dark: true,
          contrast: JhinContrast.fromPercent(200));
      final border = boosted['contrast-border']!;
      // 25% toward #EEEEEE: the red channel rises from 0x22 toward 0xEE
      // (the component accessors are 0-1 normalized).
      expect(border.r, greaterThan(0x22 / 255.0));
      expect(border.a, lessThan(1.0));
    });
  });

  group('T86 — the data switches', () {
    test('chat width: default 46rem, wide 72rem, full 100%', () {
      expect(JhinSwitches.defaults.chatLaneRem, 46);
      expect(
          JhinSwitches.parse({'chatWidth': 'wide'}).chatLaneRem, 72);
      expect(
          JhinSwitches.parse({'chatWidth': 'full'}).chatLaneRem, isNull);
      // The upstream literal `comfortable` parses to the default lane.
      expect(
          JhinSwitches.parse({'chatWidth': 'comfortable'}).chatLaneRem, 46);
      // The lane width scales with the interface size (the root font-size).
      expect(JhinSwitches.defaults.chatLaneWidthPx(), 46 * 16.0);
      expect(
        JhinSwitches.parse({'chatWidth': 'wide'}).chatLaneWidthPx(),
        72 * 16.0,
      );
      expect(
          JhinSwitches.parse({'chatWidth': 'full'}).chatLaneWidthPx(), isNull);
    });

    test('the diff colour scheme parses both spellings', () {
      expect(JhinSwitches.defaults.diffColorScheme,
          JhinDiffColorScheme.defaultScheme);
      expect(
          JhinSwitches.parse({'diffColorScheme': 'blue-orange'})
              .diffColorScheme,
          JhinDiffColorScheme.blueOrange);
      expect(
          JhinSwitches.parse({'diffColorScheme': 'red-green'})
              .diffColorScheme,
          JhinDiffColorScheme.defaultScheme);
    });

    test('reduced motion disables the duty-cycles and collapses the panel',
        () {
      final on = JhinSwitches.parse({'reducedMotion': true});
      expect(on.reducedMotion, isTrue);
      expect(on.statusPulseEnabled, isFalse);
      expect(on.statusPingEnabled, isFalse);
      expect(on.skeletonEnabled, isFalse);
      expect(on.resolveMotionPanel(const Duration(milliseconds: 200)),
          Duration.zero);
      final off = JhinSwitches.defaults;
      expect(off.skeletonEnabled, isTrue);
      expect(off.resolveMotionPanel(const Duration(milliseconds: 200)),
          const Duration(milliseconds: 200));
    });

    test('the contrast pref parses from both spellings', () {
      expect(JhinSwitches.parse({'appearanceContrast': 130}).contrast.boost,
          30);
      expect(JhinSwitches.parse({'contrastBoost': 30}).contrast.boost, 30);
      expect(JhinSwitches.parse({'appearanceContrast': 70}).contrast.base, 70);
      expect(JhinSwitches.defaults.contrast, JhinContrast.neutral);
    });

    test('density parses through the §1 lattice', () {
      expect(JhinSwitches.parse({'density': 'compact'}).density,
          JhinDensity.compact);
      expect(JhinSwitches.parse({'density': 'nonsense'}).density,
          JhinDensity.comfortable);
    });
  });

  group('T86 — the diff colours', () {
    test('the default scheme keeps the theme tokens', () {
      const added = Color(0xFF00B981);
      const removed = Color(0xFFE40016);
      final colors = resolveDiffColors(
        scheme: JhinDiffColorScheme.defaultScheme,
        themeAdded: added,
        themeRemoved: removed,
        dark: false,
      );
      expect(colors.added, added);
      expect(colors.removed, removed);
    });

    test('blue-orange swaps the lanes to the fixed pair', () {
      final light = resolveDiffColors(
        scheme: JhinDiffColorScheme.blueOrange,
        themeAdded: const Color(0xFF00B981),
        themeRemoved: const Color(0xFFE40016),
        dark: false,
      );
      final dark = resolveDiffColors(
        scheme: JhinDiffColorScheme.blueOrange,
        themeAdded: const Color(0xFF00B981),
        themeRemoved: const Color(0xFFE40016),
        dark: true,
      );
      // Blue addition, orange removal; the dark slot is the lighter pair.
      expect(light.added.computeLuminance(),
          lessThan(dark.added.computeLuminance()));
      expect(light.removed, isNot(dark.removed));
      expect(light.added, isNot(light.removed));
    });
  });
}
