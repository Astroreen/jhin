package com.astroreen.jhin.core.plugins;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.core.accounts.AccountService;
import com.astroreen.jhin.core.agent.SystemPromptBuilder;
import com.astroreen.jhin.core.agent.spi.PromptContext;
import com.astroreen.jhin.core.db.DatabaseConfig;
import com.astroreen.jhin.core.db.MigrationRunner;
import com.astroreen.jhin.core.db.WriteQueue;
import com.astroreen.jhin.core.llm.ProviderRegistry;
import com.astroreen.jhin.core.llm.ProviderRegistry.ProviderRecord;
import com.astroreen.jhin.core.plugins.PluginManager.LoadedPlugin;
import com.astroreen.jhin.core.tools.ToolRegistry;
import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import dev.langchain4j.model.chat.ChatModel;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import java.util.stream.Stream;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;

class PluginLoaderTest {

    @TempDir
    Path jhinHome;

    private WriteQueue writeQueue;
    private PluginManager manager;

    @AfterEach
    void tearDown() {
        if (manager != null) {
            manager.close();
        }
        if (writeQueue != null) {
            writeQueue.close();
        }
    }

    @Test
    void loadsAllFiveSpiImplementationsFromPluginJar() throws Exception {
        Path pluginsDir = jhinHome.resolve("plugins");
        buildJar(
                pluginsDir,
                "all-spi.jar",
                Map.of(
                        "testplugin.ExampleToolProvider", EXAMPLE_TOOL_PROVIDER,
                        "testplugin.ExampleGuard", EXAMPLE_GUARD,
                        "testplugin.ExampleTransformer", EXAMPLE_TRANSFORMER,
                        "testplugin.ExampleInterceptor", EXAMPLE_INTERCEPTOR,
                        "testplugin.ExampleFactory", EXAMPLE_FACTORY),
                Map.of(
                        "com.astroreen.jhin.core.tools.spi.ToolProvider", "testplugin.ExampleToolProvider",
                        "com.astroreen.jhin.core.tools.spi.ToolCallGuard", "testplugin.ExampleGuard",
                        "com.astroreen.jhin.core.tools.spi.ToolResultTransformer", "testplugin.ExampleTransformer",
                        "com.astroreen.jhin.core.agent.spi.PromptInterceptor", "testplugin.ExampleInterceptor",
                        "com.astroreen.jhin.core.llm.LlmProviderFactory", "testplugin.ExampleFactory"));

        ToolRegistry toolRegistry = new ToolRegistry(List.of(), List.of(), List.of());
        SystemPromptBuilder promptBuilder = new SystemPromptBuilder(List.of());
        ProviderRegistry providerRegistry = providerRegistry();
        manager = manager(toolRegistry, promptBuilder, providerRegistry);
        manager.loadAll();

        assertThat(manager.loadedPlugins()).hasSize(1);
        LoadedPlugin plugin = manager.loadedPlugins().get(0);
        assertThat(plugin.jarName()).isEqualTo("all-spi.jar");
        assertThat(plugin.tools()).containsExactly("example_time");
        assertThat(plugin.guards()).containsExactly("testplugin.ExampleGuard");
        assertThat(plugin.transformers()).containsExactly("testplugin.ExampleTransformer");
        assertThat(plugin.interceptors()).containsExactly("testplugin.ExampleInterceptor");
        assertThat(plugin.factories()).containsExactly("example-fmt");

        assertThat(toolRegistry.find("example_time")).isPresent();

        ToolResult ok = toolRegistry.execute("example_time", Map.of(), toolContext());
        assertThat(ok.error()).isFalse();
        assertThat(ok.content()).isEqualTo("12:00:00[transformed]");

        ToolResult blocked = toolRegistry.execute("example_time", Map.of("denied", true), toolContext());
        assertThat(blocked.error()).isTrue();
        assertThat(blocked.content()).isEqualTo("Blocked: denied by plugin");

        PromptContext prompt = promptBuilder.build(jhinHome.toString(), "s1", "r1", List.of());
        assertThat(prompt.systemPrompt()).contains("[intercepted]");

        assertThat(providerRegistry.knownFormats()).contains("example-fmt");
        String accountId = new AccountService(JdbcClient.create(dataSource()), writeQueue).createAccount("alice");
        ProviderRecord record = providerRegistry
                .create(accountId, "work", "example-fmt", "sk-test-secret-value", "m", null, false)
                .join();
        ChatModel model = providerRegistry.buildChatModel(record);
        assertThat(model).isNotNull();
        assertThat(model.getClass().getName()).startsWith("testplugin.ExampleFactory");
    }

