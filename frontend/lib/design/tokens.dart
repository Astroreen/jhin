import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'palette_gen.dart';

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
    this.surface = const JhinTokenSurface({}),
  });

  /// Built-in defaults (§1), optionally overridden key-by-key.
  factory JhinTokens.defaults({JhinDensity density = JhinDensity.comfortable}) =>
      JhinTokens.fromOverrides(null, density: density);

  /// Builds the lattice from a bootstrap `tokens` override map (§1):
  /// `{spacing: {…}, radius: {…}, typography: {…}, elevation: {…}, motion: {…}}`
  /// plus the token-surface families (§4.3) mirrored into [JhinTokenSurface].
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
      surface: JhinTokenSurface.fromOverrides(raw),
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

  /// The token surface of §4.3 (`color`…`z`) mirrored from the bootstrap
  /// `tokens` block; resolved per theme by `JhinTheme.resolve`.
  final JhinTokenSurface surface;

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
        surface: surface,
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
        surface: surface,
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

/// The token surface of §4.3: the eleven families (`color`, `radius`, `text`,
/// `font`, `space`, `layout`, `glass`, `motion`, `shadow`, `scroll`, `z`)
/// mirrored key-for-key and value-for-value from the bootstrap `tokens` block
/// (and from `UiTokens` on the server).
///
/// Value shapes mirror the block. CSS values that keep a unit or a composite
/// form are verbatim strings (`'0.625rem'`, `'80%'`, `'2.4s'`, `rgb(…)`,
/// `calc(…)`, `cubic-bezier(…)`); plain pixel lengths and unitless numbers
/// are numbers (a `px` length loses its unit); theme-dependent values are
/// `{light, dark}` maps and the responsive gutter is a `{base, sm}` map —
/// `JhinTheme.resolve` collapses both against the active theme and viewport.
class JhinTokenSurface {
  const JhinTokenSurface(this.families);

  /// The mirrored families: family name → key → value.
  final Map<String, Map<String, Object?>> families;

  /// The built-in mirror of the upstream surface (the fallback layer the
  /// server ships too).
  factory JhinTokenSurface.defaults() => JhinTokenSurface(_defaults);

  /// Merges a bootstrap `tokens` map over the built-in mirror, key by key.
  /// Unknown families and keys are ignored — never throws.
  factory JhinTokenSurface.fromOverrides(Map<String, dynamic>? overrides) {
    final raw = overrides ?? const {};
    final merged = <String, Map<String, Object?>>{};
    for (final family in _defaults.keys) {
      final base = _defaults[family]!;
      final incoming = raw[family];
      if (incoming is! Map) {
        merged[family] = base;
        continue;
      }
      final out = Map<String, Object?>.from(base);
      for (final entry in incoming.entries) {
        if (base.containsKey(entry.key)) out[entry.key] = entry.value;
      }
      merged[family] = out;
    }
    return JhinTokenSurface(merged);
  }

  static const Set<String> familyNames = {
    'color', 'radius', 'text', 'font', 'space', 'layout',
    'glass', 'motion', 'shadow', 'scroll', 'z',
  };

  /// The keys of one family (empty for an unknown family).
  Set<String> keys(String family) =>
      familyNames.contains(family) ? _defaults[family]!.keys.toSet() : const {};

  /// The raw mirrored value of one key (null for an unknown family or key).
  Object? value(String family, String key) {
    final familyMap = families[family];
    return familyMap == null ? null : familyMap[key];
  }

  /// The whole family map (empty for an unknown family).
  Map<String, Object?> family(String name) => families[name] ?? const {};
}

