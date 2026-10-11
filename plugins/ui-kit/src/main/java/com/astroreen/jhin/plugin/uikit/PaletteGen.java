/**
 * The two-seed OKLCH palette generator: a faithful Java port of upstream
 * {@code createVividThemeColors(appearance, canvas, accent)}
 * ({@code apps/web/src/themePalette.ts:669-803}, commit {@code 37de6cb}).
 *
 * <p>Given a canvas and an accent seed the generator derives the complete
 * semantic colour surface: the perceptual lightness ladder of
 * {@code surfaceAt} (themePalette.ts:691-694), WCAG-solved foregrounds, the
 * +50 degree companion action colour (:709-715) and the standard status
 * blends (:616-662). The returned map has exactly the keys of
 * {@link UiTokens#COLOR_KEYS} — the 56 semantic {@code --color-*} alias
 * names of the upstream {@code @theme inline} block (index.css:221-276) —
 * with each key resolved to the token its alias points at in the themed
 * layer (index.css:1228-1291).
 *
 * <p>Algorithm constants, all verified against the upstream checkout:
 * <ul>
 *   <li>dark ramp when {@code relativeLuminance(canvas) < 0.179}
 *       (themePalette.ts:686);</li>
 *   <li>hue from the accent, falling back to the canvas hue when the accent
 *       chroma is under 0.02 (:687);</li>
 *   <li>surface tint {@code min(0.045, max(0.008, accentC * 0.22))} (:688);</li>
 *   <li>text solved to 7:1 against the canvas (:705); surface foregrounds
 *       solved to 4.6:1 against their own surface (:739-742); muted text
 *       blends to 4.6 or to the measured stock ratios 4.705 / 5.082
 *       (:858-865); the action foregrounds pick between the fixed
 *       readable candidates at a 4.5 floor (:813-824);</li>
 *   <li>the companion action rotates the hue by +50 degrees with 90% of the
 *       accent chroma (:711-715);</li>
 *   <li>the error/warning surfaces blend the standard status colours over
 *       the canvas at 16% for dark canvases and 8% for light ones
 *       (:638-641) — note the order: the plan's "8% dark / 16% light" prose
 *       is inverted against upstream.</li>
 * </ul>
 *
 * <p>Where upstream emits CSS {@code oklch(...)} strings
 * ({@code formatOklchThemeColor}, themePalette.ts:391-399) this port emits
 * 8-bit hex, the wire format of the Jhin token layer. The theme-independent
 * tokens of the alias block ({@code info}, {@code success}, the
 * {@code diff-*} pair) are the fixed Tailwind values the unthemed app uses
 * (index.css:1104-1107, :1156-1157, :2025-2028; palette of
 * {@code tailwindcss@4.3.3}, pnpm-lock.yaml:88).
 */
package com.astroreen.jhin.plugin.uikit;

import java.util.Map;
import java.util.TreeMap;

public final class PaletteGen {

    private PaletteGen() {
    }

    /** A typed generation failure: unparsable seeds or an unknown mode. */
    public static final class PaletteError extends IllegalArgumentException {

        public PaletteError(String message) {
            super(message);
        }
    }

    // --- fixed status and palette constants -------------------------------

    /**
     * The standard status pairs, upstream {@code STANDARD_STATUS_COLORS}
     * (themePalette.ts:596-613): the app's own red/amber families, so a
     * generated theme never inherits a brand tint on destructive colours.
     */
    private static final String ERROR_LIGHT = "#fb2c36";
    private static final String ERROR_FOREGROUND_LIGHT = "#c10007";
    private static final String WARNING_LIGHT = "#fe9a00";
    private static final String WARNING_FOREGROUND_LIGHT = "#bb4d00";
    private static final String ERROR_DARK = "#fb414a";
    private static final String ERROR_FOREGROUND_DARK = "#ff6467";
    private static final String WARNING_DARK = "#fe9a00";
    private static final String WARNING_FOREGROUND_DARK = "#ffb900";

