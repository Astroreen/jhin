/**
 * Client identity and capabilities, parsed from the {@code X-Jhin-Client}
 * header (D-22).
 *
 * <p>Created by the kernel through {@link #parse(String)} once per request and
 * exposed as {@link HttpRequest#client()}. The kernel never branches on the
 * header itself; plugins must treat an absent capability as unsupported and
 * degrade instead of emitting a node or directive the client cannot honour.
 *
 * <p>The header format is {@code api=<int>; version=<semver>;
 * caps=<comma-separated>} with the keys accepted in any order; unknown keys
 * are ignored. Capability names defined at api 1: {@code sse},
 * {@code tls_pinning}, {@code secure_storage}, {@code open_url},
 * {@code multi_profile}; the set only grows with frontend releases, names are
 * never removed.
 *
 * <p>Components: {@code api} — the client API level ({@code 0} when unknown);
 * {@code version} — the client version string (empty when unknown);
 * {@code caps} — the declared capability names, lower-cased.
 */
package com.astroreen.jhin.sdk.http;

import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

public record ClientInfo(int api, String version, Set<String> caps) {

    /** The neutral instance used when the header is absent or malformed. */
    public static final ClientInfo UNKNOWN = new ClientInfo(0, "", Set.of());

    /**
     * Creates a client info, defensively normalizing its components: a
     * {@code null} version becomes empty and the capability set is copied as
     * an immutable, lower-cased, trimmed set. Called by {@link #parse(String)}
     * and by tests.
     *
     * @param api    the client API level
     * @param version the client version string
     * @param caps   the declared capability names
     */
    public ClientInfo {
        version = (version == null) ? "" : version;
        Set<String> normalized = new LinkedHashSet<>();
        if (caps != null) {
            for (String capability : caps) {
                if (capability != null && !capability.isBlank()) {
                    normalized.add(capability.trim().toLowerCase(Locale.ROOT));
                }
            }
        }
        caps = Set.copyOf(normalized);
    }

    /**
     * Parses one {@code X-Jhin-Client} header value. Lenient: any unparsable
     * part yields its neutral value, never an exception. Called by the kernel
     * once per request to build {@link HttpRequest#client()}.
     *
     * @param header the raw header value, {@code null} allowed
     * @return the parsed client info; {@link #UNKNOWN} when the header is
     *         {@code null} or blank
     */
    public static ClientInfo parse(String header) {
        if (header == null || header.isBlank()) {
            return UNKNOWN;
        }
        int api = 0;
        String version = "";
        Set<String> caps = new LinkedHashSet<>();
        for (String part : header.split(";")) {
            int eq = part.indexOf('=');
            if (eq < 0) {
                continue;
            }
            String key = part.substring(0, eq).trim().toLowerCase(Locale.ROOT);
            String value = part.substring(eq + 1).trim();
            switch (key) {
                case "api" -> {
                    try {
                        api = Integer.parseInt(value);
                    } catch (NumberFormatException ignored) {
                        // unparsable part yields its neutral value
                    }
                }
                case "version" -> version = value;
                case "caps" -> {
                    for (String capability : value.split(",")) {
                        String name = capability.trim().toLowerCase(Locale.ROOT);
                        if (!name.isEmpty()) {
                            caps.add(name);
                        }
                    }
                }
                default -> {
                    // unknown keys are ignored
                }
            }
        }
        return new ClientInfo(api, version, caps);
    }

    /**
     * Tests whether the client declared a capability. Called by plugins before
     * emitting a node or directive that requires one; an absent capability
     * must be treated as unsupported.
     *
     * @param capability the capability name, matched case-insensitively
     * @return {@code true} when the client declared the capability
     */
    public boolean supports(String capability) {
        return capability != null
                && caps.contains(capability.trim().toLowerCase(Locale.ROOT));
    }
}
