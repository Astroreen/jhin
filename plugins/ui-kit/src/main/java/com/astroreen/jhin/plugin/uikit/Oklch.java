/**
 * Colour maths for the palette engine: hex to OKLCH and back, sRGB relative
 * luminance and the WCAG contrast ratio.
 *
 * <p>The conversion pipeline is the verbatim algorithm of upstream
 * {@code apps/web/src/themePalette.ts} (commit {@code 37de6cb}): the OKLab
 * matrices of {@code themeRgbToOklch} (themePalette.ts:504-518), the
 * unclamped OKLCH to linear sRGB step of {@code oklchToRgbUnclamped}
 * (themePalette.ts:520-531), the chroma-bisection gamut map of
 * {@code mapThemeOklchToSrgbGamut} (themePalette.ts:532-555) and the two sRGB
 * transfer curves ({@code srgbChannelToLinear} at :494-497 with the 0.04045
 * knee, {@code linearChannelToSrgb} at :499-503 with the 0.0031308 knee).
 * Upstream rounds to 8-bit channels exactly the same way
 * ({@code linearChannelToSrgb} returns {@code Math.round(... * 255)}).
 *
 * <p>Upstream computes relative luminance with the classic 0.03928 knee
 * (themePalette.ts:482-489), not the 0.04045 knee of the transfer curve.
 * Both are ported verbatim: the two knees must not be unified.
 *
 * <p>Every transcendental here is implemented on plain IEEE-754 double
 * arithmetic with a fixed iteration count and a fixed evaluation order, so
 * the Java port and the Dart port ({@code frontend/lib/design/palette_gen.dart})
 * produce bit-identical results on any toolchain. That is the answer to the
 * plan's §15.2 rounding-parity risk: parity is guaranteed by construction,
 * not by luck of matching {@code libm}. {@code Math.sqrt} is used freely —
 * square root is the one operation IEEE-754 requires to be correctly
 * rounded, so both languages agree bit-for-bit.
 */
package com.astroreen.jhin.plugin.uikit;

public final class Oklch {

    private Oklch() {
    }

    // --- deterministic elementary functions --------------------------------

    private static final double LN2 = 0.6931471805599453;
    private static final double PI = 3.141592653589793;
    private static final double DEG2RAD = 3.141592653589793 / 180.0;

    /** Natural log for {@code x > 0}: range-reduced atanh series, 24 terms. */
    static double ln(double x) {
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
        double t = (m - 1.0) / (m + 1.0);
        double t2 = t * t;
        double term = t;
        double sum = 0.0;
        for (int i = 0; i < 24; i++) {
            sum += term / (2 * i + 1);
            term *= t2;
        }
        return 2.0 * sum + k * LN2;
    }

