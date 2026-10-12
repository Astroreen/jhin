/*
 * Jhin — ui-kit path display helpers (SDUI contract level 4).
 */
package com.astroreen.jhin.plugin.uikit.text;

import com.astroreen.jhin.plugin.uikit.Ui;
import com.astroreen.jhin.plugin.uikit.UiNode;

/**
 * File-path display helpers (T302): {@link #middleTruncate(String, int)} for
 * long-path ellipsis that keeps the basename readable, {@link #basename}
 * for the last path segment, {@link #looksLikePath} for the summary-line
 * heuristic and {@link #chip(String)} for the path chip — the full path in
 * the tooltip, the middle-truncated label visible.
 *
 * <p>Truncation rule: a path within the budget is unchanged; otherwise the
 * path grows a head across slash boundaries while {@code head/…/name} fits
 * the budget and shortens the original; when no head fits, {@code …/name};
 * when the basename alone exceeds the budget, {@code …} plus its tail.
 * The ellipsis character is U+2026 {@code …}.
 */
public final class PathDisplay {

    /** The default label budget in characters (the chip label). */
    public static final int DEFAULT_MAX = 48;

    /** The ellipsis character (U+2026). */
    private static final String ELLIPSIS = "\u2026";

    private PathDisplay() {
    }

    /**
     * Middle-truncates one path to {@code max} characters, keeping the
     * basename whole when it fits.
     *
     * @param path the path; {@code null} renders as the empty string
     * @param max  the budget in characters
     * @return the display form, at most {@code max} characters
     */
    public static String middleTruncate(String path, int max) {
        if (path == null || path.isEmpty()) {
            return "";
        }
        if (max <= 0 || path.length() <= max) {
            return path;
        }
        String trimmed = path;
        while (trimmed.length() > 1 && trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        String name = basename(trimmed);
        if (name.isEmpty()) {
            name = trimmed;
        }
        if (name.length() >= max) {
            return ELLIPSIS + name.substring(name.length() - (max - 1));
        }
        String best = null;
        for (int i = 0; i < trimmed.length(); i++) {
            if (trimmed.charAt(i) != '/') {
                continue;
            }
            String head = trimmed.substring(0, i);
            if (head.isEmpty()) {
                continue;
            }
            String candidate = head + "/" + ELLIPSIS + "/" + name;
            if (candidate.length() <= max && candidate.length() < trimmed.length()) {
                best = candidate;
            }
        }
        if (best != null) {
            return best;
        }
        String fallback = ELLIPSIS + "/" + name;
        return fallback.length() <= max ? fallback
                : ELLIPSIS + name.substring(name.length() - (max - 1));
    }

    /**
     * The last path segment: trailing slashes are stripped first, and a
     * root-only path returns itself.
     *
     * @param path the path; {@code null} returns the empty string
     * @return the basename
     */
    public static String basename(String path) {
        if (path == null) {
            return "";
        }
        String trimmed = path.trim();
        while (trimmed.endsWith("/") && trimmed.length() > 1) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        int slash = trimmed.lastIndexOf('/');
        return slash >= 0 && slash < trimmed.length() - 1
                ? trimmed.substring(slash + 1)
                : trimmed;
    }

    /**
     * Whether one summary line is a bare file path: no whitespace, no JSON
     * punctuation, and a {@code /} somewhere (absolute, relative, {@code ./},
     * {@code ../}, {@code ~/}). JSON argument summaries and prose never
     * qualify.
     *
     * @param text the candidate text
     * @return {@code true} when the text displays as a path
     */
    public static boolean looksLikePath(String text) {
        if (text == null) {
            return false;
        }
        String trimmed = text.strip();
        if (trimmed.isEmpty()) {
            return false;
        }
        for (int i = 0; i < trimmed.length(); i++) {
            char c = trimmed.charAt(i);
            if (Character.isWhitespace(c) || c == '{' || c == '}' || c == '"') {
                return false;
            }
        }
        return trimmed.indexOf('/') >= 0;
    }

    /**
     * The path chip: the middle-truncated label, {@code kind: file} (which
     * renders as the monospace {@code jhin-path-chip}) and the full path in
     * the tooltip.
     *
     * @param path the path
     * @return the {@code chip} node
     */
    public static UiNode chip(String path) {
        String full = path == null ? "" : path;
        return Ui.chip()
                .label(middleTruncate(full, DEFAULT_MAX))
                .kind("file")
                .tooltip(full)
                .build();
    }
}
