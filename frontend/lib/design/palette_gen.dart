/// The two-seed OKLCH palette generator: a Dart port of upstream
/// `createVividThemeColors(appearance, canvas, accent)`
/// (`apps/web/src/themePalette.ts:669-803`, commit `37de6cb`) and of the
/// Java engine (`plugins/ui-kit/.../PaletteGen.java` + `Oklch.java`) so the
/// client can preview a theme live with byte-identical hex output.
///
/// Every formula and constant is the upstream algorithm (anchors live in the
/// Java sources); the two ports share a deterministic float core — fixed
/// iteration counts, fixed evaluation order, no `libm` transcendentals — so
/// the generated hex strings are bit-identical across the JVM and the Dart
/// VM (plan §15.2). `dart:math` `sqrt` is used freely: IEEE-754 requires it
/// to be correctly rounded, so both languages agree exactly.
///
/// The map has exactly the `UiTokens.COLOR_KEYS` names (the 56 semantic
/// `--color-*` alias names of upstream `index.css:221-276`), each resolved to
/// the token its alias points at in the themed layer (`index.css:1228-1291`).
library;

import 'dart:math' as math;

/// A typed generation failure: unparsable seeds or an unknown mode.
class PaletteError implements Exception {
  PaletteError(this.message);

  final String message;

  @override
  String toString() => 'PaletteError: $message';
}

// --- deterministic elementary functions -----------------------------------

const double _ln2 = 0.6931471805599453;
const double _pi = 3.141592653589793;
const double _deg2rad = 3.141592653589793 / 180.0;

/// Natural log for `x > 0`: range-reduced atanh series, 24 terms.
double _ln(double x) {
  double m = x;
  int k = 0;
  while (m >= 2.0) {
    m *= 0.5;
    k++;
  }
  while (m < 1.0) {
    m *= 2.0;
    k--;
  }
  final double t = (m - 1.0) / (m + 1.0);
  final double t2 = t * t;
  double term = t;
  double sum = 0.0;
  for (int i = 0; i < 24; i++) {
    sum += term / (2 * i + 1);
    term *= t2;
  }
  return 2.0 * sum + k * _ln2;
}

/// Exponential: `2^k` scaling of a Taylor series, 20 terms.
double _exp(double x) {
  final int k = (x / _ln2).floor();
  final double r = x - k * _ln2;
  double term = 1.0;
  double sum = 1.0;
  for (int i = 1; i <= 20; i++) {
    term *= r / i;
    sum += term;
  }
  double scale = 1.0;
  if (k > 0) {
    for (int i = 0; i < k; i++) {
      scale *= 2.0;
    }
  } else {
    for (int i = 0; i < -k; i++) {
      scale *= 0.5;
    }
  }
  return scale * sum;
}

/// `x^y` for `x > 0`, via [_exp] and [_ln].
double _pow(double x, double y) {
  return _exp(y * _ln(x));
}

/// Cube root: `exp(ln(x) / 3)` for positives, odd symmetry at zero.
double _cbrt(double x) {
  if (x == 0.0) {
    return 0.0;
  }
  return x > 0.0 ? _exp(_ln(x) / 3.0) : -_exp(_ln(-x) / 3.0);
}

/// Sine of radians, reduced to `(-pi, pi]` then `[-pi/2, pi/2]`.
double _sin(double rad) {
  double r = _reduceRad(rad);
  if (r > _pi / 2.0) {
    return _taylorSin(_pi - r);
  }
  if (r < -_pi / 2.0) {
    return -_taylorSin(_pi + r);
  }
  return _taylorSin(r);
}

/// Cosine of radians, same reduction as [_sin].
double _cos(double rad) {
  double r = _reduceRad(rad);
  if (r > _pi / 2.0) {
    return -_taylorCos(_pi - r);
  }
  if (r < -_pi / 2.0) {
    return -_taylorCos(_pi + r);
  }
  return _taylorCos(r);
}

/// Wraps radians into `(-pi, pi]` with exact arithmetic.
double _reduceRad(double rad) {
  double r = rad;
  while (r > _pi) {
    r -= 2.0 * _pi;
  }
  while (r <= -_pi) {
    r += 2.0 * _pi;
  }
  return r;
}

