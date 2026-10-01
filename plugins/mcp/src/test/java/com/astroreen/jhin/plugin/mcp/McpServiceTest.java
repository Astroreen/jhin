package com.astroreen.jhin.plugin.mcp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.agent.api.ToolProvider;
import com.astroreen.jhin.plugin.agent.api.ToolResult;
import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.json.Json;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;

/**
 * Drives the real {@link McpPlugin} against a real MCP stdio server fixture
 * and against a broken server declaration.
 *
 * <p>NOTE: the fixture script {@code echo_server.py} is a TEST RESOURCE ONLY,
 * kept under {@code src/test/resources} and never packaged into the plugin jar
 * (the plugin build conventions bundle only the main runtimeClasspath). The
 * product's zero-external-binaries rule applies to product tools; this fixture
 * is a standard test resource so the tests can exercise a real MCP handshake
 * over a real spawned process.
 *
 * <p>Happy QA: the fixture tool is registered as {@code mcp__echo-server__echo}
 * and {@code execute} echoes the input back. Failure QA: an {@code mcp.json}
 * pointing at a non-existent command leaves the plugin started, logs an
 * {@code ERROR} naming the server and registers zero tools; the ERROR is
 * asserted through a logback {@link ListAppender} (the same log-capture
 * pattern the kernel tests use), attached to the plugin logger of the fake
 * context.
 */
class McpServiceTest {

    /** The fixture server name used in every {@code mcp.json} of this suite. */
    private static final String ECHO_SERVER = "echo-server";

    /** A command name that exists on no PATH, for the failure QA. */
    private static final String MISSING_COMMAND = "definitely-not-a-real-command-xyz";

    /** The fixture script as installed in the temp home. */
    private Path script;

    /** The logger under capture; the fake context hands it to the plugin. */
    private ch.qos.logback.classic.Logger logger;

    /** The log capture of this test. */
    private ListAppender<ILoggingEvent> capture;

