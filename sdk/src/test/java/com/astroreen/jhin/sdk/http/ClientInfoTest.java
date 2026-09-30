package com.astroreen.jhin.sdk.http;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Tests for {@link ClientInfo}: a full {@code X-Jhin-Client} header parses to
 * its exact components, key order and unknown keys do not matter, capability
 * names are normalized — and every degenerate input returns
 * {@link ClientInfo#UNKNOWN} without throwing.
 */
class ClientInfoTest {

    // --- happy path ---

    /**
     * A full header parses to {@code api=1}, the version string and the exact
     * capability set.
     */
    @Test
    void parsesFullHeader() {
        ClientInfo info = ClientInfo.parse("api=1; version=1.4.2; caps=sse,tls_pinning,multi_profile");
        assertEquals(1, info.api());
        assertEquals("1.4.2", info.version());
        assertEquals(Set.of("sse", "tls_pinning", "multi_profile"), info.caps());
    }

    /**
     * The keys {@code api}, {@code version} and {@code caps} are accepted in
     * any order.
     */
    @Test
    void keyOrderIsIrrelevant() {
        ClientInfo info = ClientInfo.parse("caps=sse; api=1; version=1.4.2");
        assertEquals(1, info.api());
        assertEquals("1.4.2", info.version());
        assertEquals(Set.of("sse"), info.caps());
    }

    /**
     * Unknown keys (with or without a value) are ignored, not errors.
     */
    @Test
    void unknownKeysAreIgnored() {
        ClientInfo info = ClientInfo.parse("api=1; vendor=acme; version=2.0.0; caps=sse; extra");
        assertEquals(1, info.api());
        assertEquals("2.0.0", info.version());
        assertEquals(Set.of("sse"), info.caps());
    }

    /**
     * Whitespace around keys, values and capability names is trimmed, and
     * capability names are lower-cased.
     */
    @Test
    void trimsWhitespaceAndLowerCasesCapabilities() {
        ClientInfo info = ClientInfo.parse(" api=1 ; version=1.0.0 ; caps=SSE , TLS_PINNING ");
        assertEquals(1, info.api());
        assertEquals("1.0.0", info.version());
        assertEquals(Set.of("sse", "tls_pinning"), info.caps());
    }

    /**
     * {@link ClientInfo#supports(String)} reports exactly the declared
     * capabilities, matched case-insensitively.
     */
    @Test
    void supportsChecksDeclaredCapabilities() {
        ClientInfo info = ClientInfo.parse("api=1; caps=sse,open_url");
        assertTrue(info.supports("sse"));
        assertTrue(info.supports("open_url"));
        assertTrue(info.supports("SSE"));
        assertFalse(info.supports("multi_profile"));
    }

    // --- failure path: never throws, always UNKNOWN ---

    /**
     * {@code null} and blank headers yield {@link ClientInfo#UNKNOWN}.
     */
    @Test
    void returnsUnknownForNullAndBlank() {
        assertEquals(ClientInfo.UNKNOWN, ClientInfo.parse(null));
        assertEquals(ClientInfo.UNKNOWN, ClientInfo.parse(""));
        assertEquals(ClientInfo.UNKNOWN, ClientInfo.parse("   "));
    }

    /**
     * A value with no {@code key=value} parts at all is unparsable and yields
     * {@link ClientInfo#UNKNOWN} without an exception.
     */
    @Test
    void returnsUnknownForGarbage() {
        assertEquals(ClientInfo.UNKNOWN, ClientInfo.parse("garbage"));
    }

    /**
     * Unparsable {@code api} and an empty {@code caps} list each fall back to
     * their neutral value, so the result equals {@link ClientInfo#UNKNOWN} —
     * still without an exception.
     */
    @Test
    void returnsUnknownForUnparsableApiAndEmptyCaps() {
        assertEquals(ClientInfo.UNKNOWN, ClientInfo.parse("api=NaN; caps="));
    }
}
