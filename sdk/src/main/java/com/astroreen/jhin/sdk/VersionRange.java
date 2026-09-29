/**
 * A dependency version constraint in exactly one of the four accepted forms:
 * {@code *} (any version), {@code 1.2.3} (exact), {@code >=1.2.3} (at least)
 * and {@code >=1.2.3 <2.0.0} (at least, strictly below). Anything else is a
 * load error.
 *
 * <p>Used by the kernel to match a candidate plugin version against
 * {@link PluginManifest.Requirement#versionRange()}. Parse with
 * {@link #parse(String)}, then ask {@link #satisfies(String)}.
 *
 * <p>Invalid input throws {@link PluginException} (rather than
 * {@link IllegalArgumentException}) because a malformed range or version is a
 * contract violation discovered at plugin load — a load error by definition.
 *
 * <p>Comparison is semantic: the numeric {@code major}, {@code minor} and
 * {@code patch} components are compared as numbers (so {@code 1.10.0} is newer
 * than {@code 1.2.0}), never as text.
 */
package com.astroreen.jhin.sdk;

public final class VersionRange {

    private static final java.util.regex.Pattern VERSION =
            java.util.regex.Pattern.compile("^\\d+\\.\\d+\\.\\d+$");

    private enum Form {
        /** {@code *} — every valid version. */
        ANY,
        /** {@code X.Y.Z} — only that version. */
        EXACT,
        /** {@code >=X.Y.Z} — that version or newer. */
        LOWER_BOUND,
        /** {@code >=X.Y.Z <X.Y.Z} — at least the lower bound, strictly below the upper bound. */
        BOUNDED
    }

    private final Form form;
    private final long[] lower;
    private final long[] upper;

    private VersionRange(Form form, long[] lower, long[] upper) {
        this.form = form;
        this.lower = lower;
        this.upper = upper;
    }

    /**
     * Parses one of the four accepted forms. Called by the kernel at plugin
     * load, once per {@link PluginManifest.Requirement#versionRange()}.
     *
     * @param range the raw range text from the manifest
     * @return the parsed range
     * @throws PluginException if the text is {@code null}, blank or outside the
     *         four-form grammar (anything else is a load error)
     */
    public static VersionRange parse(String range) {
        if (range == null) {
            throw new PluginException("versionRange must not be null");
        }
        String trimmed = range.trim();
        if (trimmed.isEmpty()) {
            throw new PluginException("versionRange must not be blank");
        }
        if (trimmed.equals("*")) {
            return new VersionRange(Form.ANY, null, null);
        }
        String[] tokens = trimmed.split("\\s+");
        if (tokens.length == 1) {
            String token = tokens[0];
            if (isVersionToken(token)) {
                return new VersionRange(Form.EXACT, parseVersion(token), null);
            }
            if (token.startsWith(">=") && isVersionToken(token.substring(2))) {
                return new VersionRange(Form.LOWER_BOUND, parseVersion(token.substring(2)), null);
            }
        } else if (tokens.length == 2
                && tokens[0].startsWith(">=") && isVersionToken(tokens[0].substring(2))
                && tokens[1].startsWith("<") && isVersionToken(tokens[1].substring(1))) {
            return new VersionRange(
                    Form.BOUNDED, parseVersion(tokens[0].substring(2)), parseVersion(tokens[1].substring(1)));
        }
        throw new PluginException(unknownGrammar(range));
    }

    /**
     * Tests whether a candidate version falls into this range. Called by the
     * kernel while resolving {@link PluginManifest.Requirement}s at plugin
     * load, and at any later compatibility check.
     *
     * @param version a plain {@code major.minor.patch} version
     * @return {@code true} if the version satisfies this range
     * @throws PluginException if {@code version} is not {@code major.minor.patch}
     *         (an unparseable version here means validation was bypassed, hence
     *         a hard error)
     */
    public boolean satisfies(String version) {
        long[] candidate = parseVersion(version);
        switch (form) {
            case ANY:
                return true;
            case EXACT:
                return compare(candidate, lower) == 0;
            case LOWER_BOUND:
                return compare(candidate, lower) >= 0;
            case BOUNDED:
                return compare(candidate, lower) >= 0 && compare(candidate, upper) < 0;
            default:
                throw new IllegalStateException("unknown form: " + form);
        }
    }

    private static boolean isVersionToken(String token) {
        return VERSION.matcher(token).matches();
    }

    private static long[] parseVersion(String version) {
        if (!isVersionToken(version)) {
            throw new PluginException(
                    "invalid version: '" + version + "' (expected major.minor.patch)");
        }
        String[] parts = version.split("\\.");
        try {
            return new long[] {
                Long.parseLong(parts[0]), Long.parseLong(parts[1]), Long.parseLong(parts[2])
            };
        } catch (NumberFormatException e) {
            throw new PluginException(
                    "invalid version: '" + version + "' (component out of range)", e);
        }
    }

    private static int compare(long[] a, long[] b) {
        for (int i = 0; i < 3; i++) {
            int cmp = Long.compare(a[i], b[i]);
            if (cmp != 0) {
                return cmp;
            }
        }
        return 0;
    }

    private static String unknownGrammar(String range) {
        return "unknown versionRange grammar: '" + range
                + "' (expected one of: '*', 'X.Y.Z', '>=X.Y.Z', '>=X.Y.Z <X.Y.Z')";
    }
}