    /** Fixed readable foreground candidates (themePalette.ts:356-359). */
    private static final Oklch.Rgb THEME_LIGHT_FOREGROUND = new Oklch.Rgb(255, 250, 255);
    private static final Oklch.Rgb THEME_DARK_FOREGROUND = new Oklch.Rgb(36, 21, 35);
    private static final Oklch.Rgb THEME_WHITE_FOREGROUND = new Oklch.Rgb(255, 255, 255);
    private static final Oklch.Rgb THEME_BLACK_FOREGROUND = new Oklch.Rgb(0, 0, 0);

    /** Measured stock muted contrasts (themePalette.ts:856-859). */
    private static final double STANDARD_LIGHT_MUTED_CONTRAST = 4.705;
    private static final double STANDARD_DARK_MUTED_CONTRAST = 5.082;

    /**
     * Theme-independent alias targets: Tailwind v4.3.3 palette values in
     * hex (index.css:1104-1107, :1156-1157 and the diff block :2025-2028),
     * converted through the same gamut-mapped pipeline as every generated
     * colour.
     */
    private static final String BLUE_400 = "#56a2ff";
    private static final String BLUE_500 = "#3280ff";
    private static final String BLUE_700 = "#1447e6";
    private static final String EMERALD_400 = "#00d294";
    private static final String EMERALD_500 = "#00b981";
    private static final String EMERALD_600 = "#009669";
    private static final String EMERALD_700 = "#007857";
    private static final String RED_400 = "#ff6568";
    private static final String RED_600 = "#e40016";

    // --- generation --------------------------------------------------------