/// The built-in mirror: same keys, same values, same shapes as the server's
/// `UiTokens` surface. Keep the two in lockstep — `BootstrapContractTest` and
/// `token_surface_test.dart` pin the shared spot checks.
const Map<String, Map<String, Object?>> _defaults = {
  'color': {
    'accent': 'var(--accent)',
    'accent-foreground': 'var(--contrast-accent-foreground)',
    'background': 'var(--background)',
    'border': 'var(--contrast-border)',
    'card': 'var(--card)',
    'card-foreground': 'var(--contrast-card-foreground)',
    'code': 'var(--code-background)',
    'code-foreground': 'var(--code-foreground)',
    'destructive': 'var(--destructive)',
    'destructive-foreground': 'var(--destructive-foreground)',
    'diff-addition': 'var(--diff-addition)',
    'diff-addition-foreground': 'var(--diff-addition-foreground)',
    'diff-deletion': 'var(--diff-deletion)',
    'diff-deletion-foreground': 'var(--diff-deletion-foreground)',
    'error': 'var(--error)',
    'error-foreground': 'var(--error-foreground)',
    'error-surface': 'var(--error-surface)',
    'foreground': 'var(--contrast-foreground)',
    'icon-muted': 'var(--contrast-icon-muted)',
    'info': 'var(--info)',
    'info-foreground': 'var(--info-foreground)',
    'input': 'var(--contrast-input)',
    'message': 'var(--message-surface)',
    'message-action': 'var(--message-action)',
    'message-action-foreground': 'var(--message-action-foreground)',
    'message-action-hover': 'var(--message-action-hover)',
    'message-foreground': 'var(--contrast-message-foreground)',
    'muted': 'var(--muted)',
    'muted-foreground': 'var(--contrast-muted-foreground)',
    'placeholder': 'var(--contrast-placeholder)',
    'popover': 'var(--popover)',
    'popover-foreground': 'var(--contrast-popover-foreground)',
    'primary': 'var(--primary)',
    'primary-foreground': 'var(--primary-foreground)',
    'ring': 'var(--ring)',
    'secondary': 'var(--secondary)',
    'secondary-foreground': 'var(--contrast-secondary-foreground)',
    'secondary-label': 'var(--contrast-secondary-label)',
    'sidebar': 'var(--sidebar)',
    'sidebar-border': 'var(--contrast-sidebar-border)',
    'sidebar-control-surface': 'var(--sidebar-control-surface)',
    'sidebar-foreground': 'var(--contrast-sidebar-foreground)',
    'sidebar-muted-foreground': 'var(--contrast-sidebar-muted-foreground)',
    'sidebar-row-active': 'var(--sidebar-row-active)',
    'sidebar-row-hover': 'var(--sidebar-row-hover)',
    'sidebar-row-selected': 'var(--sidebar-row-selected)',
    'success': 'var(--success)',
    'success-foreground': 'var(--success-foreground)',
    'surface-raised': 'var(--surface-raised)',
    'tool-error-icon': 'var(--tool-error-icon)',
    'update': 'var(--update)',
    'update-foreground': 'var(--update-foreground)',
    'update-surface': 'var(--update-surface)',
    'warning': 'var(--warning)',
    'warning-foreground': 'var(--warning-foreground)',
    'warning-surface': 'var(--warning-surface)',
    'contrast': {
      'accent-foreground': 'color-mix(in oklab, color-mix(in oklab,'
          ' var(--accent-foreground) var(--appearance-contrast-base), var(--accent)),'
          ' var(--appearance-contrast-target) var(--appearance-contrast-boost))',
      'border': 'color-mix(in srgb, color-mix(in srgb,'
          ' var(--border) var(--appearance-contrast-base), transparent),'
          ' var(--foreground) var(--appearance-contrast-border-boost))',
      'card-foreground': 'color-mix(in oklab, color-mix(in oklab,'
          ' var(--card-foreground) var(--appearance-contrast-base), var(--card)),'
          ' var(--appearance-contrast-target) var(--appearance-contrast-boost))',
      'foreground': 'color-mix(in oklab, color-mix(in oklab,'
          ' var(--foreground) var(--appearance-contrast-base), var(--background)),'
          ' var(--appearance-contrast-target) var(--appearance-contrast-boost))',
      'icon-muted': 'color-mix(in oklab, color-mix(in oklab,'
          ' var(--icon-muted) var(--appearance-contrast-base), var(--background)),'
          ' var(--appearance-contrast-target) var(--appearance-contrast-boost))',
      'input': 'color-mix(in srgb, color-mix(in srgb,'
          ' var(--input) var(--appearance-contrast-base), transparent),'
          ' var(--foreground) var(--appearance-contrast-border-boost))',
      'message-foreground': 'color-mix(in oklab, color-mix(in oklab,'
          ' var(--message-foreground) var(--appearance-contrast-base),'
          ' var(--message-surface)),'
          ' var(--appearance-contrast-target) var(--appearance-contrast-boost))',
      'muted-foreground': 'color-mix(in oklab, color-mix(in oklab,'
          ' var(--muted-foreground) var(--appearance-contrast-base),'
          ' var(--background)),'
          ' var(--appearance-contrast-target) var(--appearance-contrast-boost))',
      'placeholder': 'color-mix(in oklab, color-mix(in oklab,'
          ' var(--placeholder) var(--appearance-contrast-base), var(--background)),'
          ' var(--appearance-contrast-target) var(--appearance-contrast-boost))',
      'popover-foreground': 'color-mix(in oklab, color-mix(in oklab,'
          ' var(--popover-foreground) var(--appearance-contrast-base),'
          ' var(--popover)),'
          ' var(--appearance-contrast-target) var(--appearance-contrast-boost))',
      'secondary-foreground': 'color-mix(in oklab, color-mix(in oklab,'
          ' var(--secondary-foreground) var(--appearance-contrast-base),'
          ' var(--secondary)),'
          ' var(--appearance-contrast-target) var(--appearance-contrast-boost))',
      'secondary-label': 'color-mix(in oklab, color-mix(in oklab,'
          ' var(--secondary-label) var(--appearance-contrast-base),'
          ' var(--background)),'
          ' var(--appearance-contrast-target) var(--appearance-contrast-boost))',
      'sidebar-border': 'color-mix(in srgb, color-mix(in srgb,'
          ' var(--sidebar-border) var(--appearance-contrast-base), transparent),'
          ' var(--sidebar-foreground) var(--appearance-contrast-border-boost))',
      'sidebar-foreground': 'color-mix(in oklab, color-mix(in oklab,'
          ' var(--sidebar-foreground) var(--appearance-contrast-base),'
          ' var(--sidebar)),'
          ' var(--appearance-contrast-target) var(--appearance-contrast-boost))',
      'sidebar-muted-foreground': 'color-mix(in oklab, color-mix(in oklab,'
          ' var(--sidebar-muted-foreground) var(--appearance-contrast-base),'
          ' var(--sidebar)),'
          ' var(--appearance-contrast-target) var(--appearance-contrast-boost))',
    },
  },
  'radius': {
    'base': '0.625rem',
    'sm': 'calc(0.625rem - 4px)',
    'md': 'calc(0.625rem - 2px)',
    'lg': '0.625rem',
    'xl': 'calc(0.625rem + 4px)',
    'xl2': 'calc(0.625rem + 8px)',
    'xl3': 'calc(0.625rem + 12px)',
  },
  'text': {
    'xs5': {'size': '0.4375rem', 'lineHeight': '1'},
    'xs4': {'size': '0.5rem', 'lineHeight': '1'},
    'xs3': {'size': '0.625rem', 'lineHeight': 'calc(0.875 / 0.625)'},
    'xs2': {'size': '0.6875rem', 'lineHeight': 'calc(1 / 0.6875)'},
    'xs': {'size': '0.75rem', 'lineHeight': 'calc(1 / 0.75)'},
    'sm': {'size': '0.875rem', 'lineHeight': 'calc(1.25 / 0.875)'},
    'base': {'size': '1rem', 'lineHeight': 'calc(1.5 / 1)'},
    'lg': {'size': '1.125rem', 'lineHeight': 'calc(1.75 / 1.125)'},
    'xl': {'size': '1.25rem', 'lineHeight': 'calc(1.75 / 1.25)'},
  },
  'font': {
    'sans': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    'mono': 'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas,'
        ' "Liberation Mono", monospace',
    'composer': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    'sizeInterface': 16,
    'sizePrompt': 14,
    'sizeCode': 13,
  },
  'space': {
    'control': '0.5rem',
    'sidebarContent': '0.5rem',
    'sidebarControlGap': '0.5rem',
    'sidebarRowContent': '0.625rem',
    'commandShell': '0.5rem',
    'commandContent': '1rem',
    'floatingContent': '0.75rem',
    'workspaceGutter': {'base': '0.75rem', 'sm': '1.25rem'},
  },
  'layout': {
    'topbarHeight': 52,
    'chatContentMaxWidth': '46rem',
    'threadDetailsPanelWidth': '17.5rem',
    'sidebarWidth': 256,
    'sidebarMinWidth': 208,
    'mainMinWidth': 640,
  },
  'glass': {
    'blur': {'light': 12, 'dark': 16},
    'opacity': '80%',
    'saturation': {'light': 1.14, 'dark': 1.08},
  },
  'motion': {
    'panel': 0,
    'easeDrawer': 'cubic-bezier(0.32, 0.72, 0, 1)',
    'skeleton': '2.4s',
    'statusPulse': '2s',
    'statusPing': '2s',
    'reduced': false,
  },
  'shadow': {
    'composer': {
      'light': '0 12px 28px -18px rgb(0 0 0 / 40%)',
      'dark': '0 14px 32px -18px rgb(0 0 0 / 75%)',
    },
    'controlHighlight': '0 1px rgb(255 255 255 / 16%)',
    'controlPressed': '0 1px rgb(0 0 0 / 8%)',
  },
  'scroll': {
    'width': 6,
    'thumb': {'light': 'rgb(217 217 217)', 'dark': 'rgb(255 255 255 / 8%)'},
    'thumbHover': {'light': 'rgb(191 191 191)', 'dark': 'rgb(255 255 255 / 12%)'},
  },
  'z': {
    'sheet': 46,
  },
};

