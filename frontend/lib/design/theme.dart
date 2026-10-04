import 'package:flutter/material.dart';

import '../sdui/ui_registry.dart' show parseColor;
import 'tokens.dart';

/// The generated app theme (docs/sdui.md §1): a light + dark [ThemeData]
/// pair generated from the T3-style short theme format
/// `{appearance, canvas, accent, colors{}}`, plus the token lattice.
///
/// Generation: `ColorScheme.fromSeed(seed: accent)` as the base; the canvas
/// color drives the surface/background family of the scheme matching its
/// luminance (a dark canvas styles the dark scheme, a light canvas the
/// light one); on-colors are picked by luminance; `colors{}` overrides win
/// last, by token name. Invalid hex values degrade to the defaults
/// (`#7E57C2` accent, `#16161e` canvas) — never throws.
class JhinTheme {
  JhinTheme({
    required this.light,
    required this.dark,
    required this.themeMode,
    required this.tokens,
  });

  /// Default accent when the payload has none (or an invalid one).
  static const Color defaultAccent = Color(0xFF7E57C2);

  /// Default canvas when the payload has none (or an invalid one).
  static const Color defaultCanvas = Color(0xFF16161E);

  /// Builds the theme pair from the §1 `theme` block fields.
  ///
  /// - `appearance` (`system|light|dark`) → [ThemeMode]; `mode` is the
  ///   legacy level-1 spelling of the same idea and is used when
  ///   `appearance` is absent.
  /// - `colors` overrides are keyed by token name (`error`, `success`,
  ///   `warning`, `info`, `surface`, `outline`, `onCanvas`, `onAccent`,
  ///   `accentHover`, `accentMuted`, …); the scheme roles they map to are
  ///   applied last, the rest stay palette-only (`$color.*` lookups).
  /// - `tokens` overrides the built-in token lattice key-by-key; `density`
  ///   scales spacing; `motion` (raw ms map) merges over `tokens.motion`.
  factory JhinTheme.from({
    Object? appearance,
    Object? mode,
    Object? canvas,
    Object? accent,
    Map<String, dynamic>? colors,
    Map<String, dynamic>? tokens,
    Object? density,
    Map<String, dynamic>? motion,
  }) {
    final accentColor = parseColor(accent) ?? defaultAccent;
    final canvasColor = parseColor(canvas) ?? defaultCanvas;
    final parsedDensity = JhinDensity.parse(density);
    final lattice = JhinTokens.fromOverrides(tokens,
        density: parsedDensity, motion: motion);

    final canvasIsDark = canvasColor.computeLuminance() < 0.5;
    final onCanvas = _readableOn(canvasColor);
    final onAccent = _readableOn(accentColor);
    final overrides = _colorOverrides(colors);

    var lightScheme = ColorScheme.fromSeed(
        seedColor: accentColor, brightness: Brightness.light);
    var darkScheme = ColorScheme.fromSeed(
        seedColor: accentColor, brightness: Brightness.dark);
    // The accent is the brand color on both brightnesses.
    lightScheme =
        lightScheme.copyWith(primary: accentColor, onPrimary: onAccent);
    darkScheme = darkScheme.copyWith(primary: accentColor, onPrimary: onAccent);
    // The canvas drives the surface family of the scheme matching its
    // luminance; the other scheme keeps its generated light/dark surfaces.
    lightScheme = canvasIsDark
        ? lightScheme
        : _applyCanvas(lightScheme, canvasColor, onCanvas, dark: false);
    darkScheme = canvasIsDark
        ? _applyCanvas(darkScheme, canvasColor, onCanvas, dark: true)
        : darkScheme;
    // `colors{}` overrides win last, by token name.
    lightScheme = _applyOverrides(lightScheme, overrides);
    darkScheme = _applyOverrides(darkScheme, overrides);

    final palette = <String, Color>{
      'accent': accentColor,
      'canvas': canvasColor,
      'onCanvas': onCanvas,
      'onAccent': onAccent,
      ...overrides,
    };

    return JhinTheme(
      light: _lightTheme(lightScheme, lattice, parsedDensity),
      dark: _darkTheme(darkScheme, lattice, parsedDensity),
      themeMode: _themeMode(appearance ?? mode),
      tokens: lattice.withColors(palette),
    );
  }