    /** Exponential: {@code 2^k} scaling of a Taylor series, 20 terms. */
    static double exp(double x) {
        int k = (int) Math.floor(x / LN2);
        double r = x - k * LN2;
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

    /** {@code x^y} for {@code x > 0}, via {@link #exp} and {@link #ln}. */
    static double pow(double x, double y) {
        return exp(y * ln(x));
    }

    /**
     * Cube root: {@code exp(ln(x) / 3)} for positives, odd symmetry at
     * zero and below (the OKLab inputs are non-negative, the guard is for
     * completeness).
     */
    static double cbrt(double x) {
        if (x == 0.0) {
            return 0.0;
        }
        return x > 0.0 ? exp(ln(x) / 3.0) : -exp(ln(-x) / 3.0);
    }

    /**
     * Sine of radians. The argument is reduced to {@code (-pi, pi]} then to
     * {@code [-pi/2, pi/2]} where the series runs.
     */
    static double sin(double rad) {
        double r = reduceRad(rad);
        if (r > PI / 2.0) {
            return taylorSin(PI - r);
        }
        if (r < -PI / 2.0) {
            return -taylorSin(PI + r);
        }
        return taylorSin(r);
    }

    /** Cosine of radians, same reduction as {@link #sin}. */
    static double cos(double rad) {
        double r = reduceRad(rad);
        if (r > PI / 2.0) {
            return -taylorCos(PI - r);
        }
        if (r < -PI / 2.0) {
            return -taylorCos(PI + r);
        }
        return taylorCos(r);
    }

    /** Wraps radians into {@code (-pi, pi]} with exact arithmetic. */
    private static double reduceRad(double rad) {
        double r = rad;
        while (r > PI) {
            r -= 2.0 * PI;
        }
        while (r <= -PI) {
            r += 2.0 * PI;
        }
        return r;
    }

    /** Alternating sine series on {@code |r| <= pi/2}, 24 terms. */
    private static double taylorSin(double r) {
        double r2 = r * r;
        double term = r;
        double sum = r;
        for (int i = 1; i < 24; i++) {
            term *= -r2 / ((2 * i) * (2 * i + 1));
            sum += term;
        }
        return sum;
    }

    /** Alternating cosine series on {@code |r| <= pi/2}, 24 terms. */
    private static double taylorCos(double r) {
        double r2 = r * r;
        double term = 1.0;
        double sum = 1.0;
        for (int i = 1; i < 24; i++) {
            term *= -r2 / ((2 * i - 1) * (2 * i));
            sum += term;
        }
        return sum;
    }

    /**
     * Four-quadrant atan: {@code atan2(y, x)} in radians. The angle is the
     * upstream {@code Math.atan2(bb, a)} of {@code themeRgbToOklch}
     * (themePalette.ts:517).
     */
    static double atan2(double y, double x) {
        if (x == 0.0 && y == 0.0) {
            return 0.0;
        }
        if (x == 0.0) {
            return y > 0.0 ? PI / 2.0 : -PI / 2.0;
        }
        double base = atan(y / x);
        if (x > 0.0) {
            return base;
        }
        return y >= 0.0 ? base + PI : base - PI;
    }

    /** Arctangent on the full real line: half-angle reduction plus a series. */
    private static double atan(double t) {
        double v = t;
        if (v > 1.0) {
            return PI / 2.0 - atanInner(1.0 / v);
        }
        if (v < -1.0) {
            return -PI / 2.0 + atanInner(-1.0 / v);
        }
        return atanInner(v);
    }

    /** Two half-angle steps (argument at most 0.2) then a 24-term series. */
    private static double atanInner(double t) {
        double u = t / (1.0 + Math.sqrt(1.0 + t * t));
        double v = u / (1.0 + Math.sqrt(1.0 + u * u));
        double v2 = v * v;
        double term = v;
        double sum = v;
        for (int i = 1; i < 24; i++) {
            term *= -v2;
            sum += term / (2 * i + 1);
        }
        return 4.0 * sum;
    }

    // --- the OKLab matrices (themePalette.ts:504-531) ----------------------

    static double srgbChannelToLinear(double channel) {
        double c = channel / 255.0;
        return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
    }

    static double linearChannelToSrgb(double channel) {
        double c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * pow(channel, 1.0 / 2.4) - 0.055;
        double clamped = Math.min(1.0, Math.max(0.0, c));
        return Math.floor(clamped * 255.0 + 0.5);
    }

    // --- public colour surface --------------------------------------------

    /**
     * An sRGB triple, channels normally {@code 0..255}. The channels are
     * doubles because upstream mixes colours fractionally
     * ({@code mixThemeRgbColors}, themePalette.ts:470-479) and only rounds
     * when a hex string is produced ({@code themeRgbToHexColor}, :425-433);
     * rounding earlier would change the contrast search of
     * {@code readableThemeText}.
     */
    public record Rgb(double r, double g, double b) {
    }

    /** An OKLCH colour: lightness {@code 0..1}, chroma, hue in degrees. */
    public record Lch(double l, double c, double h) {
    }

    /**
     * Parses {@code #RRGGBB} or {@code #AARRGGBB} (the SettingsActions hex
     * contract of ui-default). The alpha byte is ignored exactly the way
     * upstream ignores it: {@code parseThemeRgbColor} (themePalette.ts:420)
     * converts only the opaque colour. Anything else raises the typed
     * {@link PaletteGen.PaletteError}.
     */
    public static Rgb parseHex(String value) {
        if (value == null) {
            throw new PaletteGen.PaletteError("colour is null");
        }
        String v = value.trim();
        if (v.startsWith("#")) {
            v = v.substring(1);
        }
        if (v.length() != 6 && v.length() != 8) {
            throw new PaletteGen.PaletteError("colour is not #RRGGBB or #AARRGGBB: " + value);
        }
        int offset = v.length() == 8 ? 2 : 0;
        return new Rgb(hexByte(v, offset, value), hexByte(v, offset + 2, value),
                hexByte(v, offset + 4, value));
    }

    private static int hexByte(String v, int at, String original) {
        if (at + 2 > v.length()) {
            throw new PaletteGen.PaletteError("colour is not #RRGGBB or #AARRGGBB: " + original);
        }
        int hi = hexDigit(v.charAt(at), original);
        int lo = hexDigit(v.charAt(at + 1), original);
        return hi * 16 + lo;
    }

    private static int hexDigit(char ch, String original) {
        if (ch >= '0' && ch <= '9') {
            return ch - '0';
        }
        if (ch >= 'a' && ch <= 'f') {
            return ch - 'a' + 10;
        }
        if (ch >= 'A' && ch <= 'F') {
            return ch - 'A' + 10;
        }
        throw new PaletteGen.PaletteError("colour is not #RRGGBB or #AARRGGBB: " + original);
    }

    /**
     * Formats a triple as lowercase {@code #rrggbb}, rounding the channels
     * exactly like upstream {@code themeRgbToHexColor}
     * (themePalette.ts:425-433): clamp to {@code 0..255}, then round.
     */
    public static String toHex(Rgb rgb) {
        return String.format("#%02x%02x%02x", round8(rgb.r()), round8(rgb.g()), round8(rgb.b()));
    }

    private static int round8(double channel) {
        return (int) Math.floor(Math.min(255.0, Math.max(0.0, channel)) + 0.5);
    }

    /** sRGB to OKLCH, upstream {@code themeRgbToOklch} (themePalette.ts:504). */
    public static Lch fromRgb(Rgb rgb) {
        double r = srgbChannelToLinear(rgb.r());
        double g = srgbChannelToLinear(rgb.g());
        double b = srgbChannelToLinear(rgb.b());
        double l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
        double m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
        double s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
        double lOut = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
        double a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
        double bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
        double hue = atan2(bb, a) * 180.0 / PI;
        return new Lch(lOut, Math.sqrt(a * a + bb * bb), hue);
    }

    /**
     * OKLCH to sRGB with the upstream gamut map applied first, rounded to
     * 8-bit channels: {@code themeOklchToRgb} (themePalette.ts:557-565).
     */
    public static Rgb toRgb(Lch color) {
        Lch mapped = mapToSrgbGamut(color);
        double hr = mapped.h() * DEG2RAD;
        double a = mapped.c() * cos(hr);
        double bb = mapped.c() * sin(hr);
        double l = (mapped.l() + 0.3963377774 * a + 0.2158037573 * bb);
        double m = (mapped.l() - 0.1055613458 * a - 0.0638541728 * bb);
        double s = (mapped.l() - 0.0894841775 * a - 1.2914855480 * bb);
        double ll = l * l * l;
        double mm = m * m * m;
        double ss = s * s * s;
        double r = 4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss;
        double g = -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss;
        double b = -0.0041960863 * ll - 0.7034186147 * mm + 1.7076147010 * ss;
        return new Rgb(linearChannelToSrgb(r), linearChannelToSrgb(g), linearChannelToSrgb(b));
    }

    /**
     * Chroma bisection onto the sRGB gamut, upstream
     * {@code mapThemeOklchToSrgbGamut} (themePalette.ts:532-555). The step
     * count of upstream is a {@code Math.log2} expression; it is computed
     * here by exact halving so the two ports cannot disagree on the number
     * of bisection steps (plan §15.2).
     */
    public static Lch mapToSrgbGamut(Lch color) {
        if (inSrgbGamut(color.c(), color)) {
            return color;
        }
        double low = 0.0;
        double high = color.c();
        double resolution = 0.000001;
        double probe = Math.max(color.c(), resolution);
        int steps = 0;
        while (probe > resolution) {
            probe *= 0.5;
            steps++;
        }
        if (steps < 1) {
            steps = 1;
        }
        for (int i = 0; i < steps; i++) {
            double mid = (low + high) / 2.0;
            if (inSrgbGamut(mid, color)) {
                low = mid;
            } else {
                high = mid;
            }
        }
        return new Lch(color.l(), low, color.h());
    }

    private static boolean inSrgbGamut(double chroma, Lch color) {
        double hr = color.h() * DEG2RAD;
        double a = chroma * cos(hr);
        double bb = chroma * sin(hr);
        double l = (color.l() + 0.3963377774 * a + 0.2158037573 * bb);
        double m = (color.l() - 0.1055613458 * a - 0.0638541728 * bb);
        double s = (color.l() - 0.0894841775 * a - 1.2914855480 * bb);
        double ll = l * l * l;
        double mm = m * m * m;
        double ss = s * s * s;
        double r = 4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss;
        double g = -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss;
        double b = -0.0041960863 * ll - 0.7034186147 * mm + 1.7076147010 * ss;
        return channelInGamut(r) && channelInGamut(g) && channelInGamut(b);
    }

    private static boolean channelInGamut(double channel) {
        return channel >= -0.0001 && channel <= 1.0001;
    }

    /**
     * WCAG relative luminance, upstream {@code themeRelativeLuminance}
     * (themePalette.ts:482-489) with the classic 0.03928 knee.
     */
    public static double relativeLuminance(Rgb color) {
        return 0.2126 * luminanceChannel(color.r())
                + 0.7152 * luminanceChannel(color.g())
                + 0.0722 * luminanceChannel(color.b());
    }

    private static double luminanceChannel(double channel) {
        double normalized = channel / 255.0;
        return normalized <= 0.03928
                ? normalized / 12.92
                : pow((normalized + 0.055) / 1.055, 2.4);
    }

    /**
     * WCAG contrast ratio, upstream {@code themeContrastRatio}
     * (themePalette.ts:805-811).
     */
    public static double contrastRatio(Rgb first, Rgb second) {
        double firstLuminance = relativeLuminance(first);
        double secondLuminance = relativeLuminance(second);
        double lighter = Math.max(firstLuminance, secondLuminance);
        double darker = Math.min(firstLuminance, secondLuminance);
        return (lighter + 0.05) / (darker + 0.05);
    }
}