// ---------------------------------------------------------------------------
// T86: contrast indirection, runtime switches and per-role font resolution.
// Every value below is verified against the upstream checkout (commit
// 37de6cb): packages/contracts/src/settings.ts, apps/web/src/appearanceFonts.ts
// and apps/web/src/index.css.
// ---------------------------------------------------------------------------

/// Font-size clamps (settings.ts:122-139): interface 12-20 default 16,
/// prompt 12-20 default 14, code 10-18 default 13.
const int kFontInterfaceMin = 12;
const int kFontInterfaceMax = 20;
const int kFontInterfaceDefault = 16;
const int kFontPromptMin = 12;
const int kFontPromptMax = 20;
const int kFontPromptDefault = 14;
const int kFontCodeMin = 10;
const int kFontCodeMax = 18;
const int kFontCodeDefault = 13;

/// The effective prompt size: `max(size, 16)`. Upstream clamps the composer
/// to 16px on touch inputs only (index.css:131
/// `--font-size-prompt-touch: max(var(--font-size-prompt, 1rem), 16px)`);
/// the plan applies the floor unconditionally (T86 step 4).
int jhinEffectivePromptFontSize(int size) => size < 16 ? 16 : size;

int _clampFont(Object? raw, int min, int max, int fallback) {
  final value = raw is num ? raw.round() : fallback;
  return value < min ? min : (value > max ? max : value);
}

