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
 * {@link ClientInfo#UNKNOWN} without throwing. The {@code api} and
 * {@code schema} levels default to {@code 1} when absent or unparsable.
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

    // --- schema negotiation (contract level 2) ---

    /**
     * A full level-2 header parses all four fields: {@code api}, {@code
     * version}, {@code schema} and {@code caps}.
     */
    @Test
    void parsesFullLevel2Header() {
        ClientInfo info = ClientInfo.parse("api=2; version=1.4.0; schema=3; caps=sse,stream");
        assertEquals(2, info.api());
        assertEquals("1.4.0", info.version());
        assertEquals(3, info.schema());
        assertEquals(Set.of("sse", "stream"), info.caps());
    }

    /**
     * A partial header carries only the fields the client knows; the missing
     * ones keep their defaults ({@code api} stays as given, {@code schema}
     * defaults to 1, {@code version} empty, no caps).
     */
    @Test
    void partialHeaderKeepsDefaults() {
        ClientInfo info = ClientInfo.parse("api=2");
        assertEquals(2, info.api());
        assertEquals("", info.version());
        assertEquals(1, info.schema());
        assertTrue(info.caps().isEmpty());
    }

    /**
     * An absent {@code schema} behaves as schema 1 even when other fields are
     * present.
     */
    @Test
    void absentSchemaDefaultsToOne() {
        ClientInfo info = ClientInfo.parse("api=2; version=2.0.0; caps=sse");
        assertEquals(1, info.schema());
    }

    /**
     * Garbage level values ({@code api=abc}, {@code schema=xyz}) and
     * non-positive levels fall back to the default 1 without throwing.
     */
    @Test
    void garbageAndNonPositiveLevelsFallBackToOne() {
        ClientInfo garbage = ClientInfo.parse("api=abc; schema=xyz");
        assertEquals(1, garbage.api());
        assertEquals(1, garbage.schema());

        ClientInfo negative = ClientInfo.parse("api=-5; schema=-5");
        assertEquals(1, negative.api());
        assertEquals(1, negative.schema());

        ClientInfo zero = ClientInfo.parse("api=0; schema=0");
        assertEquals(1, zero.api());
        assertEquals(1, zero.schema());
    }

    /**
     * Malformed separators are tolerated: doubled {@code ;;} and a trailing
     * {@code ;} produce empty segments that are skipped, never an exception.
     */
    @Test
    void toleratesMalformedSeparators() {
        ClientInfo doubled = ClientInfo.parse("api=2;;version=1.4.0;;schema=3;;caps=sse");
        assertEquals(2, doubled.api());
        assertEquals("1.4.0", doubled.version());
        assertEquals(3, doubled.schema());
        assertEquals(Set.of("sse"), doubled.caps());

        ClientInfo trailing = ClientInfo.parse("api=2; schema=3;");
        assertEquals(2, trailing.api());
        assertEquals(3, trailing.schema());
    }

    /**
     * Unknown keys next to known ones are ignored, and an unknown key with no
     * value at all is skipped too.
     */
    @Test
    void unknownKeysIgnoredNextToSchema() {
        ClientInfo info = ClientInfo.parse("api=2; foo=bar; schema=3; platform=android; caps=");
        assertEquals(2, info.api());
        assertEquals(3, info.schema());
        assertTrue(info.caps().isEmpty());
    }

    /**
     * The three-argument constructor (kept for callers that predate the
     * {@code schema} field) defaults the schema to 1.
     */
    @Test
    void legacyConstructorDefaultsSchemaToOne() {
        ClientInfo info = new ClientInfo(2, "1.0.0", Set.of("sse"));
        assertEquals(2, info.api());
        assertEquals(1, info.schema());
        assertEquals(Set.of("sse"), info.caps());
    }
}