/// Alternating sine series on `|r| <= pi/2`, 24 terms.
double _taylorSin(double r) {
  final double r2 = r * r;
  double term = r;
  double sum = r;
  for (int i = 1; i < 24; i++) {
    term *= -r2 / ((2 * i) * (2 * i + 1));
    sum += term;
  }
  return sum;
}

/// Alternating cosine series on `|r| <= pi/2`, 24 terms.
double _taylorCos(double r) {
  final double r2 = r * r;
  double term = 1.0;
  double sum = 1.0;
  for (int i = 1; i < 24; i++) {
    term *= -r2 / ((2 * i - 1) * (2 * i));
    sum += term;
  }
  return sum;
}

/// Four-quadrant atan (`themePalette.ts:517`), same reduction as the port.
double _atan2(double y, double x) {
  if (x == 0.0 && y == 0.0) {
    return 0.0;
  }
  if (x == 0.0) {
    return y > 0.0 ? _pi / 2.0 : -_pi / 2.0;
  }
  final double base = _atan(y / x);
  if (x > 0.0) {
    return base;
  }
  return y >= 0.0 ? base + _pi : base - _pi;
}

/// Arctangent on the full real line: half-angle reduction plus a series.
double _atan(double t) {
  if (t > 1.0) {
    return _pi / 2.0 - _atanInner(1.0 / t);
  }
  if (t < -1.0) {
    return -_pi / 2.0 + _atanInner(-1.0 / t);
  }
  return _atanInner(t);
}

/// Two half-angle steps (argument at most 0.2) then a 24-term series.
double _atanInner(double t) {
  final double u = t / (1.0 + math.sqrt(1.0 + t * t));
  final double v = u / (1.0 + math.sqrt(1.0 + u * u));
  final double v2 = v * v;
  double term = v;
  double sum = v;
  for (int i = 1; i < 24; i++) {
    term *= -v2;
    sum += term / (2 * i + 1);
  }
  return 4.0 * sum;
}

/// Truncated remainder matching Java's `%` and JavaScript's `%` (Dart's
/// `%` is Euclidean and would wrap negative hues differently).
double _truncMod(double a, double b) {
  return a - b * (a / b).truncateToDouble();
}

// --- the OKLab matrices (themePalette.ts:504-531) -------------------------

double _srgbChannelToLinear(double channel) {
  final double c = channel / 255.0;
  return c <= 0.04045 ? c / 12.92 : _pow((c + 0.055) / 1.055, 2.4);
}

double _linearChannelToSrgb(double channel) {
  final double c =
      channel <= 0.0031308 ? channel * 12.92 : 1.055 * _pow(channel, 1.0 / 2.4) - 0.055;
  final double clamped = math.min(1.0, math.max(0.0, c));
  return (clamped * 255.0 + 0.5).floorToDouble();
}

// --- colour surface -------------------------------------------------------

/// An sRGB triple; channels are fractional like upstream mixes.
class Rgb {
  const Rgb(this.r, this.g, this.b);

  final double r;
  final double g;
  final double b;
}

/// An OKLCH colour: lightness `0..1`, chroma, hue in degrees.
class Lch {
  const Lch(this.l, this.c, this.h);

  final double l;
  final double c;
  final double h;
}

/// Parses `#RRGGBB` or `#AARRGGBB`; the alpha byte is ignored like
/// upstream `parseThemeRgbColor` (`themePalette.ts:420`).
Rgb parseHex(String? value) {
  if (value == null) {
    throw PaletteError('colour is null');
  }
  String v = value.trim();
  if (v.startsWith('#')) {
    v = v.substring(1);
  }
  if (v.length != 6 && v.length != 8) {
    throw PaletteError('colour is not #RRGGBB or #AARRGGBB: $value');
  }
  final int offset = v.length == 8 ? 2 : 0;
  return Rgb(
    _hexByte(v, offset, value).toDouble(),
    _hexByte(v, offset + 2, value).toDouble(),
    _hexByte(v, offset + 4, value).toDouble(),
  );
}