/// The three resolved font roles (settings.ts:122-139 clamps; the prompt
/// role renders at [jhinEffectivePromptFontSize]).
@immutable
class JhinFontSizes {
  const JhinFontSizes({
    this.sizeInterface = kFontInterfaceDefault,
    this.sizePrompt = kFontPromptDefault,
    this.sizeCode = kFontCodeDefault,
  });

  final int sizeInterface;
  final int sizePrompt;
  final int sizeCode;

  @override
  bool operator ==(Object other) =>
      other is JhinFontSizes &&
      other.sizeInterface == sizeInterface &&
      other.sizePrompt == sizePrompt &&
      other.sizeCode == sizeCode;

  @override
  int get hashCode => Object.hash(sizeInterface, sizePrompt, sizeCode);
}

/// Resolves the three font roles from raw pref values (null = default).
JhinFontSizes resolveFontSizes({
  Object? interface,
  Object? prompt,
  Object? code,
}) {
  return JhinFontSizes(
    sizeInterface: _clampFont(
      interface,
      kFontInterfaceMin,
      kFontInterfaceMax,
      kFontInterfaceDefault,
    ),
    sizePrompt: jhinEffectivePromptFontSize(_clampFont(
      prompt,
      kFontPromptMin,
      kFontPromptMax,
      kFontPromptDefault,
    )),
    sizeCode: _clampFont(
      code,
      kFontCodeMin,
      kFontCodeMax,
      kFontCodeDefault,
    ),
  );
}

/// The stylesheet stacks verbatim (index.css:167-169; the same strings the
/// server mirrors in `UiTokens.FONT_VALUES`).
const String kSansFontStack =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const String kMonoFontStack =
    'ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas,'
    ' "Liberation Mono", monospace';

/// Quotes one font family name (appearanceFonts.ts:33-44): already-quoted
/// names and simple idents pass through, everything else gets double quotes
/// with inner quotes stripped.
String _quoteFontFamilyName(String name) {
  final bare = name.trim();
  if (bare.isEmpty) return '';
  if (bare.length >= 2 &&
      (bare.startsWith("'") || bare.startsWith('"')) &&
      bare.endsWith(bare[0])) {
    return bare;
  }
  if (RegExp(r'^[a-zA-Z][a-zA-Z0-9-]*$').hasMatch(bare)) return bare;
  return '"${bare.replaceAll('"', '')}"';
}

/// Normalizes a user-entered family list into a safe CSS font-family list,
/// or null when the input is effectively empty (appearanceFonts.ts:47-55).
String? cssFontFamilies(String? input) {
  if (input == null) return null;
  final families = <String>[];
  for (final raw in input.split(',')) {
    final quoted = _quoteFontFamilyName(raw);
    if (quoted.isNotEmpty) families.add(quoted);
  }
  return families.isEmpty ? null : families.join(', ');
}

/// The full stack a preference resolves to: custom families before the
/// default (appearanceFonts.ts:58-61).
String fontStack(String? custom, String defaultStack) {
  final families = cssFontFamilies(custom);
  return families == null ? defaultStack : '$families, $defaultStack';
}

/// The resolved font families: the user pref prepended to the fixed stacks.
@immutable
class JhinFontFamilies {
  const JhinFontFamilies({
    this.sans = kSansFontStack,
    this.mono = kMonoFontStack,
    this.composer,
  });

  final String sans;
  final String mono;

  /// The composer family; null = whatever the sans preference resolves to
  /// (appearanceFonts.ts:110 — the composer falls back to `var(--font-sans)`).
  final String? composer;

  @override
  bool operator ==(Object other) =>
      other is JhinFontFamilies &&
      other.sans == sans &&
      other.mono == mono &&
      other.composer == composer;

