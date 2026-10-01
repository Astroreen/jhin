/**
 * Shared helpers of the built-in file tools: argument extraction from the
 * {@link com.astroreen.jhin.plugin.agent.api.ToolCall} JSON text, output caps,
 * line handling and the one documented {@code structured} payload family.
 *
 * <p><b>Error contract.</b> Helpers throw {@link ToolException} with a stable,
 * model-readable message; every tool catches it and returns
 * {@code ToolResult.error(message)} - a tool never throws for argument,
 * sandbox or IO failures, so the failure surface is uniform and directly
 * assertable. Workspace escapes surface as
 * {@code "Path goes outside of workspace"} (from
 * {@link com.astroreen.jhin.plugin.agent.api.ToolContext#resolvePath}).
 *
 * <p><b>Output caps.</b> {@link #MAX_LINES} lines / {@link #MAX_BYTES} UTF-8
 * bytes (plus 1 byte per {@code \n} separator).
 *
 * <p><b>Numbered lines.</b> {@link #numbered} renders {@code N| text} with N
 * the absolute 1-based line number, right-aligned to width 4.
 *
 * <p><b>Line splitting.</b> {@link #splitLines} splits like
 * {@code Files.readAllLines}: {@code \n}, {@code \r\n}, {@code \r}; a trailing
 * newline does not create an empty last line.
 *
 * <p><b>Image detection.</b> {@link #detectImageMime} checks magic bytes (png
 * {@code 89 50 4E 47}, jpeg {@code FF D8 FF}, gif {@code GIF8}, webp
 * {@code RIFF....WEBP}) first, then the extension
 * (.png/.jpg/.jpeg/.gif/.webp). Not an image - {@code null}.
 *
 * <p><b>Literal replacements.</b> {@link #replaceFirstLiteral} splices the
 * first occurrence ({@code indexOf}), {@link #countOccurrences} counts
 * non-overlapping occurrences (the {@code String.replace} semantics).
 *
 * <h2>The structured payload family</h2>
 * Every {@code structured} payload is a JSON object discriminated by
 * {@code kind}; T36's stream route renders it generically:
 * <ul>
 *   <li>{@code {"kind":"card","title":<string>,"rows":[{"label":<string>,"value":<string>},...]}}
 *       - the default card every tool returns on success; {@code rows} may be
 *       empty.</li>
 *   <li>{@code {"kind":"image","title":<string>,"mimeType":<string>,"data":<base64>}}
 *       - {@code read} of an image file (never resized, base64 as-is).</li>
 * </ul>
 * Every payload carries {@code kind} and {@code title}; {@code card} payloads
 * carry {@code rows}, an array of {@code {label, value}} string pairs.
 * {@link Structured} is the single documented builder of this family.
 */
package com.astroreen.jhin.plugin.toolsbuiltin;

import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolException;
import com.astroreen.jhin.sdk.json.Json;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

final class FileToolSupport {

    static final int MAX_LINES = 2000;
    static final int MAX_BYTES = 51200;

    private FileToolSupport() {}

    /**
     * Parses the call arguments JSON object; {@code null}/blank arguments
     * yield an empty map.
     *
     * @throws ToolException when the arguments are not a JSON object
     */
    static Map<String, Object> args(ToolCall call) {
        String text = call.arguments();
        if (text == null || text.isBlank()) {
            return new LinkedHashMap<>();
        }
        try {
            return Json.readMap(text);
        } catch (RuntimeException e) {
            throw new ToolException("arguments must be a JSON object");
        }
    }

    /** @throws ToolException when the argument is missing, blank or not a string */
    static String requireString(Map<String, Object> args, String name) {
        Object raw = args.get(name);
        if (!(raw instanceof String value) || value.isBlank()) {
            throw new ToolException(name + " must not be blank");
        }
        return value;
    }

    static String optionalString(Map<String, Object> args, String name, String defaultValue) {
        Object raw = args.get(name);
        if (raw == null) {
            return defaultValue;
        }
        if (!(raw instanceof String value)) {
            throw new ToolException(name + " must be a string");
        }
        return value;
    }

    /** @throws ToolException when the argument is neither null nor a positive number */
    static int positiveInt(Object raw, int defaultValue, String name) {
        if (raw == null) {
            return defaultValue;
        }
        if (!(raw instanceof Number number)) {
            throw new ToolException(name + " must be a number");
        }
        long value = number.longValue();
        if (value < 1) {
            throw new ToolException(name + " must be a positive integer");
        }
        return (int) Math.min(value, Integer.MAX_VALUE);
    }

    /** @throws ToolException when the argument is neither null nor a non-negative number */
    static int nonNegativeInt(Object raw, int defaultValue, String name) {
        if (raw == null) {
            return defaultValue;
        }
        if (!(raw instanceof Number number)) {
            throw new ToolException(name + " must be a number");
        }
        long value = number.longValue();
        if (value < 0) {
            throw new ToolException(name + " must not be negative");
        }
        return (int) Math.min(value, Integer.MAX_VALUE);
    }

    /** @throws ToolException when the argument is neither null nor a boolean */
    static boolean boolArg(Object raw, boolean defaultValue, String name) {
        if (raw == null) {
            return defaultValue;
        }
        if (!(raw instanceof Boolean value)) {
            throw new ToolException(name + " must be a boolean");
        }
        return value;
    }