    @Test
    void skipsBrokenJarAndStillLoadsGoodOne() throws Exception {
        Path pluginsDir = jhinHome.resolve("plugins");
        Files.createDirectories(pluginsDir);
        Files.writeString(pluginsDir.resolve("broken.jar"), "this is not a zip at all");
        buildJar(
                pluginsDir,
                "good.jar",
                Map.of("testplugin.ExampleToolProvider", EXAMPLE_TOOL_PROVIDER),
                Map.of(
                        "com.astroreen.jhin.core.tools.spi.ToolProvider", "testplugin.ExampleToolProvider"));

        ToolRegistry toolRegistry = new ToolRegistry(List.of(), List.of(), List.of());
        manager = manager(toolRegistry, new SystemPromptBuilder(List.of()), providerRegistry());
        manager.loadAll();

        assertThat(manager.loadedPlugins()).hasSize(1);
        assertThat(manager.loadedPlugins().get(0).jarName()).isEqualTo("good.jar");
        assertThat(toolRegistry.find("example_time")).isPresent();

        manager.loadAll();
        assertThat(manager.loadedPlugins()).hasSize(1);
    }

    @Test
    void skipsBrokenServiceEntriesAndLoadsRestOfJar() throws Exception {
        Path pluginsDir = jhinHome.resolve("plugins");
        buildJar(
                pluginsDir,
                "mixed.jar",
                Map.of(
                        "testplugin.ExampleToolProvider", EXAMPLE_TOOL_PROVIDER,
                        "testplugin.ExampleGuard", EXAMPLE_GUARD,
                        "testplugin.BoomTransformer", BOOM_TRANSFORMER),
                Map.of(
                        "com.astroreen.jhin.core.tools.spi.ToolProvider",
                                "testplugin.NoSuchProvider\ntestplugin.ExampleToolProvider",
                        "com.astroreen.jhin.core.tools.spi.ToolCallGuard", "testplugin.ExampleGuard",
                        "com.astroreen.jhin.core.tools.spi.ToolResultTransformer", "testplugin.BoomTransformer"));

        ToolRegistry toolRegistry = new ToolRegistry(List.of(), List.of(), List.of());
        manager = manager(toolRegistry, new SystemPromptBuilder(List.of()), providerRegistry());
        manager.loadAll();

        assertThat(manager.loadedPlugins()).hasSize(1);
        LoadedPlugin plugin = manager.loadedPlugins().get(0);
        assertThat(plugin.tools()).containsExactly("example_time");
        assertThat(plugin.guards()).containsExactly("testplugin.ExampleGuard");
        assertThat(plugin.transformers()).isEmpty();
        assertThat(toolRegistry.find("example_time")).isPresent();
        ToolResult blocked =
                toolRegistry.execute("example_time", Map.of("denied", true), toolContext());
        assertThat(blocked.content()).isEqualTo("Blocked: denied by plugin");
    }

    @Test
    void missingOrEmptyPluginsDirYieldsZeroPlugins() throws IOException {
        ToolRegistry toolRegistry = new ToolRegistry(List.of(), List.of(), List.of());
        manager = manager(toolRegistry, new SystemPromptBuilder(List.of()), providerRegistry());

        manager.loadAll();
        assertThat(manager.loadedPlugins()).isEmpty();

        assertThat(jhinHome.resolve("plugins").toFile().mkdirs()).isTrue();
        manager.loadAll();
        assertThat(manager.loadedPlugins()).isEmpty();
    }

    @Test
    void builtinToolNameWinsOverPluginTool() throws Exception {
        Path pluginsDir = jhinHome.resolve("plugins");
        buildJar(
                pluginsDir,
                "collision.jar",
                Map.of("testplugin.CollisionToolProvider", COLLISION_TOOL_PROVIDER),
                Map.of(
                        "com.astroreen.jhin.core.tools.spi.ToolProvider", "testplugin.CollisionToolProvider"));

        StubTool builtinBash = new StubTool("bash", "builtin-bash");
        ToolRegistry toolRegistry =
                new ToolRegistry(List.of(() -> List.of(builtinBash)), List.of(), List.of());
        manager = manager(toolRegistry, new SystemPromptBuilder(List.of()), providerRegistry());
        manager.loadAll();

        assertThat(toolRegistry.find("bash")).containsSame(builtinBash);
        assertThat(toolRegistry.find("plugin_extra")).isPresent();
        assertThat(toolRegistry.execute("bash", Map.of(), toolContext()).content())
                .isEqualTo("builtin-bash");

        assertThat(manager.loadedPlugins()).hasSize(1);
        assertThat(manager.loadedPlugins().get(0).tools()).containsExactly("plugin_extra");
    }

