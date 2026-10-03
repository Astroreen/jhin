import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:jhin/design/theme.dart';
import 'package:jhin/design/tokens.dart';

void main() {
  group('JhinTheme.from — defaults', () {
    test('absent payload → default accent/canvas, system appearance', () {
      final theme = JhinTheme.from();
      expect(theme.themeMode, ThemeMode.system);
      expect(theme.light.colorScheme.primary, JhinTheme.defaultAccent);
      expect(theme.dark.colorScheme.primary, JhinTheme.defaultAccent);
      expect(theme.dark.colorScheme.surface, JhinTheme.defaultCanvas);
      // The light scheme keeps its generated (light) surface.
      expect(theme.light.colorScheme.brightness, Brightness.light);
      expect(theme.light.colorScheme.surface, isNot(JhinTheme.defaultCanvas));
    });

    test('MaterialApp contract: non-null theme, darkTheme and themeMode', () {
      final theme = JhinTheme.from();
      expect(theme.light, isNotNull);
      expect(theme.dark, isNotNull);
      expect(theme.themeMode, isNotNull);
    });
  });

  group('JhinTheme.from — canvas drives the matching scheme', () {
    test('a dark canvas styles the dark scheme surface family', () {
      final theme = JhinTheme.from(canvas: '#16161e');
      final dark = theme.dark.colorScheme;
      expect(dark.brightness, Brightness.dark);
      expect(dark.surface, const Color(0xFF16161E));
      // On-colors by luminance: white text on a near-black canvas.
      expect(dark.onSurface, Colors.white);
      // Container shades are small lightness steps around the canvas.
      expect(dark.surfaceContainerLow, const Color(0xFF16161E));
      expect(
          dark.surfaceContainerHighest.computeLuminance(),
          greaterThan(
              dark.surfaceContainerLowest.computeLuminance()));
    });

    test('a light canvas styles the light scheme surface family', () {
      final theme = JhinTheme.from(canvas: '#f5f5f5');
      final light = theme.light.colorScheme;
      expect(light.brightness, Brightness.light);
      expect(light.surface, const Color(0xFFF5F5F5));
      expect(light.onSurface, Colors.black);
      // The dark scheme keeps its generated dark surface.
      expect(theme.dark.colorScheme.surface, isNot(const Color(0xFFF5F5F5)));
    });

    test('the accent is the primary on both brightnesses, on-color readable',
        () {
      final theme = JhinTheme.from(accent: '#7e57c2', canvas: '#16161e');
      expect(theme.light.colorScheme.primary, const Color(0xFF7E57C2));
      expect(theme.dark.colorScheme.primary, const Color(0xFF7E57C2));
      // #7e57c2 is dark → white on-accent.
      expect(theme.light.colorScheme.onPrimary, Colors.white);
    });
  });

  group('JhinTheme.from — appearance / mode', () {
    test('appearance light/dark/system map to ThemeMode', () {
      expect(JhinTheme.from(appearance: 'light').themeMode, ThemeMode.light);
      expect(JhinTheme.from(appearance: 'dark').themeMode, ThemeMode.dark);
      expect(JhinTheme.from(appearance: 'system').themeMode, ThemeMode.system);
      expect(JhinTheme.from(appearance: 'nonsense').themeMode,
          ThemeMode.system);
    });

    test('mode is the legacy spelling; appearance wins when both are set',
        () {
      expect(JhinTheme.from(mode: 'dark').themeMode, ThemeMode.dark);
      expect(
          JhinTheme.from(appearance: 'light', mode: 'dark').themeMode,
          ThemeMode.light);
    });
  });

  group('JhinTheme.from — colors{} overrides', () {
    test('scheme-role overrides win over generation', () {
      final theme = JhinTheme.from(colors: const {
        'error': '#f7768e',
        'surface': '#101010',
        'outline': '#334455',
        'onCanvas': '#eeeeee',
        'onAccent': '#000000',
        'accent': '#ff8800',
      });
      for (final scheme in [theme.light.colorScheme, theme.dark.colorScheme]) {
        expect(scheme.error, const Color(0xFFF7768E));
        expect(scheme.surface, const Color(0xFF101010));
        expect(scheme.outline, const Color(0xFF334455));
        expect(scheme.onSurface, const Color(0xFFEEEEEE));
        expect(scheme.onPrimary, Colors.black);
        expect(scheme.primary, const Color(0xFFFF8800));
      }
    });

    test('palette-only token names stay available for \$color lookups', () {
      final theme = JhinTheme.from(colors: const {
        'success': '#9ece6a',
        'warning': '#e0af68',
        'info': '#7aa2f7',
      });
      expect(theme.tokens.resolveToken('\$color.success'),
          const Color(0xFF9ECE6A));
      expect(theme.tokens.resolveToken('\$color.warning'),
          const Color(0xFFE0AF68));
      expect(theme.tokens.resolveToken('\$color.info'), const Color(0xFF7AA2F7));
      expect(theme.tokens.resolveToken('\$color.accent'),
          JhinTheme.defaultAccent);
    });
  });

  group('JhinTheme.from — degrade on malformed input (§2.4)', () {
    test('invalid hex falls back to the defaults without throwing', () {
      final theme = JhinTheme.from(accent: 'not-hex', canvas: '##zzz');
      expect(theme.light.colorScheme.primary, JhinTheme.defaultAccent);
      expect(theme.dark.colorScheme.surface, JhinTheme.defaultCanvas);
    });

    test('garbage tokens/density/motion degrade to the built-ins', () {
      final theme = JhinTheme.from(
        tokens: const {
          'spacing': 'garbage',
          'motion': {'fast': 'nope'},
        },
        density: 'nonsense',
        motion: const {'slow': true},
      );
      expect(theme.tokens.spacing.md, 12);
      expect(theme.tokens.motion.fast, const Duration(milliseconds: 120));
      expect(theme.tokens.motion.slow, const Duration(milliseconds: 320));
      expect(theme.tokens.density, JhinDensity.comfortable);
    });

    test('fromBootstrap tolerates a null or malformed payload', () {
      expect(JhinTheme.fromBootstrap(null).themeMode, ThemeMode.system);
      final theme = JhinTheme.fromBootstrap(const {
        'theme': 'garbage',
        'tokens': 42,
        'density': {'x': 1},
      });
      expect(theme.themeMode, ThemeMode.system);
      expect(theme.tokens.spacing.md, 12);
    });

    test('fromBootstrap reads theme/tokens/density of a §1 payload', () {
      final theme = JhinTheme.fromBootstrap(const {
        'theme': {
          'appearance': 'dark',
          'canvas': '#16161e',
          'accent': '#7e57c2',
          'colors': {'error': '#f7768e'},
          'mode': 'dark',
        },
        'tokens': {
          'spacing': {'md': 20},
        },
        'density': 'comfortable',
      });
      expect(theme.themeMode, ThemeMode.dark);
      expect(theme.tokens.spacing.md, 20);
      expect(theme.dark.colorScheme.error, const Color(0xFFF7768E));
      expect(theme.dark.colorScheme.surface, const Color(0xFF16161E));
    });
  });

  group('JhinTheme — reduced motion (§1)', () {
    test('withZeroMotion collapses every duration to zero', () {
      final theme = JhinTheme.from().withZeroMotion();
      expect(theme.tokens.motion.instant, Duration.zero);
      expect(theme.tokens.motion.fast, Duration.zero);
      expect(theme.tokens.motion.normal, Duration.zero);
      expect(theme.tokens.motion.slow, Duration.zero);
      expect(theme.tokens.motion.panel, Duration.zero);
      // The rest of the lattice is untouched.
      expect(theme.tokens.spacing.md, 12);
    });
  });

  group('JhinDesignScope', () {
    testWidgets('of() returns the installed design', (tester) async {
      JhinTheme? captured;
      await tester.pumpWidget(JhinDesignScope(
        design: JhinTheme.from(appearance: 'dark'),
        child: Builder(
          builder: (context) {
            captured = JhinDesignScope.of(context);
            return const SizedBox();
          },
        ),
      ));
      expect(captured, isNotNull);
      expect(captured!.themeMode, ThemeMode.dark);
    });

    testWidgets('of() falls back to the built-in design without a scope',
        (tester) async {
      JhinTheme? captured;
      await tester.pumpWidget(Builder(
        builder: (context) {
          captured = JhinDesignScope.of(context);
          return const SizedBox();
        },
      ));
      expect(captured!.themeMode, ThemeMode.system);
      expect(captured!.tokens.spacing.md, 12);
    });

    testWidgets('disableAnimations collapses motion to zero (§1)', (tester) async {
      JhinTheme? captured;
      await tester.pumpWidget(MediaQuery(
        data: const MediaQueryData(disableAnimations: true),
        child: JhinDesignScope(
          design: JhinTheme.fallback(),
          child: Builder(
            builder: (context) {
              captured = JhinDesignScope.of(context);
              return const SizedBox();
            },
          ),
        ),
      ));
      expect(captured!.tokens.motion.fast, Duration.zero);
      expect(captured!.tokens.motion.slow, Duration.zero);
      expect(captured!.tokens.resolveToken('\$motion.fast'), Duration.zero);
    });

    testWidgets('without disableAnimations the server durations stand',
        (tester) async {
      JhinTheme? captured;
      await tester.pumpWidget(MediaQuery(
        data: const MediaQueryData(disableAnimations: false),
        child: JhinDesignScope(
          design: JhinTheme.fallback(),
          child: Builder(
            builder: (context) {
              captured = JhinDesignScope.of(context);
              return const SizedBox();
            },
          ),
        ),
      ));
      expect(captured!.tokens.motion.fast, const Duration(milliseconds: 120));
    });
  });
}
