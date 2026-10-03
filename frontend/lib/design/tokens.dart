import 'package:flutter/material.dart';

/// Design-token lattice of the SDUI contract (docs/sdui.md §1).
///
/// The bootstrap payload may override every group key-by-key; absent keys
/// keep the built-in defaults documented in §1. All numbers are logical px.
///
/// Density (`compact | comfortable | spacious`, §1) scales the spacing
/// group: compact 0.75×, comfortable 1.0×, spacious 1.25×. The scale is
/// applied to the final spacing values (server overrides included), because
/// density is a client-side control-density preference.
///
/// `$size.*` and `$font.*` are client-side namespaces (§2.2): layout
/// constants and font families the server cannot override through the
/// `tokens` block.
class JhinTokens {
  JhinTokens({
    required this.spacing,
    required this.radius,
    required this.typography,
    required this.elevation,
    required this.motion,
    this.density = JhinDensity.comfortable,
    this.sizes = defaultSizes,
    this.colors = const {},
  });

  /// Built-in defaults (§1), optionally overridden key-by-key.
  factory JhinTokens.defaults({JhinDensity density = JhinDensity.comfortable}) =>
      JhinTokens.fromOverrides(null, density: density);

  /// Builds the lattice from a bootstrap `tokens` override map (§1):
  /// `{spacing: {…}, radius: {…}, typography: {…}, elevation: {…}, motion: {…}}`.
  ///
  /// [density] scales the final spacing values; [motion] (a raw ms map)
  /// merges over `tokens.motion` and wins. Unknown or malformed keys keep
  /// the built-in default — never throws.
  factory JhinTokens.fromOverrides(
    Map<String, dynamic>? overrides, {
    Object? density,
    Map<String, dynamic>? motion,
  }) {
    final parsedDensity = JhinDensity.parse(density);
    final scale = parsedDensity.spacingScale;
    final raw = overrides ?? const {};
    final spacingRaw = _map(raw['spacing']) ?? const {};
    final radiusRaw = _map(raw['radius']) ?? const {};
    final elevationRaw = _map(raw['elevation']) ?? const {};
    final motionRaw = <String, dynamic>{
      ...?_map(raw['motion']),
      ...?motion,
    };
    double spacingValue(String key, double fallback) {
      final value = spacingRaw[key];
      final base = value is num ? value.toDouble() : fallback;
      return base * scale;
    }

    return JhinTokens(
      spacing: JhinSpacing(
        xs: spacingValue('xs', JhinSpacing.xsDefault),
        sm: spacingValue('sm', JhinSpacing.smDefault),
        md: spacingValue('md', JhinSpacing.mdDefault),
        lg: spacingValue('lg', JhinSpacing.lgDefault),
        xl: spacingValue('xl', JhinSpacing.xlDefault),
        xxl: spacingValue('xxl', JhinSpacing.xxlDefault),
      ),
      radius: JhinRadius(
        sm: _num(radiusRaw['sm'], JhinRadius.smDefault),
        md: _num(radiusRaw['md'], JhinRadius.mdDefault),
        lg: _num(radiusRaw['lg'], JhinRadius.lgDefault),
        full: _num(radiusRaw['full'], JhinRadius.fullDefault),
      ),
      typography: JhinTypography.fromOverrides(_map(raw['typography'])),
      elevation: JhinElevation(
        none: _num(elevationRaw['none'], JhinElevation.noneDefault),
        sm: _num(elevationRaw['sm'], JhinElevation.smDefault),
        md: _num(elevationRaw['md'], JhinElevation.mdDefault),
        lg: _num(elevationRaw['lg'], JhinElevation.lgDefault),
      ),
      motion: JhinMotion.fromMs(motionRaw),
      density: parsedDensity,
    );
  }

  /// Spacing scale (§1): xs 4, sm 8, md 12, lg 16, xl 24, xxl 32.
  final JhinSpacing spacing;