    /**
     * Derives the full colour map from two seeds.
     *
     * @param appearance the appearance slot, {@code light}, {@code dark} or
     *                   {@code system}; it only selects the
     *                   {@code light-dark()} fixed tokens (info/success/diff
     *                   foregrounds). Every ramp and contrast search follows
     *                   the canvas the caller picked, exactly like upstream
     *                   (themePalette.ts:682-686)
     * @param canvasHex  the canvas seed, {@code #RRGGBB} or {@code #AARRGGBB}
     * @param accentHex  the accent seed, {@code #RRGGBB} or {@code #AARRGGBB}
     * @return exactly the {@link UiTokens#COLOR_KEYS} names mapped to hex
     * @throws PaletteError when a seed is not a hex colour or the mode is
     *                      not one of {@code light}/{@code dark}/{@code system}
     */
    public static Map<String, String> generate(String appearance, String canvasHex, String accentHex) {
        Oklch.Rgb canvasRgb = Oklch.parseHex(canvasHex);
        Oklch.Rgb accentRgb = Oklch.parseHex(accentHex);
        boolean darkCanvas = Oklch.relativeLuminance(canvasRgb) < 0.179;
        boolean darkSlot = resolveSlot(appearance, darkCanvas);

        Oklch.Lch canvas = Oklch.fromRgb(canvasRgb);
        Oklch.Lch accent = Oklch.fromRgb(accentRgb);
        double hue = accent.c() < 0.02 ? canvas.h() : accent.h();
        double tintC = Math.min(0.045, Math.max(0.008, accent.c() * 0.22));
        double step = darkCanvas ? 1 : -1;

        // Text carries a whisper of the accent hue and is solved to WCAG AAA
        // against the canvas (themePalette.ts:697-710).
        Oklch.Lch textBase = new Oklch.Lch(darkCanvas ? 0.95 : 0.2,
                Math.min(0.035, accent.c() * 0.25), hue);
        Oklch.Lch text = solveLightness(textBase, canvasRgb, 7.0, darkCanvas);
        Oklch.Rgb textRgb = Oklch.toRgb(text);
        Oklch.Rgb textMutedRgb = standardMutedText(canvasRgb, textRgb);

        // The companion action rotates off the accent (themePalette.ts:708-715).
        Oklch.Lch action = new Oklch.Lch(
                Math.min(0.85, Math.max(0.35, accent.l() + (darkCanvas ? 0.06 : -0.02))),
                Math.max(accent.c() * 0.9, 0.06),
                truncMod(hue + 50, 360.0));
        Oklch.Rgb actionRgb = Oklch.toRgb(action);
        String actionForeground = Oklch.toHex(readableForeground(actionRgb));

        // The surface ladder (themePalette.ts:720-737).
        Oklch.Lch sidebar = surfaceAt(canvas, step, 0.045, hue, tintC * 1.4);
        Oklch.Rgb sidebarRgb = Oklch.toRgb(sidebar);
        Oklch.Lch surface = surfaceAt(canvas, step, 0.015, hue, tintC);
        Oklch.Lch surfaceRaised = surfaceAt(canvas, step, 0.05, hue, tintC);
        Oklch.Rgb surfaceRaisedRgb = Oklch.toRgb(surfaceRaised);
        Oklch.Lch surfaceOverlay = surfaceAt(canvas, step, 0.075, hue, tintC);
        Oklch.Lch border = surfaceAt(canvas, step, darkCanvas ? 0.16 : 0.12, hue,
                Math.min(0.07, accent.c() * 0.35));
        Oklch.Lch input = surfaceAt(canvas, step, darkCanvas ? 0.21 : 0.16, hue,
                Math.min(0.08, accent.c() * 0.4));
        Oklch.Lch secondary = surfaceAt(canvas, step, darkCanvas ? 0.1 : 0.06, hue,
                Math.min(0.09, accent.c() * 0.5));
        Oklch.Rgb secondaryRgb = Oklch.toRgb(secondary);
        Oklch.Lch muted = surfaceAt(canvas, step, darkCanvas ? 0.06 : 0.04, hue,
                Math.min(0.06, accent.c() * 0.35));
        Oklch.Rgb mutedRgb = Oklch.toRgb(muted);
        Oklch.Lch accentSurface = surfaceAt(canvas, step, darkCanvas ? 0.13 : 0.08, hue,
                Math.min(0.11, accent.c() * 0.55));
        Oklch.Rgb accentSurfaceRgb = Oklch.toRgb(accentSurface);
        Oklch.Lch messageSurface = surfaceAt(canvas, step, darkCanvas ? 0.16 : 0.1, hue,
                Math.min(0.13, accent.c() * 0.6));
        Oklch.Rgb messageSurfaceRgb = Oklch.toRgb(messageSurface);
        Oklch.Lch codeBackground = surfaceAt(canvas, step, 0.035, hue, tintC * 0.8);
        Oklch.Lch updateSurface = surfaceAt(canvas, step, darkCanvas ? 0.14 : 0.09, hue,
                Math.min(0.12, accent.c() * 0.55));
        Oklch.Rgb updateSurfaceRgb = Oklch.toRgb(updateSurface);

        Oklch.Lch actionHover = new Oklch.Lch(
                action.l() + (darkCanvas ? 0.06 : -0.06), action.c(), action.h());

        Status status = standardStatus(canvasRgb);

        Map<String, String> out = new TreeMap<>();
        out.put("accent", Oklch.toHex(accentSurfaceRgb));
        out.put("accent-foreground", foregroundOn(textBase, accentSurfaceRgb, darkCanvas));
        out.put("background", Oklch.toHex(canvasRgb));
        out.put("border", Oklch.toHex(Oklch.toRgb(border)));
        out.put("card", Oklch.toHex(Oklch.toRgb(surface)));
        out.put("card-foreground", Oklch.toHex(textRgb));
        out.put("code", Oklch.toHex(Oklch.toRgb(codeBackground)));
        out.put("code-foreground", Oklch.toHex(textRgb));
        out.put("destructive", status.error);
        out.put("destructive-foreground", status.errorForeground);
        out.put("diff-addition", EMERALD_500);
        out.put("diff-addition-foreground", darkSlot ? EMERALD_400 : EMERALD_600);
        out.put("diff-deletion", status.error);
        out.put("diff-deletion-foreground", darkSlot ? RED_400 : RED_600);
        out.put("error", status.error);
        out.put("error-foreground", status.errorForeground);
        out.put("error-surface", status.errorSurface);
        out.put("foreground", Oklch.toHex(textRgb));
        out.put("icon-muted", Oklch.toHex(textMutedRgb));
        out.put("info", BLUE_500);
        out.put("info-foreground", darkSlot ? BLUE_400 : BLUE_700);
        out.put("input", Oklch.toHex(Oklch.toRgb(input)));
        out.put("message", Oklch.toHex(messageSurfaceRgb));
        out.put("message-action", Oklch.toHex(actionRgb));
        out.put("message-action-foreground", actionForeground);
        out.put("message-action-hover", Oklch.toHex(Oklch.toRgb(actionHover)));
        out.put("message-foreground", foregroundOn(textBase, messageSurfaceRgb, darkCanvas));
        out.put("muted", Oklch.toHex(mutedRgb));
        out.put("muted-foreground", Oklch.toHex(readableText(mutedRgb, textRgb, 1, 4.6)));
        out.put("placeholder", Oklch.toHex(readableText(surfaceRaisedRgb, textRgb, 1, 4.6)));
        out.put("popover", Oklch.toHex(Oklch.toRgb(surfaceOverlay)));
        out.put("popover-foreground", Oklch.toHex(textRgb));
        out.put("primary", Oklch.toHex(actionRgb));
        out.put("primary-foreground", actionForeground);
        out.put("ring", Oklch.toHex(accentRgb));
        out.put("secondary", Oklch.toHex(secondaryRgb));
        out.put("secondary-foreground", foregroundOn(textBase, secondaryRgb, darkCanvas));
        out.put("secondary-label", Oklch.toHex(textMutedRgb));
        out.put("sidebar", Oklch.toHex(sidebarRgb));
        out.put("sidebar-border", Oklch.toHex(Oklch.toRgb(surfaceAt(canvas, step,
                darkCanvas ? 0.17 : 0.12, hue, Math.min(0.08, accent.c() * 0.4)))));
        out.put("sidebar-control-surface", Oklch.toHex(Oklch.toRgb(surfaceAt(canvas, step,
                darkCanvas ? 0.1 : 0.07, hue, tintC * 1.5))));
        out.put("sidebar-foreground", foregroundOn(textBase, sidebarRgb, darkCanvas));
        out.put("sidebar-muted-foreground", Oklch.toHex(standardMutedText(sidebarRgb, textRgb)));
        out.put("sidebar-row-active", Oklch.toHex(Oklch.toRgb(surfaceAt(canvas, step,
                darkCanvas ? 0.12 : 0.09, hue, Math.min(0.1, accent.c() * 0.55)))));
        out.put("sidebar-row-hover", Oklch.toHex(Oklch.toRgb(surfaceAt(canvas, step,
                darkCanvas ? 0.08 : 0.06, hue, Math.min(0.08, accent.c() * 0.45)))));
        out.put("sidebar-row-selected", Oklch.toHex(Oklch.toRgb(surfaceAt(canvas, step,
                darkCanvas ? 0.14 : 0.1, hue, Math.min(0.11, accent.c() * 0.6)))));
        out.put("success", EMERALD_500);
        out.put("success-foreground", darkSlot ? EMERALD_400 : EMERALD_700);
        out.put("surface-raised", Oklch.toHex(Oklch.toRgb(surfaceRaised)));
        // index.css:1264: --tool-error-icon resolves to the error foreground.
        out.put("tool-error-icon", status.errorForeground);
        out.put("update", Oklch.toHex(accentRgb));
        out.put("update-foreground", foregroundOn(textBase, updateSurfaceRgb, darkCanvas));
        out.put("update-surface", Oklch.toHex(updateSurfaceRgb));
        out.put("warning", status.warning);
        out.put("warning-foreground", status.warningForeground);
        out.put("warning-surface", status.warningSurface);

        if (!out.keySet().equals(UiTokens.COLOR_KEYS)) {
            throw new IllegalStateException("palette keys do not match UiTokens.COLOR_KEYS");
        }
        return out;
    }

