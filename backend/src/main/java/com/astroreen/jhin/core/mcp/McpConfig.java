package com.astroreen.jhin.core.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Map.Entry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Конфигурация MCP-серверов из {@code ${jhin.home}/mcp.json} (UTF-8).
 *
 * <p>Формат — Claude-Desktop-style:
 * <pre>{@code
 * {
 *   "mcpServers": {
 *     "myserver": {
 *       "command": "bash",
 *       "args": ["/path/to/server.sh"],
 *       "env": {"FOO": "bar"}
 *     },
 *     "myhttp": {
 *       "url": "https://example.com/mcp",
 *       "headers": {"Authorization": "Bearer x"}
 *     }
 *   }
 * }
 * }</pre>
 *
 * <p>{@code command}+{@code args} → stdio transport (spawn process).
 * {@code url} → HTTP transport. Неизвестный/битый entry → warn + skip.
 * Отсутствующий файл → ноль MCP-тулов, INFO log, без ошибки (startup не падает).
 *
 * <p>Парсер — ручной {@link ObjectMapper} (в Spring Boot 4.1.1 нет готового bean'а
 * для {@code ObjectMapper} в этом контексте; используем plain instance).
 */
public record McpConfig(Map<String, McpServerConfig> servers) {

    private static final Logger log = LoggerFactory.getLogger(McpConfig.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    public McpConfig {
        servers =
                servers == null
                        ? Map.of()
                        : Collections.unmodifiableMap(new LinkedHashMap<>(servers));
    }

    public static McpConfig empty() {
        return new McpConfig(Map.of());
    }

    /**
     * Читает {@code jhinHome/mcp.json}. Отсутствующий файл → empty (INFO).
     * Битый JSON / IO-ошибка → warn + empty.
     */
    public static McpConfig load(Path jhinHome) {
        Path file = jhinHome.resolve("mcp.json");
        if (Files.notExists(file)) {
            log.info("No mcp.json at {} — zero MCP tools", file);
            return empty();
        }
        try {
            String json = Files.readString(file);
            return parse(json);
        } catch (IOException e) {
            log.warn("Cannot read {}: {} — zero MCP tools", file, e.getMessage());
            return empty();
        }
    }

    static McpConfig parse(String json) {
        try {
            JsonNode root = MAPPER.readTree(json);
            JsonNode serversNode = root.get("mcpServers");
            if (serversNode == null || !serversNode.isObject()) {
                log.warn("mcp.json: missing or invalid \"mcpServers\" object — zero MCP tools");
                return empty();
            }
            Map<String, McpServerConfig> result = new LinkedHashMap<>();
            for (Entry<String, JsonNode> entry : serversNode.properties()) {
                McpServerConfig config = parseServer(entry.getKey(), entry.getValue());
                if (config != null) {
                    result.put(entry.getKey(), config);
                }
            }
            return new McpConfig(result);
        } catch (Exception e) {
            log.warn("mcp.json: malformed JSON: {} — zero MCP tools", e.getMessage());
            return empty();
        }
    }

    private static McpServerConfig parseServer(String name, JsonNode node) {
        if (node == null || !node.isObject()) {
            log.warn("mcp.json: entry \"{}\" is not an object — skipped", name);
            return null;
        }
        String command = textOrNull(node, "command");
        List<String> args = stringList(node, "args");
        Map<String, String> env = stringMap(node, "env");
        String url = textOrNull(node, "url");
        Map<String, String> headers = stringMap(node, "headers");

        boolean hasCommand = command != null && !command.isBlank();
        boolean hasUrl = url != null && !url.isBlank();
        if (!hasCommand && !hasUrl) {
            log.warn("mcp.json: entry \"{}\" has neither \"command\" nor \"url\" — skipped", name);
            return null;
        }
        return new McpServerConfig(name, command, args, env, url, headers);
    }

    private static String textOrNull(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return v != null && v.isTextual() ? v.asText() : null;
    }

    private static List<String> stringList(JsonNode node, String field) {
        JsonNode v = node.get(field);
        if (v == null || !v.isArray()) {
            return List.of();
        }
        List<String> result = new ArrayList<>();
        for (JsonNode item : v) {
            if (item.isTextual()) {
                result.add(item.asText());
            }
        }
        return List.copyOf(result);
    }

    private static Map<String, String> stringMap(JsonNode node, String field) {
        JsonNode v = node.get(field);
        if (v == null || !v.isObject()) {
            return Map.of();
        }
        Map<String, String> result = new LinkedHashMap<>();
        for (Entry<String, JsonNode> entry : v.properties()) {
            if (entry.getValue().isTextual()) {
                result.put(entry.getKey(), entry.getValue().asText());
            }
        }
        return Collections.unmodifiableMap(result);
    }
}

/**
 * Конфигурация одного MCP-сервера.
 *
 * @param name    ключ из {@code mcpServers}
 * @param command команда для stdio transport (nullable)
 * @param args    аргументы команды (null → empty)
 * @param env     переменные окружения (null → empty)
 * @param url     URL для HTTP transport (nullable)
 * @param headers HTTP-заголовки (null → empty)
 */
record McpServerConfig(
        String name,
        String command,
        List<String> args,
        Map<String, String> env,
        String url,
        Map<String, String> headers) {

    McpServerConfig {
        args = args == null ? List.of() : List.copyOf(args);
        env = env == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(env));
        headers =
                headers == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(headers));
    }

    boolean isStdio() {
        return command != null && !command.isBlank();
    }

    boolean isHttp() {
        return url != null && !url.isBlank();
    }
}