    private PluginManager manager(
            ToolRegistry toolRegistry, SystemPromptBuilder promptBuilder, ProviderRegistry providerRegistry)
            throws IOException {
        return new PluginManager(
                toolRegistry,
                providerRegistry,
                promptBuilder,
                new MigrationRunner(dataSource()),
                jhinHome.toString());
    }

    private javax.sql.DataSource dataSource() throws IOException {
        return DatabaseConfig.createDataSource(jhinHome);
    }

    private ProviderRegistry providerRegistry() throws IOException {
        if (writeQueue == null) {
            writeQueue = new WriteQueue();
        }
        javax.sql.DataSource ds = dataSource();
        new MigrationRunner(ds).migrate();
        return new ProviderRegistry(JdbcClient.create(ds), writeQueue, List.of());
    }

    private static ToolContext toolContext() {
        return new ToolContext(Path.of("/tmp"), "s1", "r1", "a1");
    }

    private static void buildJar(
            Path pluginsDir, String jarName, Map<String, String> sources, Map<String, String> serviceFiles)
            throws IOException {
        Files.createDirectories(pluginsDir);
        Path scratch = Files.createTempDirectory(pluginsDir.getParent(), "plugin-build");
        Path srcDir = scratch.resolve("src");
        Path classesDir = scratch.resolve("classes");
        Files.createDirectories(srcDir);
        Files.createDirectories(classesDir);

        List<File> sourceFiles = new ArrayList<>();
        for (Map.Entry<String, String> source : sources.entrySet()) {
            Path file = srcDir.resolve(source.getKey().replace('.', '/') + ".java");
            Files.createDirectories(file.getParent());
            Files.writeString(file, source.getValue(), StandardCharsets.UTF_8);
            sourceFiles.add(file.toFile());
        }

        JavaCompiler compiler = javax.tools.ToolProvider.getSystemJavaCompiler();
        assertThat(compiler).as("javac available in test JVM").isNotNull();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager fileManager =
                compiler.getStandardFileManager(diagnostics, null, StandardCharsets.UTF_8)) {
            Iterable<? extends JavaFileObject> units = fileManager.getJavaFileObjectsFromFiles(sourceFiles);
            List<String> options =
                    List.of(
                            "-classpath",
                            System.getProperty("java.class.path"),
                            "-d",
                            classesDir.toString());
            Boolean compiled = compiler.getTask(null, fileManager, diagnostics, options, null, units).call();
            assertThat(compiled)
                    .as("plugin sources compile: %s", diagnostics.getDiagnostics())
                    .isTrue();
        } catch (IOException e) {
            throw new IllegalStateException("cannot compile plugin sources", e);
        }