  /// Corner radius scale (§1): sm 6, md 10, lg 14, full 9999.
  final JhinRadius radius;

  /// Typography seeds (§1): h1/h2/h3/body/small/mono.
  final JhinTypography typography;

  /// Elevation scale (§1): none 0, sm 1, md 4, lg 8.
  final JhinElevation elevation;

  /// Motion durations (§1): instant 0, fast 120, normal 200, slow 320,
  /// panel 0 (ms).
  final JhinMotion motion;

  /// Control density (§1): `compact | comfortable | spacious`.
  final JhinDensity density;

  /// Client-side layout constants (`$size.*`, §2.2): the shell sidebar, the
  /// chart plot height and the stream list viewport.
  final Map<String, double> sizes;

  /// Theme palette for `$color.*` lookups (§2.2); filled by `JhinTheme`.
  final Map<String, Color> colors;

  /// Client-side `$size.*` constants (§2.2). Not server-overridable: the
  /// bootstrap `tokens` block defines no `size` group.
  static const Map<String, double> defaultSizes = {
    'sidebar': 280,
    'chart': 160,
    'streamList': 240,
  };

  /// The chart plot height (`$size.chart`).
  double get chartHeight => sizes['chart'] ?? 160;

  /// The stream list viewport height (`$size.streamList`).
  double get streamListHeight => sizes['streamList'] ?? 240;

  /// The shell sidebar width (`$size.sidebar`).
  double get sidebarWidth => sizes['sidebar'] ?? 280;

  /// A copy with every motion duration collapsed to zero — the OS
  /// reduced-motion preference (§1: "collapse all to 0 regardless of server
  /// values").
  JhinTokens withZeroMotion() => JhinTokens(
        spacing: spacing,
        radius: radius,
        typography: typography,
        elevation: elevation,
        motion: JhinMotion.zero(),
        density: density,
        sizes: sizes,
        colors: colors,
      );

  /// A copy with [palette] installed as the `$color.*` lookup table.
  JhinTokens withColors(Map<String, Color> palette) => JhinTokens(
        spacing: spacing,
        radius: radius,
        typography: typography,
        elevation: elevation,
        motion: motion,
        density: density,
        sizes: sizes,
        colors: palette,
      );

  /// Resolves one `$token` reference (§2.2): `$spacing.md` → 12,
  /// `$radius.lg` → 14, `$color.accent` → the palette color,
  /// `$motion.fast` → 120 ms, `$elevation.md` → 4, `$typography.h1` → its
  /// [TextStyle], `$size.sidebar` → 280, `$font.mono` → `monospace`.
  ///
  /// Returns null for anything unknown or malformed — the caller degrades
  /// silently to the literal value (§2.4), never throws.
  Object? resolveToken(String reference) {
    if (!reference.startsWith('\$')) return null;
    final body = reference.substring(1);
    final dot = body.indexOf('.');
    if (dot <= 0 || dot == body.length - 1) return null;
    final namespace = body.substring(0, dot);
    final key = body.substring(dot + 1);
    switch (namespace) {
      case 'spacing':
        return spacing.values[key];
      case 'radius':
        return radius.values[key];
      case 'elevation':
        return elevation.values[key];
      case 'motion':
        return motion.values[key];
      case 'typography':
        return typography.values[key];
      case 'color':
        return colors[key];
      case 'size':
        return sizes[key];
      case 'font':
        return key == 'mono' ? 'monospace' : null;
    }
    return null;
  }

  static Map<String, dynamic>? _map(Object? value) =>
      value is Map ? Map<String, dynamic>.from(value) : null;

  static double _num(Object? value, double fallback) =>
      value is num ? value.toDouble() : fallback;
}

/// Control density (§1): `compact | comfortable | spacious`.
enum JhinDensity {
  compact(0.75),
  comfortable(1.0),
  spacious(1.25);

  const JhinDensity(this.spacingScale);

