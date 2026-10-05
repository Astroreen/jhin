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
///
/// T86: the theme also carries the runtime switches ([JhinSwitches], parsed
/// from the client appearance prefs) and resolves the `contrast-*`
/// indirection per brightness ([colorOf]): every contrast foreground is the
/// two-stage `color-mix` of its source toward its surface and then toward
/// the target — black in light, white in dark — with the boost percentages
/// from the appearance contrast pref.
class JhinTheme {
  JhinTheme({
    required this.light,
    required this.dark,
    required this.themeMode,
    required this.tokens,
    this.switches = JhinSwitches.defaults,
    this.stageArt = const {},
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
    Map<Object?, Object?>? prefs,
    Map<String, dynamic>? stageArt,
  }) {
    final accentColor = parseColor(accent) ?? defaultAccent;
    final canvasColor = parseColor(canvas) ?? defaultCanvas;
    final parsedDensity = JhinDensity.parse(density);
    final lattice = JhinTokens.fromOverrides(tokens,
        density: parsedDensity, motion: motion);
    final switches = JhinSwitches.parse(prefs);

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
      light: _lightTheme(lightScheme, lattice, parsedDensity, switches),
      dark: _darkTheme(darkScheme, lattice, parsedDensity, switches),
      themeMode: _themeMode(appearance ?? mode),
      tokens: lattice.withColors(palette),
      switches: switches,
      stageArt: _stageArt(stageArt),
    );
  }

  /// Parses the `theme.stageArt` hex map (T95): every value through
  /// [parseColor]; unparseable entries drop out — never throws.
  static Map<String, Color> _stageArt(Map<String, dynamic>? raw) {
    if (raw == null) return const {};
    final out = <String, Color>{};
    raw.forEach((key, value) {
      final color = parseColor(value);
      if (color != null) out[key] = color;
    });
    return out;
  }

  /// Builds the theme pair from a whole bootstrap payload (§1): reads
  /// `theme`, `tokens` and `density`; absent or malformed payload → the
  /// built-in defaults. [prefs] carries the client-side appearance switches
  /// (T86) — the contrast pref, the data switches and the font prefs.
  factory JhinTheme.fromBootstrap(
    Map<String, dynamic>? payload, {
    Map<Object?, Object?>? prefs,
  }) {
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
    final stageArt = theme['stageArt'] is Map
        ? Map<String, dynamic>.from(theme['stageArt'] as Map)
        : null;
    return JhinTheme.from(
      appearance: theme['appearance'],
      mode: theme['mode'],
      canvas: theme['canvas'],
      accent: theme['accent'],
      colors: colors,
      tokens: tokens,
      density: map['density'],
      prefs: prefs,
      stageArt: stageArt,
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

  /// The runtime switches (T86): contrast pref, chat width, diff colour
  /// scheme, density, reduced motion and the font prefs.
  final JhinSwitches switches;

  /// The stage-art backdrop tokens of the selected theme (T95): the
  /// `theme.stageArt` hex map parsed to colors, keyed by the upstream
  /// variable names (`stage-art-top`, `stage-art-mid`, `stage-art-bottom`,
  /// `stage-art-highlight`, `stage-art-line`). Empty when the payload
  /// carries none — the shell then paints no backdrop.
  final Map<String, Color> stageArt;

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
        switches: switches,
        stageArt: stageArt,
      );

  /// The contrast-resolved `contrast-*` colors for the light brightness
  /// (T86): the two-stage mixes of the `contrast` sub-map with the boost
  /// percentages from the appearance pref.
  late final Map<String, Color> contrastLight = _contrastFor(false);

  /// The contrast-resolved `contrast-*` colors for the dark brightness.
  late final Map<String, Color> contrastDark = _contrastFor(true);

  Map<String, Color> _contrastFor(bool isDark) => resolveContrastColors(
        palette: _basePalette(
          isDark ? dark.colorScheme : light.colorScheme,
          tokens.colors,
        ),
        dark: isDark,
        contrast: switches.contrast,
      );

  /// The palette the contrast recipes resolve against: the theme palette
  /// (`theme.colors`, the PaletteGen names) wins; the assembled scheme fills
  /// the recipe inputs a bare theme leaves out.
  static Map<String, Color> _basePalette(
    ColorScheme scheme,
    Map<String, Color> palette,
  ) =>
      {
        'accent': scheme.primary,
        'accent-foreground': scheme.onPrimary,
        'background': scheme.surface,
        'border': scheme.outline,
        'card': scheme.surfaceContainerHighest,
        'card-foreground': scheme.onSurface,
        'foreground': scheme.onSurface,
        'icon-muted': scheme.onSurfaceVariant,
        'input': scheme.outlineVariant,
        'message': scheme.surfaceContainer,
        'message-foreground': scheme.onSurface,
        'muted-foreground': scheme.onSurfaceVariant,
        'placeholder': scheme.onSurfaceVariant,
        'popover': scheme.surfaceContainerHighest,
        'popover-foreground': scheme.onSurface,
        'secondary': scheme.surfaceContainerHigh,
        'secondary-foreground': scheme.onSurface,
        'secondary-label': scheme.onSurfaceVariant,
        'sidebar': scheme.surfaceContainerLow,
        'sidebar-border': scheme.outline,
        'sidebar-foreground': scheme.onSurface,
        'sidebar-muted-foreground': scheme.onSurfaceVariant,
        ...palette,
      };

  /// Resolves one token-surface `color` name against the active theme
  /// (T86): a `var(--contrast-*)` reference reads the contrast-resolved map
  /// for [brightness], any other `var(--*)` reference reads the palette,
  /// and a bare palette name falls back to the palette itself. Unknown
  /// names resolve to null — the caller keeps the literal (§2.4).
  Color? colorOf(String name, {Brightness brightness = Brightness.light}) {
    final raw = tokens.surface.value('color', name);
    if (raw is String && raw.startsWith('var(--') && raw.endsWith(')')) {
      final varName = raw.substring(6, raw.length - 1);
      final contrast = brightness == Brightness.dark ? contrastDark : contrastLight;
      return contrast[varName] ?? tokens.colors[varName];
    }
    return tokens.colors[name];
  }

  /// Resolves one token-surface key against the active theme (§4.3): a
  /// `{light, dark}` variant map collapses to the [brightness] entry, a
  /// `{base, sm}` map to its base step (the responsive bump is a layout
  /// concern), and everything else is the mirrored value — including the
  /// `text` `{size, lineHeight}` pairs, which are not theme-dependent.
  ///
  /// The `color` family resolves through [colorOf] (the contrast
  /// indirection, T86). Unknown families and keys resolve to null — never
  /// throws.
  Object? resolve(String family, String key,
      {Brightness brightness = Brightness.light}) {
    if (family == 'color') {
      return colorOf(key, brightness: brightness) ??
          tokens.surface.value(family, key);
    }
    final value = tokens.surface.value(family, key);
    if (value is Map) {
      final map = Map<String, Object?>.from(value);
      if (map.containsKey('light') && map.containsKey('dark')) {
        return brightness == Brightness.dark ? map['dark'] : map['light'];
      }
      if (map.containsKey('base') && map.containsKey('sm')) {
        return map['base'];
      }
    }
    return value;
  }

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
  /// `primary`/`accent`→primary, `primary-foreground`/`onAccent`→onPrimary,
  /// `onCanvas`→onSurface, `surface`→surface, `error`→error,
  /// `outline`→outline. The token-named pair (`primary`,
  /// `primary-foreground`) wins when both spellings are present: the
  /// generated palette carries them with upstream's meaning (`--primary` is
  /// the companion message action, index.css:1246), while `accent` keeps
  /// the brand-seed reading of the §1 example. The remaining token names
  /// (`success`, `warning`, `info`, `accentHover`, `accentMuted`, …) stay
  /// palette-only.
  static ColorScheme _applyOverrides(ColorScheme scheme, Map<String, Color> overrides) {
    return scheme.copyWith(
      primary: overrides['primary'] ?? overrides['accent'],
      onPrimary: overrides['primary-foreground'] ?? overrides['onAccent'],
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
    JhinSwitches switches,
  ) =>
      _themeData(scheme, tokens, density, switches);

  static ThemeData _darkTheme(
    ColorScheme scheme,
    JhinTokens tokens,
    JhinDensity density,
    JhinSwitches switches,
  ) =>
      _themeData(scheme, tokens, density, switches);

  /// The [ThemeData] assembled from the token layer (T86): the scheme from
  /// the palette generation, the visual density from the §1 density, the
  /// text theme from the typography seeds scaled by the interface font size
  /// (the upstream root font-size scales every rem-based dimension,
  /// appearanceFonts.ts:95-99) and the resolved sans stack as the default
  /// family (the user pref prepended, appearanceFonts.ts:58-61).
  static ThemeData _themeData(
    ColorScheme scheme,
    JhinTokens tokens,
    JhinDensity density,
    JhinSwitches switches,
  ) {
    final (family, fallback) = _familyParts(switches.fontFamilies.sans);
    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      visualDensity: density.visualDensity,
      fontFamily: family.isEmpty ? null : family,
      fontFamilyFallback: fallback.isEmpty ? null : fallback,
      textTheme: _textTheme(tokens.typography, scheme.onSurface, switches),
      scaffoldBackgroundColor: scheme.surface,
    );
  }

  /// Splits a CSS font-family stack into Flutter's `fontFamily` +
  /// `fontFamilyFallback`: the first family leads, the rest back it up.
  /// Quotes are stripped (Flutter matches family names unquoted) and empty
  /// entries dropped.
  static (String, List<String>) _familyParts(String stack) {
    final parts = <String>[];
    final buffer = StringBuffer();
    var inQuote = false;
    for (var i = 0; i < stack.length; i++) {
      final ch = stack[i];
      if (ch == '"' || ch == "'") {
        inQuote = !inQuote;
        continue;
      }
      if (ch == ',' && !inQuote) {
        parts.add(buffer.toString().trim());
        buffer.clear();
        continue;
      }
      buffer.write(ch);
    }
    parts.add(buffer.toString().trim());
    final clean = parts.where((part) => part.isNotEmpty).toList();
    if (clean.isEmpty) return ('', const []);
    return (clean.first, clean.sublist(1));
  }

  /// The token typography seeds as the Material roles the primitives read:
  /// h1→headlineMedium, h2→headlineSmall, h3→titleLarge, body→bodyMedium,
  /// small→bodySmall. Every size scales by the interface font size over its
  /// 16px base (the rem equivalent); at the default 16 the seeds stand
  /// unchanged.
  static TextTheme _textTheme(
    JhinTypography typography,
    Color onSurface,
    JhinSwitches switches,
  ) {
    final scale = switches.fontSizes.sizeInterface / 16.0;
    TextStyle role(TextStyle style) => style.copyWith(
          fontSize: scale == 1.0 ? null : (style.fontSize ?? 14) * scale,
          color: onSurface,
        );
    return TextTheme(
      headlineMedium: role(typography.h1),
      headlineSmall: role(typography.h2),
      titleLarge: role(typography.h3),
      bodyMedium: role(typography.body),
      bodySmall: role(typography.small),
    );
  }
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
  ///
  /// Motion collapses to zero when the OS reduced-motion preference
  /// (`MediaQuery.disableAnimations`, §1) OR the user's own reduced-motion
  /// switch (T86) is on.
  static JhinTheme of(BuildContext context) {
    final scope =
        context.dependOnInheritedWidgetOfExactType<JhinDesignScope>();
    var design = scope?.design ?? JhinTheme.fallback();
    final media = MediaQuery.maybeOf(context);
    if ((media?.disableAnimations ?? false) || design.switches.reducedMotion) {
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