        Map<String, byte[]> entries = new LinkedHashMap<>();
        try (Stream<Path> walk = Files.walk(classesDir)) {
            for (Path path : walk.filter(Files::isRegularFile).toList()) {
                entries.put(
                        classesDir.relativize(path).toString().replace(File.separatorChar, '/'),
                        Files.readAllBytes(path));
            }
        }
        for (Map.Entry<String, String> service : serviceFiles.entrySet()) {
            entries.put(
                    "META-INF/services/" + service.getKey(),
                    service.getValue().getBytes(StandardCharsets.UTF_8));
        }
        try (JarOutputStream jar = new JarOutputStream(Files.newOutputStream(pluginsDir.resolve(jarName)))) {
            for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
                jar.putNextEntry(new JarEntry(entry.getKey()));
                jar.write(entry.getValue());
                jar.closeEntry();
            }
        }
    }

    private static final String EXAMPLE_TOOL_PROVIDER =
            """
            package testplugin;

            import com.astroreen.jhin.core.tools.spi.ToolCall;
            import com.astroreen.jhin.core.tools.spi.ToolContext;
            import com.astroreen.jhin.core.tools.spi.ToolDefinition;
            import com.astroreen.jhin.core.tools.spi.ToolProvider;
            import com.astroreen.jhin.core.tools.spi.ToolResult;
            import java.util.List;
            import java.util.Map;

            public class ExampleToolProvider implements ToolProvider {
                @Override
                public List<ToolDefinition> tools() {
                    return List.of(new ToolDefinition() {
                        @Override public String name() { return "example_time"; }
                        @Override public String label() { return "Example time"; }
                        @Override public String description() { return "Returns the current time."; }
                        @Override public Map<String, Object> parametersSchema() { return Map.of(); }
                        @Override public String promptSnippet() { return "Returns the current time."; }
                        @Override public List<String> promptGuidelines() { return List.of(); }
                        @Override public ToolResult execute(ToolCall call, ToolContext ctx) {
                            return ToolResult.ok("12:00:00");
                        }
                    });
                }
            }
            """;

    private static final String EXAMPLE_GUARD =
            """
            package testplugin;

            import com.astroreen.jhin.core.tools.spi.ToolCall;
            import com.astroreen.jhin.core.tools.spi.ToolCallDecision;
            import com.astroreen.jhin.core.tools.spi.ToolCallGuard;

            public class ExampleGuard implements ToolCallGuard {
                @Override
                public ToolCallDecision check(ToolCall call) {
                    if (call.arguments().containsKey("denied")) {
                        return ToolCallDecision.block("denied by plugin");
                    }
                    return ToolCallDecision.allow();
                }
            }
            """;

    private static final String EXAMPLE_TRANSFORMER =
            """
            package testplugin;

            import com.astroreen.jhin.core.tools.spi.ToolResult;
            import com.astroreen.jhin.core.tools.spi.ToolResultTransformer;

            public class ExampleTransformer implements ToolResultTransformer {
                @Override
                public ToolResult transform(ToolResult r) {
                    return new ToolResult(
                            r.content() + "[transformed]", r.error(), r.truncated(), r.structured(), r.meta());
                }
            }
            """;

    private static final String EXAMPLE_INTERCEPTOR =
            """
            package testplugin;

            import com.astroreen.jhin.core.agent.spi.PromptContext;
            import com.astroreen.jhin.core.agent.spi.PromptInterceptor;

            public class ExampleInterceptor implements PromptInterceptor {
                @Override
                public PromptContext intercept(PromptContext ctx) {
                    return ctx.withSystemPrompt(ctx.systemPrompt() + "\\n[intercepted]");
                }
            }
            """;

    private static final String EXAMPLE_FACTORY =
            """
            package testplugin;

            import com.astroreen.jhin.core.llm.LlmProviderFactory;
            import com.astroreen.jhin.core.llm.ProviderConfig;
            import dev.langchain4j.model.chat.ChatModel;

            public class ExampleFactory implements LlmProviderFactory {
                @Override
                public String format() {
                    return "example-fmt";
                }

                @Override
                public ChatModel create(ProviderConfig cfg) {
                    return new ChatModel() {};
                }
            }
            """;

    private static final String BOOM_TRANSFORMER =
            """
            package testplugin;

            import com.astroreen.jhin.core.tools.spi.ToolResult;
            import com.astroreen.jhin.core.tools.spi.ToolResultTransformer;

            public class BoomTransformer implements ToolResultTransformer {
                public BoomTransformer() {
                    throw new IllegalStateException("boom in ctor");
                }

                @Override
                public ToolResult transform(ToolResult r) {
                    return r;
                }
            }
            """;

    private static final String COLLISION_TOOL_PROVIDER =
            """
            package testplugin;

            import com.astroreen.jhin.core.tools.spi.ToolCall;
            import com.astroreen.jhin.core.tools.spi.ToolContext;
            import com.astroreen.jhin.core.tools.spi.ToolDefinition;
            import com.astroreen.jhin.core.tools.spi.ToolProvider;
            import com.astroreen.jhin.core.tools.spi.ToolResult;
            import java.util.List;
            import java.util.Map;

            public class CollisionToolProvider implements ToolProvider {
                @Override
                public List<ToolDefinition> tools() {
                    return List.of(tool("bash", "plugin-bash"), tool("plugin_extra", "plugin-extra"));
                }

                private static ToolDefinition tool(String toolName, String toolResult) {
                    return new ToolDefinition() {
                        @Override public String name() { return toolName; }
                        @Override public String label() { return toolName; }
                        @Override public String description() { return toolName; }
                        @Override public Map<String, Object> parametersSchema() { return Map.of(); }
                        @Override public String promptSnippet() { return toolName; }
                        @Override public List<String> promptGuidelines() { return List.of(); }
                        @Override public ToolResult execute(ToolCall call, ToolContext ctx) {
                            return ToolResult.ok(toolResult);
                        }
                    };
                }
            }
            """;

    private static final class StubTool implements ToolDefinition {

        private final String name;
        private final String result;

        StubTool(String name, String result) {
            this.name = name;
            this.result = result;
        }

        @Override
        public String name() {
            return name;
        }

        @Override
        public String label() {
            return name;
        }

        @Override
        public String description() {
            return name;
        }

        @Override
        public Map<String, Object> parametersSchema() {
            return Map.of();
        }

        @Override
        public String promptSnippet() {
            return name;
        }

        @Override
        public List<String> promptGuidelines() {
            return List.of();
        }

        @Override
        public ToolResult execute(ToolCall call, ToolContext ctx) {
            return ToolResult.ok(result);
        }
    }
}