int _hexByte(String v, int at, String original) {
  if (at + 2 > v.length) {
    throw PaletteError('colour is not #RRGGBB or #AARRGGBB: $original');
  }
  return _hexDigit(v[at], original) * 16 + _hexDigit(v[at + 1], original);
}

int _hexDigit(String ch, String original) {
  final int code = ch.codeUnitAt(0);
  if (code >= 0x30 && code <= 0x39) {
    return code - 0x30;
  }
  if (code >= 0x61 && code <= 0x66) {
    return code - 0x61 + 10;
  }
  if (code >= 0x41 && code <= 0x46) {
    return code - 0x41 + 10;
  }
  throw PaletteError('colour is not #RRGGBB or #AARRGGBB: $original');
}

/// Formats a triple as lowercase `#rrggbb` (`themePalette.ts:425-433`).
String toHex(Rgb rgb) {
  return '#${_round8(rgb.r).toRadixString(16).padLeft(2, '0')}'
      '${_round8(rgb.g).toRadixString(16).padLeft(2, '0')}'
      '${_round8(rgb.b).toRadixString(16).padLeft(2, '0')}';
}

int _round8(double channel) {
  return (math.min(255.0, math.max(0.0, channel)) + 0.5).floor();
}

/// sRGB to OKLCH (`themeRgbToOklch`, themePalette.ts:504).
Lch fromRgb(Rgb rgb) {
  final double r = _srgbChannelToLinear(rgb.r);
  final double g = _srgbChannelToLinear(rgb.g);
  final double b = _srgbChannelToLinear(rgb.b);
  final double l = _cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  final double m = _cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  final double s = _cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  final double lOut = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  final double a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  final double bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  final double hue = _atan2(bb, a) * 180.0 / _pi;
  return Lch(lOut, math.sqrt(a * a + bb * bb), hue);
}

/// OKLCH to sRGB with the gamut map applied, rounded to 8-bit
/// (`themeOklchToRgb`, themePalette.ts:557-565).
Rgb toRgb(Lch color) {
  final Lch mapped = mapToSrgbGamut(color);
  final double hr = mapped.h * _deg2rad;
  final double a = mapped.c * _cos(hr);
  final double bb = mapped.c * _sin(hr);
  final double l = (mapped.l + 0.3963377774 * a + 0.2158037573 * bb);
  final double m = (mapped.l - 0.1055613458 * a - 0.0638541728 * bb);
  final double s = (mapped.l - 0.0894841775 * a - 1.291485548 * bb);
  final double ll = l * l * l;
  final double mm = m * m * m;
  final double ss = s * s * s;
  final double r = 4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss;
  final double g = -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss;
  final double b = -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss;
  return Rgb(_linearChannelToSrgb(r), _linearChannelToSrgb(g), _linearChannelToSrgb(b));
}