    static String numbered(int lineNo, String line) {
        return String.format(Locale.ROOT, "%4d| %s", lineNo, line);
    }

    static List<String> splitLines(String text) {
        List<String> lines = new ArrayList<>();
        int n = text.length();
        int start = 0;
        for (int i = 0; i < n; i++) {
            char c = text.charAt(i);
            if (c == '\n') {
                lines.add(text.substring(start, i));
                start = i + 1;
            } else if (c == '\r') {
                int end = i;
                if (i + 1 < n && text.charAt(i + 1) == '\n') {
                    i++;
                }
                lines.add(text.substring(start, end));
                start = i + 1;
            }
        }
        if (start < n) {
            lines.add(text.substring(start));
        }
        return lines;
    }

    static String detectImageMime(Path file, byte[] bytes) {
        if (bytes != null) {
            if (bytes.length >= 4
                    && (bytes[0] & 0xFF) == 0x89
                    && bytes[1] == 0x50
                    && bytes[2] == 0x4E
                    && bytes[3] == 0x47) {
                return "image/png";
            }
            if (bytes.length >= 3
                    && (bytes[0] & 0xFF) == 0xFF
                    && (bytes[1] & 0xFF) == 0xD8
                    && (bytes[2] & 0xFF) == 0xFF) {
                return "image/jpeg";
            }
            if (bytes.length >= 4
                    && bytes[0] == 'G'
                    && bytes[1] == 'I'
                    && bytes[2] == 'F'
                    && bytes[3] == '8') {
                return "image/gif";
            }
            if (bytes.length >= 12
                    && bytes[0] == 'R'
                    && bytes[1] == 'I'
                    && bytes[2] == 'F'
                    && bytes[3] == 'F'
                    && bytes[8] == 'W'
                    && bytes[9] == 'E'
                    && bytes[10] == 'B'
                    && bytes[11] == 'P') {
                return "image/webp";
            }
        }
        String name =
                file.getFileName() == null ? "" : file.getFileName().toString().toLowerCase(Locale.ROOT);
        if (name.endsWith(".png")) {
            return "image/png";
        }
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (name.endsWith(".gif")) {
            return "image/gif";
        }
        if (name.endsWith(".webp")) {
            return "image/webp";
        }
        return null;
    }

    static String replaceFirstLiteral(String content, String oldString, String newString) {
        int i = content.indexOf(oldString);
        return content.substring(0, i) + newString + content.substring(i + oldString.length());
    }

    static int countOccurrences(String content, String needle) {
        int count = 0;
        int idx = 0;
        while ((idx = content.indexOf(needle, idx)) >= 0) {
            count++;
            idx += needle.length();
        }
        return count;
    }

    static String message(Exception e) {
        return e.getMessage() != null ? e.getMessage() : e.toString();
    }

    /**
     * One property of a {@code parametersSchema()} object.
     *
     * @param type        the JSON-Schema type, for example {@code string}
     * @param description the one-line description for the model
     * @return the property map
     */
    static Map<String, Object> property(String type, String description) {
        Map<String, Object> property = new LinkedHashMap<>();
        property.put("type", type);
        property.put("description", description);
        return property;
    }

    /**
     * The {@code parametersSchema()} JSON text: an object schema over the
     * given named properties.
     *
     * @param properties the named {@link #property} entries, in documentation order
     * @param required   the names the model must supply, may be empty
     * @return the JSON Schema text
     */
    static String schema(Map<String, Object> properties, List<String> required) {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        schema.put("properties", properties);
        if (!required.isEmpty()) {
            schema.put("required", required);
        }
        return Json.write(schema);
    }

    /**
     * The single builder of the documented {@code structured} payload family
     * (see the class Javadoc): {@code card} and {@code image} JSON objects.
     */
    static final class Structured {

        private Structured() {}

        /**
         * One {@code {label, value}} row of a {@code card} payload.
         *
         * @param label the row label, never {@code null}
         * @param value the row value, never {@code null}
         * @return the row map
         */
        static Map<String, String> row(String label, String value) {
            Map<String, String> row = new LinkedHashMap<>();
            row.put("label", label);
            row.put("value", value);
            return row;
        }

        /**
         * The {@code card} payload as JSON text.
         *
         * @param title the card title, never {@code null}
         * @param rows  the {@link #row} entries, never {@code null}
         * @return the JSON text of the payload
         */
        static String card(String title, List<Map<String, String>> rows) {
            Map<String, Object> card = new LinkedHashMap<>();
            card.put("kind", "card");
            card.put("title", title);
            card.put("rows", rows);
            return Json.write(card);
        }

        /**
         * The {@code image} payload as JSON text (base64 as-is, never resized).
         *
         * @param title    the image title, never {@code null}
         * @param mimeType the mime type, one of png/jpeg/gif/webp
         * @param base64   the base64-encoded image bytes
         * @return the JSON text of the payload
         */
        static String image(String title, String mimeType, String base64) {
            Map<String, Object> image = new LinkedHashMap<>();
            image.put("kind", "image");
            image.put("title", title);
            image.put("mimeType", mimeType);
            image.put("data", base64);
            return Json.write(image);
        }

        /**
         * Encodes image bytes as base64 for the {@link #image} payload.
         *
         * @param bytes the image bytes
         * @return the base64 text
         */
        static String base64(byte[] bytes) {
            return Base64.getEncoder().encodeToString(bytes);
        }
    }
}
