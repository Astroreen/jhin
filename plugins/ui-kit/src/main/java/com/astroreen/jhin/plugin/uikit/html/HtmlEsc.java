/*
 * Jhin — ui-kit HTML serialization (SDUI contract level 4).
 */
package com.astroreen.jhin.plugin.uikit.html;

/**
 * The single escaping authority for the HTML renderer.
 *
 * <p>Every string that originates from a {@code UiNode} prop — node text,
 * labels, titles, subtitles, placeholders, messages, code bodies, markdown
 * source, and any value interpolated into a {@code class}, {@code style} or
 * {@code data-*} attribute — passes through this class before it reaches
 * markup. Nothing else in the codebase may concatenate an unescaped prop into
 * a tag; the only unescaped path in the whole renderer is the explicit
 * {@code Ui.raw(String)} escape hatch, which is reserved for trusted,
 * server-authored chrome.
 *
 * <p>All three entry points escape the same five characters
 * ({@code & < > " '}) so that a value is safe in text content, in a
 * double-quoted attribute and in a single-quoted attribute alike. They are
 * kept as separate methods because the call site's intent is part of the
 * security review surface: {@link #text(String)} reads as "this lands in a
 * text node", {@link #attr(String)} as "this lands in a double-quoted
 * attribute", {@link #attrSingle(String)} as "this lands in a single-quoted
 * attribute" (the shape {@code data-jhin-action='…'} uses, so that embedded
 * JSON keeps its double quotes readable).
 *
 * <p>Escaping the ampersand first is what makes the transformation safe: it
 * guarantees no entity this method emits can be re-interpreted by a later
 * pass. The implementation is a single forward scan, so that property holds
 * by construction rather than by ordering of replacements.
 *
 * <p>This class is stateless and thread-safe.
 */
public final class HtmlEsc {

    private HtmlEsc() {
    }

    /**
     * Escapes a value destined for HTML text content.
     *
     * @param value the raw value; {@code null} is treated as absent
     * @return the escaped value, or the empty string when {@code value} is
     *         {@code null}
     */
    public static String text(String value) {
        return escape(value);
    }

    /**
     * Escapes a value destined for a double-quoted attribute. Attribute values
     * emitted by {@link HtmlNode} are always double-quoted, so this is the
     * default attribute escaper.
     *
     * @param value the raw value; {@code null} is treated as absent
     * @return the escaped value, or the empty string when {@code value} is
     *         {@code null}
     */
    public static String attr(String value) {
        return escape(value);
    }

    /**
     * Escapes a value destined for a single-quoted attribute — the
     * {@code data-jhin-action='<json>'} shape, where the apostrophe is the
     * character that would break out of the attribute. All five significant
     * characters are escaped here exactly as in {@link #attr(String)}: an
     * over-escaped value decodes back to the original on parse, and stays
     * safe even if the quoting of the attribute ever changes.
     *
     * @param value the raw value; {@code null} is treated as absent
     * @return the escaped value, or the empty string when {@code value} is
     *         {@code null}
     */
    public static String attrSingle(String value) {
        return escape(value);
    }

    /**
     * Escapes the five HTML-significant characters in one forward scan.
     *
     * <p>Returns the original instance when nothing needs escaping, so the
     * common case allocates nothing.
     */
    private static String escape(String value) {
        if (value == null) {
            return "";
        }
        int length = value.length();
        int first = -1;
        for (int i = 0; i < length; i++) {
            if (significant(value.charAt(i))) {
                first = i;
                break;
            }
        }
        if (first < 0) {
            return value;
        }
        StringBuilder out = new StringBuilder(length + 16);
        out.append(value, 0, first);
        for (int i = first; i < length; i++) {
            char c = value.charAt(i);
            switch (c) {
                case '&' -> out.append("&amp;");
                case '<' -> out.append("&lt;");
                case '>' -> out.append("&gt;");
                case '"' -> out.append("&quot;");
                case '\'' -> out.append("&#39;");
                default -> out.append(c);
            }
        }
        return out.toString();
    }

    private static boolean significant(char c) {
        return c == '&' || c == '<' || c == '>' || c == '"' || c == '\'';
    }
}