  @override
  int get hashCode => Object.hash(sans, mono, composer);
}

/// Resolves the font families from raw pref values (null = untouched stack).
JhinFontFamilies resolveFontFamilies({Object? sans, Object? mono, Object? composer}) {
  final sansStack = fontStack(sans is String ? sans : null, kSansFontStack);
  final monoStack = fontStack(mono is String ? mono : null, kMonoFontStack);
  final composerCustom = composer is String ? composer : null;
  return JhinFontFamilies(
    sans: sansStack,
    mono: monoStack,
    composer: composerCustom == null || composerCustom.trim().isEmpty
        ? null
        : fontStack(composerCustom, sansStack),
  );
}

/// The contrast indirection (settings.ts:100-107, appearanceContrast.ts:3-11):
/// the appearance pref is a percentage 50-200 (default 100). Above 100 it
/// boosts every contrast foreground toward the target (black in light, white
/// in dark); below 100 it softens the foreground toward its own surface.
@immutable
class JhinContrast {
  const JhinContrast({
    this.pref = 100,
    this.base = 100,
    this.boost = 0,
    this.borderBoost = 0,
  });

  /// The raw appearance pref (50-200).
  final int pref;

  /// `--appearance-contrast-base`: min(pref, 100)%.
  final int base;

  /// `--appearance-contrast-boost`: max(pref - 100, 0)%.
  final int boost;

  /// `--appearance-contrast-border-boost`: boost / 4.
  final int borderBoost;

  /// The default: no mixing at all.
  static const JhinContrast neutral = JhinContrast();

  /// Parses the appearance pref; out-of-range or malformed values degrade to
  /// the default 100 (settings.ts:100-107).
  factory JhinContrast.fromPref(Object? raw) {
    final value = raw is num ? raw.round() : 100;
    final pref = value < 50 ? 100 : (value > 200 ? 100 : value);
    return JhinContrast.fromPercent(pref);
  }

  /// Builds from a percentage (100 = no change).
  factory JhinContrast.fromPercent(int pref) {
    final clamped = pref < 50 ? 50 : (pref > 200 ? 200 : pref);
    final boost = clamped > 100 ? clamped - 100 : 0;
    return JhinContrast(
      pref: clamped,
      base: clamped < 100 ? clamped : 100,
      boost: boost,
      borderBoost: boost ~/ 4,
    );
  }

  @override
  bool operator ==(Object other) =>
      other is JhinContrast &&
      other.pref == pref &&
      other.base == base &&
      other.boost == boost &&
      other.borderBoost == borderBoost;

  @override
  int get hashCode => Object.hash(pref, base, boost, borderBoost);
}

/// `color-mix(in srgb, A t%, B)` with premultiplied alpha (CSS color-mix
/// mixes the alpha channel the same way).
Color jhinMixSrgb(Color a, Color b, double t) {
  final double outAlpha = a.a + (b.a - a.a) * t;
  if (outAlpha <= 0) return const Color(0x00000000);
  double mixPm(double channelA, double channelB) =>
      channelA * a.a + (channelB * b.a - channelA * a.a) * t;
  final double red = mixPm(a.r, b.r) / outAlpha;
  final double green = mixPm(a.g, b.g) / outAlpha;
  final double blue = mixPm(a.b, b.b) / outAlpha;
  return Color.fromRGBO(
    (red * 255.0).round().clamp(0, 255),
    (green * 255.0).round().clamp(0, 255),
    (blue * 255.0).round().clamp(0, 255),
    outAlpha,
  );
}

/// `color-mix(in oklab, A t%, B)`: the mix runs in OKLab (the palette
/// generator's own OKLCH pipeline supplies the conversion both ways).
Color jhinMixOklab(Color a, Color b, double t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  final Lch first = fromRgb(Rgb(a.r * 255.0, a.g * 255.0, a.b * 255.0));
  final Lch second = fromRgb(Rgb(b.r * 255.0, b.g * 255.0, b.b * 255.0));
  const double deg = 180.0 / math.pi;
  final double a1 = first.c * math.cos(first.h / deg);
  final double b1 = first.c * math.sin(first.h / deg);
  final double a2 = second.c * math.cos(second.h / deg);
  final double b2 = second.c * math.sin(second.h / deg);
  final double l = first.l + (second.l - first.l) * t;
  final double oa = a1 + (a2 - a1) * t;
  final double ob = b1 + (b2 - b1) * t;
  final Rgb mixed = toRgb(Lch(
    l,
    math.sqrt(oa * oa + ob * ob),
    math.atan2(ob, oa) * deg,
  ));
  return Color.fromARGB(
    (a.a + (b.a - a.a) * t) * 255.0 ~/ 1.0,
    mixed.r.round(),
    mixed.g.round(),
    mixed.b.round(),
  );
}

