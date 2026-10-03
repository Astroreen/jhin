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
 * schema=<int>; caps=<comma-separated>} with the keys accepted in any order;
 * unknown keys are ignored. Capability names defined at api 1: {@code sse},
 * {@code tls_pinning}, {@code secure_storage}, {@code open_url},
 * {@code multi_profile}; the set only grows with frontend releases, names are
 * never removed.
 *
 * <p>Components: {@code api} — the wire contract level the client can parse,
 * defaulting to {@code 1} when absent or unparsable (an absent header behaves
 * as the original api-1 client); {@code version} — the client version string
 * (empty when unknown); {@code schema} — the client persisted-data schema
 * version, defaulting to {@code 1} when absent or unparsable;
 * {@code caps} — the declared capability names, lower-cased.
 */
package com.astroreen.jhin.sdk.http;

import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

public record ClientInfo(int api, String version, int schema, Set<String> caps) {

    /** The neutral instance used when the header is absent or malformed. */
    public static final ClientInfo UNKNOWN = new ClientInfo(1, "", 1, Set.of());

    /**
     * Creates a client info with the default persisted-data schema
     * ({@code 1}). Kept for callers that predate the {@code schema} header
     * field; new callers use the four-component constructor.
     *
     * @param api     the client API level
     * @param version the client version string
     * @param caps    the declared capability names
     */
    public ClientInfo(int api, String version, Set<String> caps) {
        this(api, version, 1, caps);
    }

    /**
     * Creates a client info, defensively normalizing its components: a
     * {@code null} version becomes empty and the capability set is copied as
     * an immutable, lower-cased, trimmed set. Called by {@link #parse(String)}
     * and by tests.
     *
     * @param api     the client API level
     * @param version the client version string
     * @param schema  the client persisted-data schema version
     * @param caps    the declared capability names
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
     * part yields its neutral value ({@code api} and {@code schema} fall back
     * to {@code 1}, {@code version} to empty, {@code caps} to empty), never an
     * exception. Called by the kernel once per request to build
     * {@link HttpRequest#client()}.
     *
     * @param header the raw header value, {@code null} allowed
     * @return the parsed client info; {@link #UNKNOWN} when the header is
     *         {@code null} or blank
     */
    public static ClientInfo parse(String header) {
        if (header == null || header.isBlank()) {
            return UNKNOWN;
        }
        int api = 1;
        String version = "";
        int schema = 1;
        Set<String> caps = new LinkedHashSet<>();
        for (String part : header.split(";")) {
            int eq = part.indexOf('=');
            if (eq < 0) {
                continue;
            }
            String key = part.substring(0, eq).trim().toLowerCase(Locale.ROOT);
            String value = part.substring(eq + 1).trim();
            switch (key) {
                case "api" -> api = parseLevel(value, api);
                case "version" -> version = value;
                case "schema" -> schema = parseLevel(value, schema);
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
        return new ClientInfo(api, version, schema, caps);
    }

    /**
     * Parses one contract/schema level, falling back to the current default
     * unless the value is a positive integer. Called by {@link #parse(String)}
     * for the {@code api} and {@code schema} fields.
     *
     * @param value      the raw field value
     * @param fallback   the default to keep when the value is unparsable
     * @return the parsed level, {@code >= 1}
     */
    private static int parseLevel(String value, int fallback) {
        try {
            int level = Integer.parseInt(value);
            return (level >= 1) ? level : fallback;
        } catch (NumberFormatException ignored) {
            return fallback;
        }
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
