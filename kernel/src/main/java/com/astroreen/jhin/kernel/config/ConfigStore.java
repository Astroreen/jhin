/**
 * The on-disk configuration file of the installation, {@code config.json} in
 * the home root.
 *
 * <p>Parsed eagerly into a two-level map: every top-level key names a section
 * (the id of the extension owning it) and holds an object whose nested keys are
 * flattened with {@code '.'} and whose non-string scalars are stringified. A
 * missing file means empty configuration; a malformed file is fatal and
 * reports the parse position (line and column).
 */
package com.astroreen.jhin.kernel.config;

import com.astroreen.jhin.sdk.json.Json;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

public final class ConfigStore {

    private final Map<String, Map<String, String>> sections;

    private ConfigStore(Map<String, Map<String, String>> sections) {
        this.sections = sections;
    }

    /**
     * Loads {@code config.json} from the given home root. A missing file
     * yields empty content; a malformed file raises {@link ConfigException}.
     *
     * @param home the home root directory
     * @return the parsed configuration
     * @throws ConfigException when the file cannot be read or is malformed
     */
    public static ConfigStore load(Path home) {
        Path file = home.resolve("config.json");
        if (!Files.isRegularFile(file)) {
            return new ConfigStore(Map.of());
        }
        String text;
        try {
            text = Files.readString(file);
        } catch (IOException e) {
            throw new ConfigException("cannot read " + file, e);
        }
        return new ConfigStore(parse(file, text));
    }

    /**
     * Returns every section keyed by its id. The returned maps are immutable.
     *
     * @return the sections of the configuration
     */
    public Map<String, Map<String, String>> sections() {
        return sections;
    }

    /**
     * Returns one section by id, or an empty map when the section is absent.
     *
     * @param id the section id
     * @return the flattened key/value pairs of the section
     */
    public Map<String, String> section(String id) {
        return sections.getOrDefault(id, Map.of());
    }

    private static Map<String, Map<String, String>> parse(Path file, String text) {
        if (text.isBlank()) {
            return Map.of();
        }
        JsonNode root;
        try {
            root = Json.mapper().readTree(text);
        } catch (JsonProcessingException e) {
            var location = e.getLocation();
            int line = location == null ? -1 : location.getLineNr();
            int column = location == null ? -1 : location.getColumnNr();
            throw new ConfigException(
                    "malformed " + file.getFileName() + " at line " + line + ", column " + column, e);
        }
        if (root == null || !root.isObject()) {
            throw new ConfigException("top level of " + file.getFileName() + " must be an object");
        }
        Map<String, Map<String, String>> out = new LinkedHashMap<>();
        for (var entry : root.properties()) {
            if (!entry.getValue().isObject()) {
                throw new ConfigException("section \"" + entry.getKey() + "\" must be an object");
            }
            Map<String, String> values = new LinkedHashMap<>();
            flatten("", entry.getValue(), values);
            out.put(entry.getKey(), Collections.unmodifiableMap(values));
        }
        return Collections.unmodifiableMap(out);
    }

    private static void flatten(String prefix, JsonNode node, Map<String, String> out) {
        if (node.isObject()) {
            for (var entry : node.properties()) {
                String key = prefix.isEmpty() ? entry.getKey() : prefix + "." + entry.getKey();
                flatten(key, entry.getValue(), out);
            }
        } else if (node.isValueNode()) {
            out.put(prefix, node.asText());
        } else {
            out.put(prefix, node.toString());
        }
    }
}