/// Chroma bisection onto the sRGB gamut (`mapThemeOklchToSrgbGamut`,
/// themePalette.ts:532-555); the step count comes from exact halving so the
/// ports cannot disagree (plan §15.2).
Lch mapToSrgbGamut(Lch color) {
  if (_inSrgbGamut(color.c, color)) {
    return color;
  }
  double low = 0.0;
  double high = color.c;
  const double resolution = 0.000001;
  double probe = math.max(color.c, resolution);
  int steps = 0;
  while (probe > resolution) {
    probe *= 0.5;
    steps++;
  }
  if (steps < 1) {
    steps = 1;
  }
  for (int i = 0; i < steps; i++) {
    final double mid = (low + high) / 2.0;
    if (_inSrgbGamut(mid, color)) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return Lch(color.l, low, color.h);
}

bool _inSrgbGamut(double chroma, Lch color) {
  final double hr = color.h * _deg2rad;
  final double a = chroma * _cos(hr);
  final double bb = chroma * _sin(hr);
  final double l = (color.l + 0.3963377774 * a + 0.2158037573 * bb);
  final double m = (color.l - 0.1055613458 * a - 0.0638541728 * bb);
  final double s = (color.l - 0.0894841775 * a - 1.291485548 * bb);
  final double ll = l * l * l;
  final double mm = m * m * m;
  final double ss = s * s * s;
  final double r = 4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss;
  final double g = -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss;
  final double b = -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss;
  return _channelInGamut(r) && _channelInGamut(g) && _channelInGamut(b);
}

bool _channelInGamut(double channel) {
  return channel >= -0.0001 && channel <= 1.0001;
}

/// WCAG relative luminance (`themeRelativeLuminance`, themePalette.ts:482).
double relativeLuminance(Rgb color) {
  return 0.2126 * _luminanceChannel(color.r) +
      0.7152 * _luminanceChannel(color.g) +
      0.0722 * _luminanceChannel(color.b);
}

double _luminanceChannel(double channel) {
  final double normalized = channel / 255.0;
  return normalized <= 0.03928
      ? normalized / 12.92
      : _pow((normalized + 0.055) / 1.055, 2.4);
}

/// WCAG contrast ratio (`themeContrastRatio`, themePalette.ts:805-811).
double contrastRatio(Rgb first, Rgb second) {
  final double firstLuminance = relativeLuminance(first);
  final double secondLuminance = relativeLuminance(second);
  final double lighter = math.max(firstLuminance, secondLuminance);
  final double darker = math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

// --- the generator (themePalette.ts:669-803) ------------------------------

// The standard status pairs (themePalette.ts:596-613).
const String _errorLight = '#fb2c36';
const String _errorForegroundLight = '#c10007';
const String _warningLight = '#fe9a00';
const String _warningForegroundLight = '#bb4d00';
const String _errorDark = '#fb414a';
const String _errorForegroundDark = '#ff6467';
const String _warningDark = '#fe9a00';
const String _warningForegroundDark = '#ffb900';

// Fixed readable foreground candidates (themePalette.ts:356-359).
const Rgb _themeLightForeground = Rgb(255, 250, 255);
const Rgb _themeDarkForeground = Rgb(36, 21, 35);
const Rgb _themeWhiteForeground = Rgb(255, 255, 255);
const Rgb _themeBlackForeground = Rgb(0, 0, 0);

// Measured stock muted contrasts (themePalette.ts:856-859).
const double _standardLightMutedContrast = 4.705;
const double _standardDarkMutedContrast = 5.082;

// Theme-independent alias targets: Tailwind v4.3.3 palette hexes
// (index.css:1104-1107, :1156-1157, :2025-2028).
const String _blue400 = '#56a2ff';
const String _blue500 = '#3280ff';
const String _blue700 = '#1447e6';
const String _emerald400 = '#00d294';
const String _emerald500 = '#00b981';
const String _emerald600 = '#009669';
const String _emerald700 = '#007857';
const String _red400 = '#ff6568';
const String _red600 = '#e40016';

/// Derives the full colour map from two seeds; see the Java port for the
/// algorithm anchors. `appearance` is `light`, `dark` or `system` and only
/// selects the `light-dark()` fixed tokens.
Map<String, String> generate(String appearance, String canvasHex, String accentHex) {
  final Rgb canvasRgb = parseHex(canvasHex);
  final Rgb accentRgb = parseHex(accentHex);
  final bool darkCanvas = relativeLuminance(canvasRgb) < 0.179;
  final bool darkSlot = _resolveSlot(appearance, darkCanvas);

  final Lch canvas = fromRgb(canvasRgb);
  final Lch accent = fromRgb(accentRgb);
  final double hue = accent.c < 0.02 ? canvas.h : accent.h;
  final double tintC = math.min(0.045, math.max(0.008, accent.c * 0.22));
  final double step = darkCanvas ? 1 : -1;

  final Lch textBase = Lch(darkCanvas ? 0.95 : 0.2, math.min(0.035, accent.c * 0.25), hue);
  final Lch text = _solveLightness(textBase, canvasRgb, 7.0, darkCanvas);
  final Rgb textRgb = toRgb(text);
  final Rgb textMutedRgb = _standardMutedText(canvasRgb, textRgb);

  final Lch action = Lch(
    math.min(0.85, math.max(0.35, accent.l + (darkCanvas ? 0.06 : -0.02))),
    math.max(accent.c * 0.9, 0.06),
    _truncMod(hue + 50, 360.0),
  );
  final Rgb actionRgb = toRgb(action);
  final String actionForeground = toHex(_readableForeground(actionRgb));

  final Lch sidebar = _surfaceAt(canvas, step, 0.045, hue, tintC * 1.4);
  final Rgb sidebarRgb = toRgb(sidebar);
  final Lch surface = _surfaceAt(canvas, step, 0.015, hue, tintC);
  final Lch surfaceRaised = _surfaceAt(canvas, step, 0.05, hue, tintC);
  final Rgb surfaceRaisedRgb = toRgb(surfaceRaised);
  final Lch surfaceOverlay = _surfaceAt(canvas, step, 0.075, hue, tintC);
  final Lch border = _surfaceAt(canvas, step, darkCanvas ? 0.16 : 0.12, hue,
      math.min(0.07, accent.c * 0.35));
  final Lch input = _surfaceAt(canvas, step, darkCanvas ? 0.21 : 0.16, hue,
      math.min(0.08, accent.c * 0.4));
  final Lch secondary = _surfaceAt(canvas, step, darkCanvas ? 0.1 : 0.06, hue,
      math.min(0.09, accent.c * 0.5));
  final Rgb secondaryRgb = toRgb(secondary);
  final Lch muted = _surfaceAt(canvas, step, darkCanvas ? 0.06 : 0.04, hue,
      math.min(0.06, accent.c * 0.35));
  final Rgb mutedRgb = toRgb(muted);
  final Lch accentSurface = _surfaceAt(canvas, step, darkCanvas ? 0.13 : 0.08, hue,
      math.min(0.11, accent.c * 0.55));
  final Rgb accentSurfaceRgb = toRgb(accentSurface);
  final Lch messageSurface = _surfaceAt(canvas, step, darkCanvas ? 0.16 : 0.1, hue,
      math.min(0.13, accent.c * 0.6));
  final Rgb messageSurfaceRgb = toRgb(messageSurface);
  final Lch codeBackground = _surfaceAt(canvas, step, 0.035, hue, tintC * 0.8);
  final Lch updateSurface = _surfaceAt(canvas, step, darkCanvas ? 0.14 : 0.09, hue,
      math.min(0.12, accent.c * 0.55));
  final Rgb updateSurfaceRgb = toRgb(updateSurface);

  final Lch actionHover =
      Lch(action.l + (darkCanvas ? 0.06 : -0.06), action.c, action.h);

  final _Status status = _standardStatus(canvasRgb);

  final Map<String, String> out = <String, String>{
    'accent': toHex(accentSurfaceRgb),
    'accent-foreground': _foregroundOn(textBase, accentSurfaceRgb, darkCanvas),
    'background': toHex(canvasRgb),
    'border': toHex(toRgb(border)),
    'card': toHex(toRgb(surface)),
    'card-foreground': toHex(textRgb),
    'code': toHex(toRgb(codeBackground)),
    'code-foreground': toHex(textRgb),
    'destructive': status.error,
    'destructive-foreground': status.errorForeground,
    'diff-addition': _emerald500,
    'diff-addition-foreground': darkSlot ? _emerald400 : _emerald600,
    'diff-deletion': status.error,
    'diff-deletion-foreground': darkSlot ? _red400 : _red600,
    'error': status.error,
    'error-foreground': status.errorForeground,
    'error-surface': status.errorSurface,
    'foreground': toHex(textRgb),
    'icon-muted': toHex(textMutedRgb),
    'info': _blue500,
    'info-foreground': darkSlot ? _blue400 : _blue700,
    'input': toHex(toRgb(input)),
    'message': toHex(messageSurfaceRgb),
    'message-action': toHex(actionRgb),
    'message-action-foreground': actionForeground,
    'message-action-hover': toHex(toRgb(actionHover)),
    'message-foreground': _foregroundOn(textBase, messageSurfaceRgb, darkCanvas),
    'muted': toHex(mutedRgb),
    'muted-foreground': toHex(_readableText(mutedRgb, textRgb, 1, 4.6)),
    'placeholder': toHex(_readableText(surfaceRaisedRgb, textRgb, 1, 4.6)),
    'popover': toHex(toRgb(surfaceOverlay)),
    'popover-foreground': toHex(textRgb),
    'primary': toHex(actionRgb),
    'primary-foreground': actionForeground,
    'ring': toHex(accentRgb),
    'secondary': toHex(secondaryRgb),
    'secondary-foreground': _foregroundOn(textBase, secondaryRgb, darkCanvas),
    'secondary-label': toHex(textMutedRgb),
    'sidebar': toHex(sidebarRgb),
    'sidebar-border': toHex(toRgb(_surfaceAt(canvas, step, darkCanvas ? 0.17 : 0.12, hue,
        math.min(0.08, accent.c * 0.4)))),
    'sidebar-control-surface': toHex(toRgb(_surfaceAt(canvas, step, darkCanvas ? 0.1 : 0.07,
        hue, tintC * 1.5))),
    'sidebar-foreground': _foregroundOn(textBase, sidebarRgb, darkCanvas),
    'sidebar-muted-foreground': toHex(_standardMutedText(sidebarRgb, textRgb)),
    'sidebar-row-active': toHex(toRgb(_surfaceAt(canvas, step, darkCanvas ? 0.12 : 0.09, hue,
        math.min(0.1, accent.c * 0.55)))),
    'sidebar-row-hover': toHex(toRgb(_surfaceAt(canvas, step, darkCanvas ? 0.08 : 0.06, hue,
        math.min(0.08, accent.c * 0.45)))),
    'sidebar-row-selected': toHex(toRgb(_surfaceAt(canvas, step, darkCanvas ? 0.14 : 0.1, hue,
        math.min(0.11, accent.c * 0.6)))),
    'success': _emerald500,
    'success-foreground': darkSlot ? _emerald400 : _emerald700,
    'surface-raised': toHex(toRgb(surfaceRaised)),
    'tool-error-icon': status.errorForeground,
    'update': toHex(accentRgb),
    'update-foreground': _foregroundOn(textBase, updateSurfaceRgb, darkCanvas),
    'update-surface': toHex(updateSurfaceRgb),
    'warning': status.warning,
    'warning-foreground': status.warningForeground,
    'warning-surface': status.warningSurface,
  };
  return out;
}

bool _resolveSlot(String appearance, bool darkCanvas) {
  final String mode = appearance.trim().toLowerCase();
  switch (mode) {
    case 'dark':
      return true;
    case 'light':
      return false;
    case 'system':
      return darkCanvas;
    default:
      throw PaletteError('appearance must be light, dark or system: $appearance');
  }
}

/// Upstream `surfaceAt` (themePalette.ts:691-694).
Lch _surfaceAt(Lch canvas, double step, double deltaL, double hue, double chroma) {
  final double lightness = math.min(0.98, math.max(0.05, canvas.l + step * deltaL));
  return Lch(lightness, chroma, hue);
}

/// Upstream `solveOklchLightness` (themePalette.ts:569-595).
Lch _solveLightness(Lch base, Rgb against, double minContrast, bool lighter) {
  double low = lighter ? base.l : 0.0;
  double high = lighter ? 1.0 : base.l;
  Lch candidate = base;
  if (contrastRatio(toRgb(candidate), against) >= minContrast) {
    return candidate;
  }
  for (int i = 0; i < 18; i++) {
    final double mid = (low + high) / 2.0;
    candidate = Lch(mid, base.c, base.h);
    final double contrast = contrastRatio(toRgb(candidate), against);
    if (contrast >= minContrast) {
      if (lighter) {
        high = mid;
      } else {
        low = mid;
      }
    } else if (lighter) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return Lch(lighter ? high : low, base.c, base.h);
}

/// The `foregroundOn` recipe (themePalette.ts:739-742).
String _foregroundOn(Lch textBase, Rgb surfaceRgb, bool darkCanvas) {
  return toHex(toRgb(_solveLightness(textBase, surfaceRgb, 4.6, darkCanvas)));
}

/// Upstream `readableThemeForeground` (themePalette.ts:813-824).
Rgb _readableForeground(Rgb background) {
  final double lightContrast = contrastRatio(background, _themeLightForeground);
  final double darkContrast = contrastRatio(background, _themeDarkForeground);
  if (math.max(lightContrast, darkContrast) >= 4.5) {
    return lightContrast >= darkContrast ? _themeLightForeground : _themeDarkForeground;
  }
  return contrastRatio(background, _themeWhiteForeground) >=
          contrastRatio(background, _themeBlackForeground)
      ? _themeWhiteForeground
      : _themeBlackForeground;
}

/// Upstream `readableThemeText` (themePalette.ts:826-851).
Rgb _readableText(Rgb background, Rgb foreground, double amount, double minimumRatio) {
  final Rgb softened = _mixRgb(foreground, background, amount);
  if (contrastRatio(softened, background) >= minimumRatio) {
    return softened;
  }
  Rgb readable = foreground;
  double lowerAmount = 0.0;
  double upperAmount = amount;
  for (int i = 0; i < 12; i++) {
    final double candidateAmount = (lowerAmount + upperAmount) / 2.0;
    final Rgb candidate = _mixRgb(foreground, background, candidateAmount);
    if (contrastRatio(candidate, background) >= minimumRatio) {
      readable = candidate;
      lowerAmount = candidateAmount;
    } else {
      upperAmount = candidateAmount;
    }
  }
  return readable;
}

/// Upstream `standardMutedThemeText` (themePalette.ts:861-869).
Rgb _standardMutedText(Rgb background, Rgb foreground) {
  final double target = relativeLuminance(background) < 0.179
      ? _standardDarkMutedContrast
      : _standardLightMutedContrast;
  return _readableText(background, foreground, 1, target);
}

/// Upstream `mixThemeRgbColors` (themePalette.ts:470-479).
Rgb _mixRgb(Rgb base, Rgb overlay, double amount) {
  return Rgb(
    base.r + (overlay.r - base.r) * amount,
    base.g + (overlay.g - base.g) * amount,
    base.b + (overlay.b - base.b) * amount,
  );
}

class _Status {
  const _Status(this.error, this.errorForeground, this.errorSurface, this.warning,
      this.warningForeground, this.warningSurface);

  final String error;
  final String errorForeground;
  final String errorSurface;
  final String warning;
  final String warningForeground;
  final String warningSurface;
}

/// Upstream `standardStatusColors` (themePalette.ts:616-662), keyed off the
/// canvas; the surface mix is 0.16 dark / 0.08 light (:638-641).
_Status _standardStatus(Rgb canvasRgb) {
  final bool dark = relativeLuminance(canvasRgb) < 0.179;
  final String error = dark ? _errorDark : _errorLight;
  final String errorForegroundSeed = dark ? _errorForegroundDark : _errorForegroundLight;
  final String warning = dark ? _warningDark : _warningLight;
  final String warningForegroundSeed = dark ? _warningForegroundDark : _warningForegroundLight;
  final double surfaceMix = dark ? 0.16 : 0.08;

  final Rgb errorSurfaceRgb = _mixRgb(canvasRgb, parseHex(error), surfaceMix);
  final Rgb warningSurfaceRgb = _mixRgb(canvasRgb, parseHex(warning), surfaceMix);
  return _Status(
    error,
    _readableOn(errorForegroundSeed, errorSurfaceRgb, dark),
    toHex(errorSurfaceRgb),
    warning,
    _readableOn(warningForegroundSeed, warningSurfaceRgb, dark),
    toHex(warningSurfaceRgb),
  );
}

/// The `readableOn` nudge of standardStatusColors (:639-647).
String _readableOn(String foregroundHex, Rgb surface, bool dark) {
  final Lch base = fromRgb(parseHex(foregroundHex));
  final Lch solved = _solveLightness(base, surface, 4.6, dark);
  return toHex(toRgb(solved));
}