/// Scales the alpha of [color] by [factor] (the srgb mix against
/// `transparent`: the channels stay, the alpha shrinks).
Color _scaleAlpha(Color color, double factor) =>
    color.withValues(alpha: (color.a * factor).clamp(0.0, 1.0));

/// One contrast recipe (index.css:1505-1614): how a `--contrast-*` name is
/// derived from its source variable. The two-stage form is
/// `color-mix(space, color-mix(space, source base%, baseTarget), boostTarget boost%)`
/// where the border family mixes against `transparent` first and toward a
/// palette foreground with the border boost second.
class _ContrastRecipe {
  const _ContrastRecipe(
    this.source,
    this.baseTarget, {
    this.oklab = true,
    this.border = false,
  });

  /// The palette name of the source variable (`--foreground` etc.).
  final String source;

  /// The palette name of the stage-1 mix target; empty = `transparent`
  /// (srgb only, the alpha scales).
  final String baseTarget;

  /// `in oklab` (foregrounds) or `in srgb` (borders and inputs).
  final bool oklab;

  /// The stage-2 boost uses `--appearance-contrast-border-boost` and a
  /// palette foreground instead of the black/white target.
  final bool border;
}

/// The recipes of the `contrast` sub-map (index.css:1505-1614), keyed by the
/// `--contrast-*` name without its prefix.
const Map<String, _ContrastRecipe> _contrastRecipes = {
  'accent-foreground': _ContrastRecipe('accent-foreground', 'accent'),
  'border': _ContrastRecipe('border', '', oklab: false, border: true),
  'card-foreground': _ContrastRecipe('card-foreground', 'card'),
  'foreground': _ContrastRecipe('foreground', 'background'),
  'icon-muted': _ContrastRecipe('icon-muted', 'background'),
  'input': _ContrastRecipe('input', '', oklab: false, border: true),
  'message-foreground': _ContrastRecipe('message-foreground', 'message'),
  'muted-foreground': _ContrastRecipe('muted-foreground', 'background'),
  'placeholder': _ContrastRecipe('placeholder', 'background'),
  'popover-foreground': _ContrastRecipe('popover-foreground', 'popover'),
  'secondary-foreground': _ContrastRecipe('secondary-foreground', 'secondary'),
  'secondary-label': _ContrastRecipe('secondary-label', 'background'),
  'sidebar-border':
      _ContrastRecipe('sidebar-border', '', oklab: false, border: true),
  'sidebar-foreground': _ContrastRecipe('sidebar-foreground', 'sidebar'),
  'sidebar-muted-foreground':
      _ContrastRecipe('sidebar-muted-foreground', 'sidebar'),
};

/// The palette names the stage-2 border boost mixes toward
/// (index.css:1514-1516, :1529-1530, :1620-1621).
const Map<String, String> _borderBoostTargets = {
  'border': 'foreground',
  'input': 'foreground',
  'sidebar-border': 'sidebar-foreground',
};

/// Resolves every `contrast-*` name for one brightness: the two-stage mix of
/// [_contrastRecipes] with [contrast] percentages, the palette supplying the
/// sources and the target black in light / white in dark (index.css:94,143).
Map<String, Color> resolveContrastColors({
  required Map<String, Color> palette,
  required bool dark,
  JhinContrast contrast = JhinContrast.neutral,
}) {
  final Color target =
      dark ? const Color(0xFFFFFFFF) : const Color(0xFF000000);
  final out = <String, Color>{};
  _contrastRecipes.forEach((name, recipe) {
    final source = palette[recipe.source] ?? target;
    final Color stage1;
    if (recipe.baseTarget.isEmpty) {
      stage1 = _scaleAlpha(source, contrast.base / 100.0);
    } else {
      final baseTarget = palette[recipe.baseTarget] ?? target;
      final mix = recipe.oklab ? jhinMixOklab : jhinMixSrgb;
      // `color-mix(A p%, B)` = p% A + (100-p)% B: the mix fraction runs
      // toward the base target, so the weight of the source is the base.
      stage1 = mix(source, baseTarget, 1.0 - contrast.base / 100.0);
    }
    final boostPct =
        (recipe.border ? contrast.borderBoost : contrast.boost) / 100.0;
    if (boostPct <= 0) {
      out['contrast-$name'] = stage1;
      return;
    }
    final boostTargetName = _borderBoostTargets[name];
    final boostTarget = boostTargetName == null
        ? target
        : (palette[boostTargetName] ?? target);
    final mix = recipe.oklab ? jhinMixOklab : jhinMixSrgb;
    out['contrast-$name'] = mix(stage1, boostTarget, boostPct);
  });
  return out;
}

