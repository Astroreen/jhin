package com.astroreen.jhin.core.mcp;

import com.astroreen.jhin.core.tools.ToolRegistry;
import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.internal.JsonSchemaElementJsonUtils;
import dev.langchain4j.mcp.client.DefaultMcpClient;
import dev.langchain4j.mcp.client.McpClient;
import dev.langchain4j.mcp.client.transport.McpTransport;
import dev.langchain4j.mcp.client.transport.http.StreamableHttpMcpTransport;
import dev.langchain4j.mcp.client.transport.stdio.StdioMcpTransport;
import dev.langchain4j.service.tool.ToolExecutionResult;
import jakarta.annotation.PreDestroy;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Map.Entry;
import java.util.concurrent.CopyOnWriteArrayList;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/**
 * MCP-клиент: загружает {@code ${jhin.home}/mcp.json}, подключается к серверам
 * (stdio / HTTP), регистрирует их тулы в {@link ToolRegistry} под именами
 * {@code mcp_{serverName}_{toolName}}.
 *
 * <p>Санитизация имени: символы вне {@code [a-zA-Z0-9_-]} заменяются на {@code _}.
 *
 * <p>Пер-серверная изоляция ошибок: connect/timeout/protocol error → ERROR log + skip,
 * остальные серверы продолжают загружаться. Общий load никогда не роняет startup.
 *
 * <p>Использует langchain4j-mcp ({@code DefaultMcpClient} + {@code StdioMcpTransport} /
 * {@code StreamableHttpMcpTransport}). Stdio framing — newline-delimited JSON-RPC 2.0.
 */
@Component
public class McpService implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(McpService.class);
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final ToolRegistry toolRegistry;
    private final Path jhinHome;
    private final List<McpClient> clients = new CopyOnWriteArrayList<>();

    public McpService(ToolRegistry toolRegistry, @Value("${jhin.home}") String jhinHome) {
        this.toolRegistry = toolRegistry;
        this.jhinHome = Path.of(jhinHome);
    }

    @Override
    public void run(ApplicationArguments args) {
        loadAndRegister();
    }

    /** Загружает mcp.json и регистрирует тулы. Безопасен: не бросает исключений наружу. */
    void loadAndRegister() {
        McpConfig config = McpConfig.load(jhinHome);
        if (config.servers().isEmpty()) {
            return;
        }
        List<Entry<String, McpServerConfig>> entries = new ArrayList<>(config.servers().entrySet());
        entries.sort(Entry.comparingByKey());
        for (Entry<String, McpServerConfig> entry : entries) {
            String serverName = entry.getKey();
            try {
                connectAndRegister(serverName, entry.getValue());
            } catch (Exception e) {
                log.error(
                        "MCP server \"{}\" failed: {} — skipped",
                        serverName,
                        e.getMessage(),
                        e);
            }
        }
    }

    private void connectAndRegister(String serverName, McpServerConfig serverConfig) {
        McpTransport transport = buildTransport(serverName, serverConfig);
        McpClient client =
                DefaultMcpClient.builder()
                        .transport(transport)
                        .key(serverName)
                        .clientName("jhin")
                        .clientVersion("0.1.0")
                        .build();
        clients.add(client);

        List<ToolSpecification> specs = client.listTools();
        List<ToolDefinition> tools = new ArrayList<>();
        for (ToolSpecification spec : specs) {
            tools.add(new McpToolAdapter(serverName, spec, client));
        }
        if (tools.isEmpty()) {
            log.info("MCP server \"{}\" exposes zero tools", serverName);
            return;
        }
        toolRegistry.register(() -> tools);
        log.info("MCP server \"{}\": registered {} tools", serverName, tools.size());
    }

    private static McpTransport buildTransport(String serverName, McpServerConfig config) {
        if (config.isStdio()) {
            List<String> command = new ArrayList<>();
            command.add(config.command());
            command.addAll(config.args());
            return StdioMcpTransport.builder()
                    .command(command)
                    .environment(config.env())
                    .build();
        }
        if (config.isHttp()) {
            return StreamableHttpMcpTransport.builder()
                    .url(config.url())
                    .customHeaders(config.headers())
                    .build();
        }
        throw new IllegalArgumentException("neither stdio nor http config for " + serverName);
    }

    /** Закрывает все соединения и перезагружает mcp.json. */
    public void reload() {
        closeAll();
        loadAndRegister();
    }

    @PreDestroy
    void close() {
        closeAll();
    }

    private void closeAll() {
        for (McpClient client : clients) {
            try {
                client.close();
            } catch (Exception e) {
                log.warn("Cannot close MCP client: {}", e.getMessage());
            }
        }
        clients.clear();
    }

    /** Адаптер: MCP {@link ToolSpecification} → Jhin {@link ToolDefinition}. */
    private static final class McpToolAdapter implements ToolDefinition {

        private final String serverName;
        private final String originalToolName;
        private final String name;
        private final String description;
        private final Map<String, Object> parametersSchema;
        private final McpClient client;

        McpToolAdapter(String serverName, ToolSpecification spec, McpClient client) {
            this.serverName = serverName;
            this.originalToolName = spec.name();
            this.name = "mcp_" + sanitize(serverName) + "_" + sanitize(spec.name());
            this.description = spec.description() != null ? spec.description() : "";
            this.parametersSchema =
                    spec.parameters() != null
                            ? JsonSchemaElementJsonUtils.toMap(spec.parameters())
                            : Map.of();
            this.client = client;
        }

        @Override
        public String name() {
            return name;
        }

        @Override
        public String label() {
            return originalToolName;
        }

        @Override
        public String description() {
            return description;
        }

        @Override
        public Map<String, Object> parametersSchema() {
            return parametersSchema;
        }

        @Override
        public String promptSnippet() {
            return "MCP tool from server " + serverName;
        }

        @Override
        public List<String> promptGuidelines() {
            return List.of("Powered by MCP server " + serverName);
        }

        @Override
        public ToolResult execute(ToolCall call, ToolContext ctx) {
            try {
                String argsJson = MAPPER.writeValueAsString(call.arguments());
                ToolExecutionRequest request =
                        ToolExecutionRequest.builder()
                                .name(originalToolName)
                                .arguments(argsJson)
                                .build();
                ToolExecutionResult result = client.executeTool(request);
                String text = result.resultText() != null ? result.resultText() : "";
                return result.isError() ? ToolResult.error(text) : ToolResult.ok(text);
            } catch (Exception e) {
                return ToolResult.error("MCP tool call failed: " + e.getMessage());
            }
        }

        /** Non {@code [a-zA-Z0-9_-]} chars → {@code _}. */
        static String sanitize(String s) {
            return s.replaceAll("[^a-zA-Z0-9_-]", "_");
        }
    }
}