  /// Multiplier applied to the final spacing values.
  final double spacingScale;

  /// Parses a bootstrap `density` string; unknown or absent degrades to
  /// [comfortable] (§2.4). A [JhinDensity] passes through unchanged.
  static JhinDensity parse(Object? value) {
    if (value is JhinDensity) return value;
    switch (value) {
      case 'compact':
        return JhinDensity.compact;
      case 'spacious':
        return JhinDensity.spacious;
      default:
        return JhinDensity.comfortable;
    }
  }

  /// Material visual density matching the control-density preference:
  /// compact → [VisualDensity.compact], spacious → a mildly expanded
  /// density, comfortable → [VisualDensity.standard].
  VisualDensity get visualDensity {
    switch (this) {
      case JhinDensity.compact:
        return VisualDensity.compact;
      case JhinDensity.comfortable:
        return VisualDensity.standard;
      case JhinDensity.spacious:
        return const VisualDensity(horizontal: 1, vertical: 1);
    }
  }
}

/// Spacing tokens (§1): xs 4, sm 8, md 12, lg 16, xl 24, xxl 32.
class JhinSpacing {
  const JhinSpacing({
    this.xs = xsDefault,
    this.sm = smDefault,
    this.md = mdDefault,
    this.lg = lgDefault,
    this.xl = xlDefault,
    this.xxl = xxlDefault,
  });

  static const double xsDefault = 4;
  static const double smDefault = 8;
  static const double mdDefault = 12;
  static const double lgDefault = 16;
  static const double xlDefault = 24;
  static const double xxlDefault = 32;

  final double xs;
  final double sm;
  final double md;
  final double lg;
  final double xl;
  final double xxl;

  Map<String, double> get values =>
      {'xs': xs, 'sm': sm, 'md': md, 'lg': lg, 'xl': xl, 'xxl': xxl};
}

/// Radius tokens (§1): sm 6, md 10, lg 14, full 9999.
class JhinRadius {
  const JhinRadius({
    this.sm = smDefault,
    this.md = mdDefault,
    this.lg = lgDefault,
    this.full = fullDefault,
  });

  static const double smDefault = 6;
  static const double mdDefault = 10;
  static const double lgDefault = 14;
  static const double fullDefault = 9999;

  final double sm;
  final double md;
  final double lg;
  final double full;

  Map<String, double> get values =>
      {'sm': sm, 'md': md, 'lg': lg, 'full': full};
}

/// Typography seeds (§1). Sizes/heights/weights are the §1 values; `mono`
/// uses a monospace family.
class JhinTypography {
  const JhinTypography({
    this.h1 = const TextStyle(
        fontSize: 28, height: 1.25, fontWeight: FontWeight.w700),
    this.h2 = const TextStyle(
        fontSize: 22, height: 1.30, fontWeight: FontWeight.w700),
    this.h3 = const TextStyle(
        fontSize: 18, height: 1.35, fontWeight: FontWeight.w600),
    this.body = const TextStyle(
        fontSize: 14, height: 1.50, fontWeight: FontWeight.w400),
    this.small = const TextStyle(
        fontSize: 12, height: 1.45, fontWeight: FontWeight.w400),
    this.mono = const TextStyle(
        fontSize: 13,
        height: 1.55,
        fontWeight: FontWeight.w400,
        fontFamily: 'monospace'),
  });

  final TextStyle h1;
  final TextStyle h2;
  final TextStyle h3;
  final TextStyle body;
  final TextStyle small;
  final TextStyle mono;

  Map<String, TextStyle> get values => {
        'h1': h1,
        'h2': h2,
        'h3': h3,
        'body': body,
        'small': small,
        'mono': mono,
      };

