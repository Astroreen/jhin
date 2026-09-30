package com.astroreen.jhin.sdk.http;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Tests for {@link RouteSpec}: path normalization of valid templates and the
 * rejection of wildcard, traversal and multi-brace segments. Every rejection
 * case documents why its segment is a contract violation and asserts that the
 * message names the offending segment.
 */
class RouteSpecTest {

    private static final HttpHandler HANDLER = req -> HttpResponse.empty(204);

    // --- valid paths: normalization ---

    /**
     * A blank path normalizes to the root {@code /} (leading-slash rule on an
     * empty string).
     */
    @Test
    void blankPathNormalizesToRoot() {
        assertEquals("/", new RouteSpec("GET", "", HANDLER).path());
    }

    /**
     * The root path is already normalized and stays {@code /} — the only path
     * that keeps its trailing slash.
     */
    @Test
    void rootPathIsUnchanged() {
        assertEquals("/", new RouteSpec("GET", "/", HANDLER).path());
    }

    /**
     * A missing leading slash is added.
     */
    @Test
    void missingLeadingSlashIsAdded() {
        assertEquals("/sessions", new RouteSpec("GET", "sessions", HANDLER).path());
    }

    /**
     * A plain absolute path is already normalized and stays unchanged.
     */
    @Test
    void plainPathIsUnchanged() {
        assertEquals("/sessions", new RouteSpec("GET", "/sessions", HANDLER).path());
    }

    /**
     * A trailing slash is stripped.
     */
    @Test
    void trailingSlashIsStripped() {
        assertEquals("/sessions", new RouteSpec("GET", "/sessions/", HANDLER).path());
    }

    /**
     * The canonical template {@code /sessions/{id}/events} — one placeholder
     * in its own segment — is accepted unchanged; method and handler survive
     * construction untouched.
     */
    @Test
    void templatePathIsUnchanged() {
        RouteSpec spec = new RouteSpec("GET", "/sessions/{id}/events", HANDLER);
        assertEquals("/sessions/{id}/events", spec.path());
        assertEquals("GET", spec.method());
        assertSame(HANDLER, spec.handler());
    }

    /**
     * A template path keeps its placeholders while its trailing slash is
     * stripped.
     */
    @Test
    void templateTrailingSlashIsStripped() {
        assertEquals("/sessions/{id}/events",
                new RouteSpec("GET", "/sessions/{id}/events/", HANDLER).path());
    }

    /**
     * Several placeholder segments are fine as long as each segment holds at
     * most one placeholder.
     */
    @Test
    void twoPlaceholderSegmentsAreAccepted() {
        assertEquals("/a/{b}/c/{d}", new RouteSpec("GET", "/a/{b}/c/{d}", HANDLER).path());
    }

    // --- invalid paths: every case below names the offending segment ---

    /**
     * Rejection 1 (mandated failure case): {@code **} is a wildcard segment;
     * the message names it.
     */
    @Test
    void rejectsDoubleStarWildcardSegment() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> new RouteSpec("GET", "/a/**", HANDLER));
        assertTrue(e.getMessage().contains("'**'"), e.getMessage());
    }

    /**
     * Rejection 2: {@code *} is a wildcard segment; the message names it.
     */
    @Test
    void rejectsSingleStarWildcardSegment() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> new RouteSpec("GET", "/a/*", HANDLER));
        assertTrue(e.getMessage().contains("'*'"), e.getMessage());
    }

    /**
     * Rejection 3: a wildcard embedded in a segment ({@code b*}) is rejected
     * just like a whole-segment wildcard.
     */
    @Test
    void rejectsEmbeddedWildcardSegment() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> new RouteSpec("GET", "/a/b*", HANDLER));
        assertTrue(e.getMessage().contains("'b*'"), e.getMessage());
    }

    /**
     * Rejection 4: {@code ..} is a path traversal segment; the message names
     * it.
     */
    @Test
    void rejectsParentDirectorySegment() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> new RouteSpec("GET", "/a/../b", HANDLER));
        assertTrue(e.getMessage().contains("'..'"), e.getMessage());
    }

    /**
     * Rejection 5: two adjacent placeholders in one segment ({@code {x}{y}})
     * violate the one-placeholder-per-segment rule; the message names it.
     */
    @Test
    void rejectsAdjacentPlaceholderSegment() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> new RouteSpec("GET", "/a/{x}{y}", HANDLER));
        assertTrue(e.getMessage().contains("'{x}{y}'"), e.getMessage());
    }

    /**
     * Rejection 6: two placeholders mixed with literals in one segment
     * ({@code {a}-x{b}}) is the same violation; the message names it.
     */
    @Test
    void rejectsMixedMultiPlaceholderSegment() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
                () -> new RouteSpec("GET", "/pre/{a}-x{b}", HANDLER));
        assertTrue(e.getMessage().contains("'{a}-x{b}'"), e.getMessage());
    }
}