    /** The appearance slot: {@code system} resolves off the canvas. */
    private static boolean resolveSlot(String appearance, boolean darkCanvas) {
        if (appearance == null) {
            throw new PaletteError("appearance is null");
        }
        String mode = appearance.trim().toLowerCase(java.util.Locale.ROOT);
        switch (mode) {
            case "dark":
                return true;
            case "light":
                return false;
            case "system":
                return darkCanvas;
            default:
                throw new PaletteError("appearance must be light, dark or system: " + appearance);
        }
    }

    /**
     * Upstream {@code surfaceAt} (themePalette.ts:691-694).
     */
    private static Oklch.Lch surfaceAt(Oklch.Lch canvas, double step,
            double deltaL, double hue, double chroma) {
        double lightness = Math.min(0.98, Math.max(0.05, canvas.l() + step * deltaL));
        return new Oklch.Lch(lightness, chroma, hue);
    }

    /**
     * Truncated remainder for the companion hue: Java's {@code %} semantics,
     * spelled as an explicit formula so the result does not depend on a
     * language's remainder convention. In the reachable domain
     * ({@code hue + 50} in {@code [-130, 230]}) the division is exact.
     */
    private static double truncMod(double value, double modulus) {
        return value - modulus * (long) (value / modulus);
    }

    /** Upstream {@code solveOklchLightness} (themePalette.ts:569-595). */
    private static Oklch.Lch solveLightness(Oklch.Lch base, Oklch.Rgb against,
            double minContrast, boolean lighter) {
        double low = lighter ? base.l() : 0.0;
        double high = lighter ? 1.0 : base.l();
        Oklch.Lch candidate = base;
        if (Oklch.contrastRatio(Oklch.toRgb(candidate), against) >= minContrast) {
            return candidate;
        }
        for (int step = 0; step < 18; step++) {
            double mid = (low + high) / 2.0;
            candidate = new Oklch.Lch(mid, base.c(), base.h());
            double contrast = Oklch.contrastRatio(Oklch.toRgb(candidate), against);
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
        return new Oklch.Lch(lighter ? high : low, base.c(), base.h());
    }

    /** The {@code foregroundOn} recipe (themePalette.ts:739-742). */
    private static String foregroundOn(Oklch.Lch textBase, Oklch.Rgb surfaceRgb, boolean darkCanvas) {
        return Oklch.toHex(Oklch.toRgb(solveLightness(textBase, surfaceRgb, 4.6, darkCanvas)));
    }

    /** Upstream {@code readableThemeForeground} (themePalette.ts:813-824). */
    private static Oklch.Rgb readableForeground(Oklch.Rgb background) {
        double lightContrast = Oklch.contrastRatio(background, THEME_LIGHT_FOREGROUND);
        double darkContrast = Oklch.contrastRatio(background, THEME_DARK_FOREGROUND);
        if (Math.max(lightContrast, darkContrast) >= 4.5) {
            return lightContrast >= darkContrast ? THEME_LIGHT_FOREGROUND : THEME_DARK_FOREGROUND;
        }
        return Oklch.contrastRatio(background, THEME_WHITE_FOREGROUND)
                >= Oklch.contrastRatio(background, THEME_BLACK_FOREGROUND)
                ? THEME_WHITE_FOREGROUND : THEME_BLACK_FOREGROUND;
    }

    /** Upstream {@code readableThemeText} (themePalette.ts:826-851). */
    private static Oklch.Rgb readableText(Oklch.Rgb background, Oklch.Rgb foreground,
            double amount, double minimumRatio) {
        Oklch.Rgb softened = mixRgb(foreground, background, amount);
        if (Oklch.contrastRatio(softened, background) >= minimumRatio) {
            return softened;
        }
        Oklch.Rgb readable = foreground;
        double lowerAmount = 0.0;
        double upperAmount = amount;
        for (int index = 0; index < 12; index++) {
            double candidateAmount = (lowerAmount + upperAmount) / 2.0;
            Oklch.Rgb candidate = mixRgb(foreground, background, candidateAmount);
            if (Oklch.contrastRatio(candidate, background) >= minimumRatio) {
                readable = candidate;
                lowerAmount = candidateAmount;
            } else {
                upperAmount = candidateAmount;
            }
        }
        return readable;
    }

    /** Upstream {@code standardMutedThemeText} (themePalette.ts:861-869). */
    private static Oklch.Rgb standardMutedText(Oklch.Rgb background, Oklch.Rgb foreground) {
        double target = Oklch.relativeLuminance(background) < 0.179
                ? STANDARD_DARK_MUTED_CONTRAST
                : STANDARD_LIGHT_MUTED_CONTRAST;
        return readableText(background, foreground, 1, target);
    }

    /**
     * Upstream {@code mixThemeRgbColors} (themePalette.ts:470-479): the mix
     * keeps fractional channels; only hex formatting rounds.
     */
    private static Oklch.Rgb mixRgb(Oklch.Rgb base, Oklch.Rgb overlay, double amount) {
        return new Oklch.Rgb(
                mixChannel(base.r(), overlay.r(), amount),
                mixChannel(base.g(), overlay.g(), amount),
                mixChannel(base.b(), overlay.b(), amount));
    }

    private static double mixChannel(double base, double overlay, double amount) {
        return base + (overlay - base) * amount;
    }

    /** The derived standard status sextuple (themePalette.ts:616-662). */
    private record Status(String error, String errorForeground, String errorSurface,
            String warning, String warningForeground, String warningSurface) {
    }

    /**
     * Upstream {@code standardStatusColors} (themePalette.ts:616-662),
     * keyed off the canvas rather than the appearance slot. The surface mix
     * is 0.16 for dark canvases and 0.08 for light ones (:638-641); the
     * readable foregrounds clear 4.6:1 on their own surface (:639-647).
     */
    private static Status standardStatus(Oklch.Rgb canvasRgb) {
        boolean dark = Oklch.relativeLuminance(canvasRgb) < 0.179;
        String error = dark ? ERROR_DARK : ERROR_LIGHT;
        String errorForegroundSeed = dark ? ERROR_FOREGROUND_DARK : ERROR_FOREGROUND_LIGHT;
        String warning = dark ? WARNING_DARK : WARNING_LIGHT;
        String warningForegroundSeed = dark ? WARNING_FOREGROUND_DARK : WARNING_FOREGROUND_LIGHT;
        double surfaceMix = dark ? 0.16 : 0.08;

        Oklch.Rgb errorSurfaceRgb = mixRgb(canvasRgb, Oklch.parseHex(error), surfaceMix);
        Oklch.Rgb warningSurfaceRgb = mixRgb(canvasRgb, Oklch.parseHex(warning), surfaceMix);
        return new Status(
                error,
                readableOn(errorForegroundSeed, errorSurfaceRgb, dark),
                Oklch.toHex(errorSurfaceRgb),
                warning,
                readableOn(warningForegroundSeed, warningSurfaceRgb, dark),
                Oklch.toHex(warningSurfaceRgb));
    }

    /** The {@code readableOn} nudge of standardStatusColors (:639-647). */
    private static String readableOn(String foregroundHex, Oklch.Rgb surface, boolean dark) {
        Oklch.Lch base = Oklch.fromRgb(Oklch.parseHex(foregroundHex));
        Oklch.Lch solved = solveLightness(base, surface, 4.6, dark);
        return Oklch.toHex(Oklch.toRgb(solved));
    }
}