/// The chat-width switch (settings.ts:292 `comfortable|wide|full`; the plan
/// spells the default `default` — both parse to [normal]).
enum JhinChatWidth { normal, wide, full }

/// The diff colour scheme (settings.ts:289 `red-green|blue-orange`; the plan
/// spells the default `default` — both parse to [defaultScheme]).
enum JhinDiffColorScheme { defaultScheme, blueOrange }

/// The blue-orange diff palette (index.css:2041-2045): Tailwind v4.3.3
/// blue-600/400 and orange-600/400, converted through the palette
/// generator's own OKLCH pipeline for internal consistency (T84 convention).
final Color kDiffBlueLight = _diffColor(const Lch(0.546, 0.245, 262.881));
final Color kDiffBlueDark = _diffColor(const Lch(0.707, 0.165, 254.624));
final Color kDiffOrangeLight = _diffColor(const Lch(0.646, 0.222, 41.116));
final Color kDiffOrangeDark = _diffColor(const Lch(0.75, 0.183, 55.934));

Color _diffColor(Lch color) {
  final Rgb rgb = toRgb(color);
  return Color.fromARGB(
    255,
    rgb.r.round(),
    rgb.g.round(),
    rgb.b.round(),
  );
}

/// The diff colours resolved as values (index.css:2025-2028, :2041-2045):
/// the default scheme keeps the theme's own diff tokens; blue-orange swaps
/// the lanes to the fixed blue/orange pair.
@immutable
class JhinDiffColors {
  const JhinDiffColors({required this.added, required this.removed});

  final Color added;
  final Color removed;

  @override
  bool operator ==(Object other) =>
      other is JhinDiffColors &&
      other.added == added &&
      other.removed == removed;

  @override
  int get hashCode => Object.hash(added, removed);
}

JhinDiffColors resolveDiffColors({
  required JhinDiffColorScheme scheme,
  required Color themeAdded,
  required Color themeRemoved,
  required bool dark,
}) {
  return switch (scheme) {
    JhinDiffColorScheme.defaultScheme =>
      JhinDiffColors(added: themeAdded, removed: themeRemoved),
    JhinDiffColorScheme.blueOrange => JhinDiffColors(
        added: dark ? kDiffBlueDark : kDiffBlueLight,
        removed: dark ? kDiffOrangeDark : kDiffOrangeLight,
      ),
  };
}

/// The §8.3 data-viz palette: the categorical series colors of the chart
/// primitives, carried here in the token layer so no primitive source
/// contains a literal colour (the T86 purity rule). The axis gray mirrors
/// the upstream chart axis stroke.
const List<Color> kChartPalette = [
  Color(0xFF7E57C2),
  Color(0xFF26A69A),
  Color(0xFFFF7043),
  Color(0xFF42A5F5),
  Color(0xFFEC407A),
  Color(0xFF9CCC65),
];

/// The chart axis stroke (§8.3).
const Color kChartAxisColor = Color(0xFF9E9E9E);

/// The runtime switches (T86): the client-side appearance preferences the
/// theme and the primitives resolve as values. Parsed from the appearance
/// store map; unknown keys and malformed values degrade to the defaults.
@immutable
class JhinSwitches {
  const JhinSwitches({
    this.contrast = JhinContrast.neutral,
    this.chatWidth = JhinChatWidth.normal,
    this.diffColorScheme = JhinDiffColorScheme.defaultScheme,
    this.density = JhinDensity.comfortable,
    this.reducedMotion = false,
    this.fontSans,
    this.fontMono,
    this.fontComposer,
    Object? sizeInterface,
    Object? sizePrompt,
    Object? sizeCode,
  })  : sizeInterfaceRaw = sizeInterface,
        sizePromptRaw = sizePrompt,
        sizeCodeRaw = sizeCode;

  /// The contrast indirection percentages.
  final JhinContrast contrast;

  /// The chat lane width switch.
  final JhinChatWidth chatWidth;

  /// The diff colour scheme switch.
  final JhinDiffColorScheme diffColorScheme;

  /// The control density (the §1 lattice density).
  final JhinDensity density;

  /// The reduced-motion preference: collapses `motion.panel` to 0 and
  /// disables the `statusPulse` / `statusPing` / `skeleton` duty-cycles.
  final bool reducedMotion;

  /// The user font-family prefs (prepended to the fixed stacks).
  final String? fontSans;
  final String? fontMono;
  final String? fontComposer;

  final Object? sizeInterfaceRaw;
  final Object? sizePromptRaw;
  final Object? sizeCodeRaw;

  static const JhinSwitches defaults = JhinSwitches();