  /// Builds the theme pair from a whole bootstrap payload (§1): reads
  /// `theme`, `tokens` and `density`; absent or malformed payload → the
  /// built-in defaults.
  factory JhinTheme.fromBootstrap(Map<String, dynamic>? payload) {
    final map = payload ?? const {};
    final theme = map['theme'] is Map
        ? Map<String, dynamic>.from(map['theme'] as Map)
        : const <String, dynamic>{};
    final tokens = map['tokens'] is Map
        ? Map<String, dynamic>.from(map['tokens'] as Map)
        : null;
    final colors = theme['colors'] is Map
        ? Map<String, dynamic>.from(theme['colors'] as Map)
        : null;
    return JhinTheme.from(
      appearance: theme['appearance'],
      mode: theme['mode'],
      canvas: theme['canvas'],
      accent: theme['accent'],
      colors: colors,
      tokens: tokens,
      density: map['density'],
    );
  }

  /// The light-brightness [ThemeData].
  final ThemeData light;

  /// The dark-brightness [ThemeData].
  final ThemeData dark;

  /// `appearance` (`system|light|dark`) as a [ThemeMode].
  final ThemeMode themeMode;

  /// The token lattice; `colors` carries the `$color.*` palette.
  final JhinTokens tokens;

  /// The fallback theme: built-in tokens, default accent/canvas, system
  /// appearance. Used when no bootstrap theme has arrived (or no scope is
  /// installed above the node).
  factory JhinTheme.fallback() => JhinTheme.from();

  /// A copy with every motion duration collapsed to zero — the OS
  /// reduced-motion preference (§1).
  JhinTheme withZeroMotion() => JhinTheme(
        light: light,
        dark: dark,
        themeMode: themeMode,
        tokens: tokens.withZeroMotion(),
      );

  static ThemeMode _themeMode(Object? appearance) {
    switch (appearance) {
      case 'light':
        return ThemeMode.light;
      case 'dark':
        return ThemeMode.dark;
      default:
        return ThemeMode.system;
    }
  }

  /// Readable text color on [background]: black on light backgrounds,
  /// white on dark ones (luminance threshold 0.5).
  static Color _readableOn(Color background) =>
      background.computeLuminance() > 0.5 ? Colors.black : Colors.white;

  /// Shifts the HSL lightness of [color] by [delta] (clamped to 0–1).
  static Color _shift(Color color, double delta) {
    final hsl = HSLColor.fromColor(color);
    return hsl
        .withLightness((hsl.lightness + delta).clamp(0.0, 1.0))
        .toColor();
  }

  /// Applies the canvas surface/background family: the surface itself, its
  /// container shades (small HSL lightness steps around the canvas) and the
  /// on-colors picked by luminance.
  static ColorScheme _applyCanvas(
    ColorScheme base,
    Color canvas,
    Color onCanvas, {
    required bool dark,
  }) {
    final double towardsLight = dark ? 1 : -1;
    return base.copyWith(
      surface: canvas,
      onSurface: onCanvas,
      onSurfaceVariant: onCanvas,
      surfaceContainerLowest: _shift(canvas, -0.03 * towardsLight),
      surfaceContainerLow: canvas,
      surfaceContainer: _shift(canvas, 0.02 * towardsLight),
      surfaceContainerHigh: _shift(canvas, 0.04 * towardsLight),
      surfaceContainerHighest: _shift(canvas, 0.06 * towardsLight),
    );
  }

