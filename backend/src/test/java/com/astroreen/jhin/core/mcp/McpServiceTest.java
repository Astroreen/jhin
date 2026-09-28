package com.astroreen.jhin.core.mcp;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.core.tools.ToolRegistry;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class McpServiceTest {

    @TempDir
    Path jhinHome;

    @Test
    void missingFileYieldsZeroMcpTools() {
        ToolRegistry registry = new ToolRegistry(List.of(), List.of(), List.of());
        McpService service = new McpService(registry, jhinHome.toString());

        service.loadAndRegister();

        assertThat(registry.all()).noneMatch(t -> t.name().startsWith("mcp_"));
    }

    @Test
    void stdioEchoServerRegistersAndExecutes() throws Exception {
        Path script = jhinHome.resolve("echo-server.sh");
        try (InputStream in = getClass().getResourceAsStream("/mcp/echo-server.sh")) {
            assertThat(in).isNotNull();
            Files.copy(in, script);
        }
        Files.writeString(
                jhinHome.resolve("mcp.json"),
                """
                {
                  "mcpServers": {
                    "echo_server": {
                      "command": "bash",
                      "args": ["%s"]
                    }
                  }
                }
                """
                        .formatted(script.toAbsolutePath()));

        ToolRegistry registry = new ToolRegistry(List.of(), List.of(), List.of());
        McpService service = new McpService(registry, jhinHome.toString());

        service.loadAndRegister();

        assertThat(registry.find("mcp_echo_server_echo")).isPresent();

        ToolContext ctx = new ToolContext(jhinHome, "s1", "r1", "a1");
        ToolResult result = registry.execute("mcp_echo_server_echo", Map.of("message", "hi"), ctx);

        assertThat(result.error()).isFalse();
        assertThat(result.content()).contains("hi");

        service.close();
    }

    @Test
    void malformedJsonYieldsZeroMcpTools() throws Exception {
        Files.writeString(jhinHome.resolve("mcp.json"), "{not valid json");

        ToolRegistry registry = new ToolRegistry(List.of(), List.of(), List.of());
        McpService service = new McpService(registry, jhinHome.toString());

        service.loadAndRegister();

        assertThat(registry.all()).noneMatch(t -> t.name().startsWith("mcp_"));
    }

    @Test
    void badServerEntryIsSkipped() throws Exception {
        Files.writeString(
                jhinHome.resolve("mcp.json"),
                """
                {
                  "mcpServers": {
                    "bad": {
                      "command": "/nonexistent",
                      "args": []
                    }
                  }
                }
                """);

        ToolRegistry registry = new ToolRegistry(List.of(), List.of(), List.of());
        McpService service = new McpService(registry, jhinHome.toString());

        service.loadAndRegister();

        assertThat(registry.all()).noneMatch(t -> t.name().startsWith("mcp_"));
    }

    @Test
    void configParseExtractsStdioAndHttpEntries() {
        McpConfig config =
                McpConfig.parse(
                        """
                        {
                          "mcpServers": {
                            "a_stdio": {
                              "command": "bash",
                              "args": ["/tmp/x.sh"],
                              "env": {"FOO": "bar"}
                            },
                            "b_http": {
                              "url": "https://example.com/mcp",
                              "headers": {"Authorization": "Bearer x"}
                            },
                            "c_bad": {
                              "env": {}
                            }
                          }
                        }
                        """);

        assertThat(config.servers()).containsKeys("a_stdio", "b_http").doesNotContainKey("c_bad");
        McpServerConfig stdio = config.servers().get("a_stdio");
        assertThat(stdio.isStdio()).isTrue();
        assertThat(stdio.command()).isEqualTo("bash");
        assertThat(stdio.args()).containsExactly("/tmp/x.sh");
        assertThat(stdio.env()).containsEntry("FOO", "bar");
        McpServerConfig http = config.servers().get("b_http");
        assertThat(http.isHttp()).isTrue();
        assertThat(http.url()).isEqualTo("https://example.com/mcp");
        assertThat(http.headers()).containsEntry("Authorization", "Bearer x");
    }
}