  /// Applies `{h1: {size, height, weight, font?}, …}` overrides over the
  /// built-in seeds. Malformed entries keep the built-in — never throws.
  factory JhinTypography.fromOverrides(Map<String, dynamic>? overrides) {
    final raw = overrides ?? const {};
    TextStyle seed(String key, TextStyle fallback) {
      final entry = raw[key];
      if (entry is! Map) return fallback;
      final map = Map<String, dynamic>.from(entry);
      final size = map['size'];
      final height = map['height'];
      final weight = map['weight'];
      final font = map['font'];
      return fallback.copyWith(
        fontSize: size is num ? size.toDouble() : null,
        height: height is num ? height.toDouble() : null,
        fontWeight: weight is num ? _fontWeight(weight) : null,
        fontFamily: font is String && font.isNotEmpty ? font : null,
      );
    }

    return JhinTypography(
      h1: seed('h1', const JhinTypography().h1),
      h2: seed('h2', const JhinTypography().h2),
      h3: seed('h3', const JhinTypography().h3),
      body: seed('body', const JhinTypography().body),
      small: seed('small', const JhinTypography().small),
      mono: seed('mono', const JhinTypography().mono),
    );
  }

  static FontWeight? _fontWeight(num weight) {
    if (weight < 100 || weight > 900) return null;
    final index = ((weight - 100) / 100).round().clamp(0, FontWeight.values.length - 1);
    return FontWeight.values[index];
  }
}

/// Elevation tokens (§1): none 0, sm 1, md 4, lg 8.
class JhinElevation {
  const JhinElevation({
    this.none = noneDefault,
    this.sm = smDefault,
    this.md = mdDefault,
    this.lg = lgDefault,
  });

  static const double noneDefault = 0;
  static const double smDefault = 1;
  static const double mdDefault = 4;
  static const double lgDefault = 8;

  final double none;
  final double sm;
  final double md;
  final double lg;

  Map<String, double> get values =>
      {'none': none, 'sm': sm, 'md': md, 'lg': lg};
}

/// Motion durations (§1): instant 0, fast 120, normal 200, slow 320,
/// panel 0 (ms). `panel` is the panel-animation duration (0 = instant,
/// 400 = max).
class JhinMotion {
  const JhinMotion({
    this.instant = instantDefault,
    this.fast = fastDefault,
    this.normal = normalDefault,
    this.slow = slowDefault,
    this.panel = panelDefault,
  });

  static const int instantMs = 0;
  static const int fastMs = 120;
  static const int normalMs = 200;
  static const int slowMs = 320;
  static const int panelMs = 0;

  static const Duration instantDefault = Duration(milliseconds: instantMs);
  static const Duration fastDefault = Duration(milliseconds: fastMs);
  static const Duration normalDefault = Duration(milliseconds: normalMs);
  static const Duration slowDefault = Duration(milliseconds: slowMs);
  static const Duration panelDefault = Duration(milliseconds: panelMs);

  final Duration instant;
  final Duration fast;
  final Duration normal;
  final Duration slow;
  final Duration panel;

  Map<String, Duration> get values => {
        'instant': instant,
        'fast': fast,
        'normal': normal,
        'slow': slow,
        'panel': panel,
      };

  /// Builds the durations from a raw ms map (`{fast: 120, …}`); malformed
  /// or absent keys keep the built-in — never throws.
  factory JhinMotion.fromMs(Map<String, dynamic>? raw) {
    final map = raw ?? const {};
    Duration value(String key, Duration fallback) {
      final ms = map[key];
      if (ms is! num || ms < 0) return fallback;
      return Duration(milliseconds: ms.round());
    }

    return JhinMotion(
      instant: value('instant', instantDefault),
      fast: value('fast', fastDefault),
      normal: value('normal', normalDefault),
      slow: value('slow', slowDefault),
      panel: value('panel', panelDefault),
    );
  }

  /// Every duration collapsed to zero — the reduced-motion preference (§1).
  factory JhinMotion.zero() => const JhinMotion(
        instant: Duration.zero,
        fast: Duration.zero,
        normal: Duration.zero,
        slow: Duration.zero,
        panel: Duration.zero,
      );
}
