package com.astroreen.jhin.sdk.json;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.astroreen.jhin.sdk.PluginException;
import com.fasterxml.jackson.core.JsonProcessingException;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Tests for {@link Json}: record and map round-trips, lenient reads of unknown
 * fields, and the failure path — malformed JSON must surface as a
 * {@link PluginException} wrapping the Jackson error.
 */
class JsonTest {

    /** A minimal record payload used by the round-trip tests. */
    record Point(int x, String name) {}

    // --- happy path: round-trips ---

    /**
     * A record round-trips through {@link Json#write(Object)} and both
     * {@code read} overloads — text and bytes — unchanged.
     */
    @Test
    void roundTripsRecord() {
        Point original = new Point(1, "origin");
        String text = Json.write(original);
        assertEquals(original, Json.read(text, Point.class));
        assertEquals(original, Json.read(text.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                Point.class));
    }

    /**
     * A map round-trips through {@link Json#write(Object)} and
     * {@link Json#readMap(String)} unchanged.
     */
    @Test
    void roundTripsMap() {
        Map<String, Object> original = Map.of("topic", "s1", "count", 3);
        String text = Json.write(original);
        assertEquals(original, Json.readMap(text));
    }

    // --- happy path: lenient configuration ---

    /**
     * Unknown properties are ignored: extra and nested-unknown fields parse
     * without throwing and the known components survive.
     */
    @Test
    void readIgnoresUnknownFields() {
        Point parsed = Json.read(
                "{\"x\":1,\"name\":\"origin\",\"extra\":true,\"nested\":{\"z\":9}}",
                Point.class);
        assertEquals(new Point(1, "origin"), parsed);
    }

    // --- failure path: errors wrapped in PluginException ---

    /**
     * Malformed JSON throws {@link PluginException} (mandated failure case):
     * {@code Json.read("{", Map.class)} must fail with the Jackson error
     * wrapped as the cause.
     */
    @Test
    void readMalformedJsonThrowsPluginException() {
        PluginException e = assertThrows(PluginException.class,
                () -> Json.read("{", Map.class));
        assertNotNull(e.getCause(), "Jackson error must be wrapped as the cause");
        assertInstanceOf(JsonProcessingException.class, e.getCause());
    }
}