    @BeforeEach
    void attachCapture() {
        logger = (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(
                "test.mcp." + UUID.randomUUID());
        capture = new ListAppender<>();
        capture.start();
        logger.addAppender(capture);
    }

    @AfterEach
    void detachCapture() {
        logger.detachAppender(capture);
    }

    @Test
    void echoServerToolIsRegisteredAndEchoes(@TempDir Path home) throws Exception {
        Path pidFile = home.resolve("echo.pid");
        script = installFixture(home);
        writeMcpJson(home, Map.of(ECHO_SERVER, Map.of(
                "command", "python3",
                "args", List.of(script.toString(), pidFile.toString()),
                "transport", McpConfig.TRANSPORT_STDIO)));

        FakePluginContext ctx = new FakePluginContext(home, logger);
        McpPlugin plugin = new McpPlugin();
        plugin.start(ctx);

        ToolProvider provider = ctx.published(ToolProvider.class);
        assertThat(provider).as("the plugin publishes its ToolProvider").isNotNull();
        List<ToolDefinition> tools = provider.tools();
        assertThat(tools).hasSize(1);

        ToolDefinition echo = tools.get(0);
        assertThat(echo.name()).isEqualTo("mcp__echo-server__echo");
        assertThat(echo.description()).contains("Echo");
        assertThat(echo.parametersSchema()).contains("message");
        assertThat(echo.promptSnippet()).contains("echo-server").contains("MCP server");

        ToolResult result = echo.execute(
                new ToolCall("t-1", echo.name(), "{\"message\": \"hello t35\"}"),
                new FakeToolContext(home));
        assertThat(result.error()).isFalse();
        assertThat(result.content()).isEqualTo("hello t35");

        long pid = readPid(pidFile);
        assertThat(isAlive(pid)).as("the fixture process is running while connected").isTrue();

        plugin.stop();

        awaitExit(pid);
        assertThat(isAlive(pid)).as("stop() closed the transport and the fixture process exited").isFalse();
    }

    @Test
    void brokenServerIsSkippedWithErrorAndZeroTools(@TempDir Path home) throws Exception {
        writeMcpJson(home, Map.of("broken", Map.of(
                "command", MISSING_COMMAND,
                "args", List.of(),
                "transport", McpConfig.TRANSPORT_STDIO)));

        FakePluginContext ctx = new FakePluginContext(home, logger);
        McpPlugin plugin = new McpPlugin();
        plugin.start(ctx);

        assertThat(ctx.published(ToolProvider.class)).as("the plugin stays started and publishes").isNotNull();
        assertThat(ctx.published(ToolProvider.class).tools()).as("zero tools registered").isEmpty();
        assertThat(errorMessages())
                .as("an ERROR naming the server and the reason is logged")
                .anyMatch(message -> message.contains("broken") && message.contains(MISSING_COMMAND));

        plugin.stop();
    }

    @Test
    void brokenServerDoesNotBlockHealthyServers(@TempDir Path home) throws Exception {
        Path pidFile = home.resolve("echo.pid");
        script = installFixture(home);
        writeMcpJson(home, Map.of(
                "broken", Map.of("command", MISSING_COMMAND, "args", List.of()),
                ECHO_SERVER, Map.of(
                        "command", "python3",
                        "args", List.of(script.toString(), pidFile.toString()))));

        FakePluginContext ctx = new FakePluginContext(home, logger);
        McpPlugin plugin = new McpPlugin();
        plugin.start(ctx);

        List<ToolDefinition> tools = ctx.published(ToolProvider.class).tools();
        assertThat(tools).hasSize(1);
        assertThat(tools.get(0).name()).isEqualTo("mcp__echo-server__echo");
        ToolResult result = tools.get(0).execute(
                new ToolCall("t-2", tools.get(0).name(), "{\"message\": \"still alive\"}"),
                new FakeToolContext(home));
        assertThat(result.content()).isEqualTo("still alive");

        long pid = readPid(pidFile);
        plugin.stop();
        awaitExit(pid);
    }

    @Test
    void missingMcpJsonIsANoOp(@TempDir Path home) {
        FakePluginContext ctx = new FakePluginContext(home, logger);
        McpPlugin plugin = new McpPlugin();
        plugin.start(ctx);

        assertThat(ctx.published(ToolProvider.class)).as("nothing is published without a config").isNull();
        assertThat(messages(Level.INFO)).anyMatch(message -> message.contains("no configuration"));

        plugin.stop();
    }

    @Test
    void malformedMcpJsonFailsPluginStart(@TempDir Path home) throws Exception {
        Files.writeString(home.resolve(McpPlugin.CONFIG_FILE_NAME), "{ not json");

        FakePluginContext ctx = new FakePluginContext(home, logger);
        McpPlugin plugin = new McpPlugin();

        assertThatThrownBy(() -> plugin.start(ctx))
                .isInstanceOf(PluginException.class)
                .hasMessageContaining(McpPlugin.CONFIG_FILE_NAME);
    }

    /**
     * Copies the {@code echo_server.py} test resource into the temp home as a
     * plain file the fixture command can spawn.
     *
     * @param home the temp home
     * @return the installed script path
     * @throws IOException when the resource can not be copied
     */
    private static Path installFixture(Path home) throws IOException {
        Path script = home.resolve("echo_server.py");
        try (InputStream in = McpServiceTest.class.getClassLoader()
                .getResourceAsStream("echo_server.py")) {
            assertThat(in).as("the echo_server.py test resource is on the test classpath").isNotNull();
            Files.copy(in, script);
        }
        return script;
    }

    /**
     * Writes {@code mcp.json} with the given server map.
     *
     * @param home    the temp home
     * @param servers the server name to server object map
     * @throws IOException when the file can not be written
     */
    private static void writeMcpJson(Path home, Map<String, Object> servers) throws IOException {
        Files.writeString(home.resolve(McpPlugin.CONFIG_FILE_NAME),
                Json.write(Map.of("mcpServers", servers)));
    }

    /**
     * Reads the pid the fixture wrote on startup.
     *
     * @param pidFile the pid file path
     * @return the fixture pid
     * @throws IOException when the file can not be read
     */
    private static long readPid(Path pidFile) throws IOException {
        return Long.parseLong(Files.readString(pidFile).trim());
    }

    /**
     * Whether the process is alive.
     *
     * @param pid the process id
     * @return {@code true} while the process runs
     */
    private static boolean isAlive(long pid) {
        return ProcessHandle.of(pid).filter(ProcessHandle::isAlive).isPresent();
    }

    /**
     * Waits (briefly, for robustness) until the process is gone.
     *
     * @param pid the process id
     * @throws InterruptedException when the wait is interrupted
     */
    private static void awaitExit(long pid) throws InterruptedException {
        for (int i = 0; i < 30 && isAlive(pid); i++) {
            Thread.sleep(100);
        }
    }

    /**
     * The captured messages of one level.
     *
     * @param level the level to filter by
     * @return the formatted messages
     */
    private List<String> messages(Level level) {
        return capture.list.stream()
                .filter(event -> event.getLevel() == level)
                .map(ILoggingEvent::getFormattedMessage)
                .toList();
    }

    /**
     * The captured ERROR messages.
     *
     * @return the formatted ERROR messages
     */
    private List<String> errorMessages() {
        return messages(Level.ERROR);
    }
}
