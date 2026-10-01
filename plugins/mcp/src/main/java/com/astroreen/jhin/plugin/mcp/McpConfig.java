package com.astroreen.jhin.plugin.mcp;

import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.json.Json;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The user-declared MCP server configuration parsed from
 * {@code $JHIN_HOME/mcp.json}.
 *
 * <p>Schema (v1-style): a JSON object whose {@code mcpServers} member maps a
 * server name to a server object; for convenience a root object without a
 * {@code mcpServers} member is read as that map directly:
 *
 * <pre>{@code
 * {
 *   "mcpServers": {
 *     "echo-server": {
 *       "command": "python3",
 *       "args": ["/opt/mcp/echo_server.py"],
 *       "env": {"LANG": "C"},
 *       "transport": "stdio"
 *     },
 *     "remote-tools": {
 *       "transport": "sse",
 *       "url": "http://localhost:8080/sse"
 *     }
 *   }
 * }
 * }</pre>
 *
 * <p>Server object fields (unknown fields are ignored):
 * <ul>
 *   <li>{@code command} - the program to spawn; required for transport
 *       {@code stdio}</li>
 *   <li>{@code args} - array of command arguments, optional</li>
 *   <li>{@code env} - object of extra environment variables for the spawned
 *       program, optional</li>
 *   <li>{@code transport} - {@code "stdio"} or {@code "sse"}; optional and
 *       inferred ({@code command} present -&gt; {@code stdio}, {@code url}
 *       present -&gt; {@code sse})</li>
 *   <li>{@code url} - the SSE endpoint URL; required for transport
 *       {@code sse}</li>
 * </ul>
 *
 * <p>Error contract: an absent file yields {@link Optional#empty()} and the
 * plugin treats it as a no-op. Structural problems (invalid JSON, wrong field
 * types, a stdio entry without {@code command}, an sse entry without
 * {@code url}, an unknown transport) fail the plugin's {@code start()} with a
 * {@link PluginException} naming the file, the server and the field. Runtime
 * connection failures are NOT this class's concern: {@link McpService} skips
 * just that server with an {@code ERROR} log and starts the others.
 */
public final class McpConfig {

    /** The default stdio transport: a spawned local program. */
    public static final String TRANSPORT_STDIO = "stdio";

    /** The SSE transport: a remote HTTP endpoint. */
    public static final String TRANSPORT_SSE = "sse";

    private final List<Server> servers;

    private McpConfig(List<Server> servers) {
        this.servers = List.copyOf(servers);
    }

    /**
     * The configured servers, in configuration order.
     *
     * @return the server specs, never {@code null}
     */
    public List<Server> servers() {
        return servers;
    }

    /**
     * Loads and parses the configuration file.
     *
     * @param file the path of {@code mcp.json}
     * @return the parsed configuration, empty when the file does not exist
     * @throws PluginException when the file exists but is malformed or an
     *                         entry has an invalid shape (see the class
     *                         documentation for the split between failing
     *                         here and runtime server skips)
     */
    public static Optional<McpConfig> load(Path file) {
        if (!Files.exists(file)) {
            return Optional.empty();
        }
        String text;
        try {
            text = Files.readString(file);
        } catch (IOException e) {
            throw new PluginException("mcp config at " + file + " can not be read", e);
        }
        Map<String, Object> root;
        try {
            root = Json.readMap(text);
        } catch (PluginException e) {
            throw new PluginException("mcp config at " + file + " is not valid JSON", e);
        }
        Map<String, Object> entries = serverEntries(file, root);
        List<Server> servers = new ArrayList<>();
        for (Map.Entry<String, Object> entry : entries.entrySet()) {
            servers.add(parseServer(file, entry.getKey(), entry.getValue()));
        }
        return Optional.of(new McpConfig(servers));
    }

    /**
     * Picks the name-to-server map: the {@code mcpServers} member when
     * present, otherwise the root object itself.
     *
     * @param file the config file (for failure messages)
     * @param root the parsed root object
     * @return the server entries
     * @throws PluginException when {@code mcpServers} is present but not an
     *                         object
     */
    private static Map<String, Object> serverEntries(Path file, Map<String, Object> root) {
        Object wrapped = root.get("mcpServers");
        if (wrapped == null) {
            return root;
        }
        if (!(wrapped instanceof Map)) {
            throw new PluginException("mcp config at " + file + ": 'mcpServers' must be an object");
        }
        return castMap(wrapped);
    }

    /**
     * Parses one server object into a {@link Server} spec.
     *
     * @param file the config file (for failure messages)
     * @param name the server name key
     * @param raw  the parsed server object
     * @return the server spec
     * @throws PluginException when the entry has an invalid shape
     */
    private static Server parseServer(Path file, String name, Object raw) {
        String where = "mcp config at " + file + ": server '" + name + "'";
        if (name.isBlank()) {
            throw new PluginException("mcp config at " + file + ": server name must not be blank");
        }
        if (!(raw instanceof Map)) {
            throw new PluginException(where + " must be an object");
        }
        Map<String, Object> spec = castMap(raw);
        String command = optionalString(where, spec, "command");
        String url = optionalString(where, spec, "url");
        String transport = optionalString(where, spec, "transport");
        if (transport == null) {
            transport = command != null ? TRANSPORT_STDIO : TRANSPORT_SSE;
        }
        if (!TRANSPORT_STDIO.equals(transport) && !TRANSPORT_SSE.equals(transport)) {
            throw new PluginException(where + ": unknown transport '" + transport
                    + "' (expected 'stdio' or 'sse')");
        }
        if (TRANSPORT_STDIO.equals(transport)) {
            if (command == null || command.isBlank()) {
                throw new PluginException(where + ": transport 'stdio' requires a non-blank 'command'");
            }
        } else if (url == null || url.isBlank()) {
            throw new PluginException(where + ": transport 'sse' requires a non-blank 'url'");
        }
        return new Server(name, command, stringList(where, spec, "args"),
                stringMap(where, spec, "env"), transport, url);
    }

    /**
     * Reads an optional string field.
     *
     * @param where the failure-message prefix
     * @param spec  the server object
     * @param field the field name
     * @return the value, {@code null} when absent
     * @throws PluginException when present but not a string
     */
    private static String optionalString(String where, Map<String, Object> spec, String field) {
        Object raw = spec.get(field);
        if (raw == null) {
            return null;
        }
        if (!(raw instanceof String)) {
            throw new PluginException(where + ": '" + field + "' must be a string");
        }
        return (String) raw;
    }

    /**
     * Reads the optional {@code args} field.
     *
     * @param where the failure-message prefix
     * @param spec  the server object
     * @param field the field name
     * @return the argument list, empty when absent
     * @throws PluginException when present but not a list of strings
     */
    private static List<String> stringList(String where, Map<String, Object> spec, String field) {
        Object raw = spec.get(field);
        if (raw == null) {
            return List.of();
        }
        if (!(raw instanceof List)) {
            throw new PluginException(where + ": '" + field + "' must be an array of strings");
        }
        List<String> values = new ArrayList<>();
        for (Object item : (List<?>) raw) {
            if (!(item instanceof String)) {
                throw new PluginException(where + ": '" + field + "' must be an array of strings");
            }
            values.add((String) item);
        }
        return List.copyOf(values);
    }

    /**
     * Reads the optional {@code env} field.
     *
     * @param where the failure-message prefix
     * @param spec  the server object
     * @param field the field name
     * @return the environment map, empty when absent
     * @throws PluginException when present but not an object of strings
     */
    private static Map<String, String> stringMap(String where, Map<String, Object> spec, String field) {
        Object raw = spec.get(field);
        if (raw == null) {
            return Map.of();
        }
        if (!(raw instanceof Map)) {
            throw new PluginException(where + ": '" + field + "' must be an object of strings");
        }
        Map<String, String> values = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : ((Map<?, ?>) raw).entrySet()) {
            if (!(entry.getKey() instanceof String) || !(entry.getValue() instanceof String)) {
                throw new PluginException(where + ": '" + field + "' must be an object of strings");
            }
            values.put((String) entry.getKey(), (String) entry.getValue());
        }
        return Map.copyOf(values);
    }

    /**
     * Narrows a parsed JSON object to a string-keyed map.
     *
     * @param raw the parsed object
     * @return the map
     */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object raw) {
        return (Map<String, Object>) raw;
    }

    /**
     * One configured MCP server.
     *
     * @param name      the server name; becomes part of the tool names
     * @param command   the program to spawn (transport {@code stdio}), else
     *                  {@code null}
     * @param args      the command arguments, never {@code null}
     * @param env       extra environment variables, never {@code null}
     * @param transport {@link #TRANSPORT_STDIO} or {@link #TRANSPORT_SSE}
     * @param url       the SSE endpoint (transport {@code sse}), else
     *                  {@code null}
     */
    public record Server(String name, String command, List<String> args, Map<String, String> env,
                         String transport, String url) {

        /**
         * Whether this server speaks the stdio transport (a spawned program).
         *
         * @return {@code true} for stdio servers
         */
        public boolean isStdio() {
            return TRANSPORT_STDIO.equals(transport);
        }
    }
}
