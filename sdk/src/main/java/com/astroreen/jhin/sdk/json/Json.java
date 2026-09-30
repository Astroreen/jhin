/**
 * Shared JSON codec over one configured Jackson {@code ObjectMapper}.
 *
 * <p>Used by plugins and kernel contract types whenever JSON is produced or
 * parsed. The shared mapper is configured lenient on the way in (unknown
 * properties are ignored) and minimal on the way out (nulls are omitted, dates
 * are timestamps).
 */
package com.astroreen.jhin.sdk.json;

import com.astroreen.jhin.sdk.PluginException;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import java.io.IOException;
import java.util.Map;

public final class Json {

    private static final ObjectMapper MAPPER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
            .configure(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS, true)
            .setSerializationInclusion(JsonInclude.Include.NON_NULL);

    /** Not instantiable; all access is static. */
    private Json() {
    }

    /**
     * Serializes a value to JSON. Null components are omitted and dates are
     * written as timestamps. Called by plugins emitting JSON payloads.
     *
     * @param value the value to serialize
     * @return the JSON text
     * @throws PluginException when the value cannot be serialized
     */
    public static String write(Object value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (IOException e) {
            throw new PluginException("failed to serialize value to JSON", e);
        }
    }

    /**
     * Parses JSON text into a value of the given type. Unknown properties are
     * ignored. Called by plugins parsing JSON payloads.
     *
     * @param json the JSON text
     * @param type the target type
     * @param <T>  the target type
     * @return the parsed value
     * @throws PluginException when the text is not valid JSON for the type
     */
    public static <T> T read(String json, Class<T> type) {
        try {
            return MAPPER.readValue(json, type);
        } catch (IOException e) {
            throw new PluginException("failed to parse JSON text", e);
        }
    }

    /**
     * Parses JSON bytes into a value of the given type. Unknown properties are
     * ignored. Called by plugins parsing JSON payloads from the wire.
     *
     * @param json the JSON bytes
     * @param type the target type
     * @param <T>  the target type
     * @return the parsed value
     * @throws PluginException when the bytes are not valid JSON for the type
     */
    public static <T> T read(byte[] json, Class<T> type) {
        try {
            return MAPPER.readValue(json, type);
        } catch (IOException e) {
            throw new PluginException("failed to parse JSON bytes", e);
        }
    }

    /**
     * Parses a JSON object into a generic map. Called by plugins handling
     * loosely-typed JSON payloads.
     *
     * @param json the JSON text
     * @return the parsed object as a map
     * @throws PluginException when the text is not a valid JSON object
     */
    public static Map<String, Object> readMap(String json) {
        try {
            return MAPPER.readValue(json, new TypeReference<Map<String, Object>>() {});
        } catch (IOException e) {
            throw new PluginException("failed to parse JSON object", e);
        }
    }

    /**
     * The shared, configured mapper. Called by plugins that need direct
     * Jackson access on top of the standard configuration.
     *
     * @return the shared {@link ObjectMapper}
     */
    public static ObjectMapper mapper() {
        return MAPPER;
    }
}