  /// Parses the `colors{}` override map; invalid hex entries are skipped
  /// silently (§2.4).
  static Map<String, Color> _colorOverrides(Map<String, dynamic>? colors) {
    final out = <String, Color>{};
    colors?.forEach((name, value) {
      final color = parseColor(value);
      if (color != null) out[name] = color;
    });
    return out;
  }

  /// Applies `colors{}` overrides to the scheme roles they map to:
  /// `accent`→primary, `onAccent`→onPrimary, `onCanvas`→onSurface,
  /// `surface`→surface, `error`→error, `outline`→outline. The remaining
  /// token names (`success`, `warning`, `info`, `accentHover`,
  /// `accentMuted`, …) stay palette-only.
  static ColorScheme _applyOverrides(ColorScheme scheme, Map<String, Color> overrides) {
    return scheme.copyWith(
      primary: overrides['accent'] ?? overrides['primary'],
      onPrimary: overrides['onAccent'],
      onSurface: overrides['onCanvas'],
      surface: overrides['surface'],
      error: overrides['error'],
      outline: overrides['outline'],
    );
  }

  static ThemeData _lightTheme(
    ColorScheme scheme,
    JhinTokens tokens,
    JhinDensity density,
  ) =>
      ThemeData(
        useMaterial3: true,
        colorScheme: scheme,
        visualDensity: density.visualDensity,
        textTheme: _textTheme(tokens.typography, scheme.onSurface),
        scaffoldBackgroundColor: scheme.surface,
      );

  static ThemeData _darkTheme(
    ColorScheme scheme,
    JhinTokens tokens,
    JhinDensity density,
  ) =>
      ThemeData(
        useMaterial3: true,
        colorScheme: scheme,
        visualDensity: density.visualDensity,
        textTheme: _textTheme(tokens.typography, scheme.onSurface),
        scaffoldBackgroundColor: scheme.surface,
      );

  /// The token typography seeds as the Material roles the primitives read:
  /// h1→headlineMedium, h2→headlineSmall, h3→titleLarge, body→bodyMedium,
  /// small→bodySmall.
  static TextTheme _textTheme(JhinTypography typography, Color onSurface) =>
      TextTheme(
        headlineMedium: typography.h1.copyWith(color: onSurface),
        headlineSmall: typography.h2.copyWith(color: onSurface),
        titleLarge: typography.h3.copyWith(color: onSurface),
        bodyMedium: typography.body.copyWith(color: onSurface),
        bodySmall: typography.small.copyWith(color: onSurface),
      );
}

/// Installs the [JhinTheme] above the navigator content so every SDUI node
/// (and primitive) can read the tokens and palette.
///
/// [of] also honors the OS reduced-motion preference (§1): when
/// `MediaQuery.disableAnimations` is set, the returned theme carries a
/// token lattice with every motion duration collapsed to zero.
class JhinDesignScope extends InheritedWidget {
  const JhinDesignScope({super.key, required this.design, required super.child});

  /// The theme pair + tokens in effect.
  final JhinTheme design;

  /// The design in effect at [context]; the built-in fallback when no scope
  /// is installed (tests, bare harnesses). Never throws.
  static JhinTheme of(BuildContext context) {
    final scope =
        context.dependOnInheritedWidgetOfExactType<JhinDesignScope>();
    var design = scope?.design ?? JhinTheme.fallback();
    final media = MediaQuery.maybeOf(context);
    if (media?.disableAnimations ?? false) {
      design = design.withZeroMotion();
    }
    return design;
  }

  /// The resolved Material [ThemeData] at [context].
  ///
  /// The token layer's only bridge to [Theme.of]: the themes generated from
  /// the token lattice are installed on the app's `MaterialApp`, so every
  /// Material lookup outside `design/` (colorScheme, disabled, hover,
  /// divider) goes through this accessor and `Theme.of` stays confined to
  /// this layer.
  static ThemeData materialOf(BuildContext context) => Theme.of(context);

  @override
  bool updateShouldNotify(JhinDesignScope oldWidget) =>
      design != oldWidget.design;
}