  /// Parses the appearance prefs map. Accepted keys: `appearanceContrast`
  /// (50-200, the upstream spelling) and `contrastBoost` (0-100, the direct
  /// boost spelling — the plan's wording); `chatWidth` (`default`/`wide`/
  /// `full`, `comfortable` accepted for the upstream literal); `diffColorScheme`
  /// (`default`/`blue-orange`, `red-green` accepted); `density`;
  /// `reducedMotion`; `fontSans`/`fontMono`/`fontComposer`;
  /// `sizeInterface`/`sizePrompt`/`sizeCode`.
  factory JhinSwitches.parse(Map<Object?, Object?>? prefs) {
    if (prefs == null) return JhinSwitches.defaults;
    final appearanceContrast = prefs['appearanceContrast'];
    final directBoost = prefs['contrastBoost'];
    final JhinContrast contrast;
    if (appearanceContrast is num) {
      contrast = JhinContrast.fromPref(appearanceContrast);
    } else if (directBoost is num) {
      final boost = directBoost.round().clamp(0, 100);
      contrast = JhinContrast.fromPercent(100 + boost);
    } else {
      contrast = JhinContrast.neutral;
    }

    final widthRaw = prefs['chatWidth'];
    final chatWidth = switch (widthRaw) {
      'wide' => JhinChatWidth.wide,
      'full' => JhinChatWidth.full,
      _ => JhinChatWidth.normal,
    };

    final schemeRaw = prefs['diffColorScheme'];
    final diffColorScheme = schemeRaw == 'blue-orange'
        ? JhinDiffColorScheme.blueOrange
        : JhinDiffColorScheme.defaultScheme;

    final motionRaw = prefs['reducedMotion'];
    final reducedMotion = motionRaw == true || motionRaw == 'true';

    String? family(Object? raw) =>
        raw is String && raw.trim().isNotEmpty ? raw : null;

    return JhinSwitches(
      contrast: contrast,
      chatWidth: chatWidth,
      diffColorScheme: diffColorScheme,
      density: JhinDensity.parse(prefs['density']),
      reducedMotion: reducedMotion,
      fontSans: family(prefs['fontSans']),
      fontMono: family(prefs['fontMono']),
      fontComposer: family(prefs['fontComposer']),
      sizeInterface: prefs['sizeInterface'],
      sizePrompt: prefs['sizePrompt'],
      sizeCode: prefs['sizeCode'],
    );
  }

  /// The three resolved font roles.
  JhinFontSizes get fontSizes => resolveFontSizes(
        interface: sizeInterfaceRaw,
        prompt: sizePromptRaw,
        code: sizeCodeRaw,
      );

  /// The resolved font families (the user prefs prepended).
  JhinFontFamilies get fontFamilies => resolveFontFamilies(
        sans: fontSans,
        mono: fontMono,
        composer: fontComposer,
      );

  /// The chat lane width in rem (index.css:128, :2031-2038): 46 / 72 / null
  /// for `full` (100%).
  double? get chatLaneRem => switch (chatWidth) {
        JhinChatWidth.normal => 46,
        JhinChatWidth.wide => 72,
        JhinChatWidth.full => null,
      };

  /// The chat lane width in logical px at the resolved interface size (the
  /// upstream root font-size scales every rem); null = full width.
  double? chatLaneWidthPx() {
    final rem = chatLaneRem;
    return rem == null ? null : rem * fontSizes.sizeInterface;
  }

  /// The resolved `motion.panel`: 0 under reduced motion, the configured
  /// duration otherwise.
  Duration resolveMotionPanel(Duration configured) =>
      reducedMotion ? Duration.zero : configured;

  /// The `statusPulse` duty-cycle enabled (off under reduced motion).
  bool get statusPulseEnabled => !reducedMotion;

  /// The `statusPing` duty-cycle enabled (off under reduced motion).
  bool get statusPingEnabled => !reducedMotion;

  /// The `skeleton` animation enabled (off under reduced motion).
  bool get skeletonEnabled => !reducedMotion;

  @override
  bool operator ==(Object other) =>
      other is JhinSwitches &&
      other.contrast == contrast &&
      other.chatWidth == chatWidth &&
      other.diffColorScheme == diffColorScheme &&
      other.density == density &&
      other.reducedMotion == reducedMotion &&
      other.fontSans == fontSans &&
      other.fontMono == fontMono &&
      other.fontComposer == fontComposer &&
      other.sizeInterfaceRaw == sizeInterfaceRaw &&
      other.sizePromptRaw == sizePromptRaw &&
      other.sizeCodeRaw == sizeCodeRaw;

  @override
  int get hashCode => Object.hash(
        contrast,
        chatWidth,
        diffColorScheme,
        density,
        reducedMotion,
        fontSans,
        fontMono,
        fontComposer,
        sizeInterfaceRaw,
        sizePromptRaw,
        sizeCodeRaw,
      );
}
