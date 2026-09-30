package com.astroreen.jhin.kernel.loader;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.groups.Tuple.tuple;

import com.astroreen.jhin.kernel.KernelRoutes;
import com.astroreen.jhin.kernel.config.ConfigStore;
import com.astroreen.jhin.kernel.config.JhinHome;
import com.astroreen.jhin.kernel.db.Database;
import com.astroreen.jhin.kernel.http.HttpRegistryImpl;
import com.astroreen.jhin.kernel.http.RouteMatcher;
import com.astroreen.jhin.kernel.services.ServiceRegistryImpl;
import com.astroreen.jhin.kernel.stream.StreamRegistryImpl;
import com.astroreen.jhin.sdk.KernelInfo;
import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.http.HttpResponse;
import com.astroreen.jhin.sdk.http.RouteSpec;
import com.astroreen.jhin.sdk.json.Json;
import com.astroreen.jhin.sdk.stream.StreamEvent;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class PluginLifecycleTest {

    @TempDir
    static Path work;

    /** Shared fixture jar builder; created lazily against the temp work dir. */
    private static FixtureJars fixtures;

    private static FixtureJars fixtures() {
        if (fixtures == null) {
            fixtures = new FixtureJars(work);
        }
        return fixtures;
    }

    // happy path: three fixture jars all start and their registrations land
    // in the right registries, tagged with the owning plugin id
    @Test
    void allPluginsStartWithAttributedRegistrations() throws Exception {
        Path home = home("h-home");
        Path jarA = happyJar("h-a", "jhin.a", "fixture.a", "APlugin", "a", false);
        Path jarB = happyJar("h-b", "jhin.b", "fixture.b", "BPlugin", "b", true);
        Path jarC = happyJar("h-c", "jhin.c", "fixture.c", "CPlugin", "c", false);

        Database database = Database.open(envFor(home));
        StreamRegistryImpl streams = new StreamRegistryImpl();
        ServiceRegistryImpl services = new ServiceRegistryImpl();
        HttpRegistryImpl http = new HttpRegistryImpl();
        List<StreamEvent> received = Collections.synchronizedList(new ArrayList<>());
        streams.subscribe("t", received::add);
        PluginLifecycle lifecycle = new PluginLifecycle(home, ConfigStore.load(home), database,
                services, http, streams, PluginLifecycleTest.class.getClassLoader());
        try {
            ClassLoader before = Thread.currentThread().getContextClassLoader();
            PluginRegistry registry = lifecycle.load(candidates(jarA, jarB, jarC));

            // the context class loader is restored after every start
            assertThat(Thread.currentThread().getContextClassLoader()).isSameAs(before);

            assertThat(registry.failures()).isEmpty();
            assertThat(registry.loadedPlugins())
                    .extracting(KernelInfo.Loaded::id, KernelInfo.Loaded::version,
                            KernelInfo.Loaded::name)
                    .containsExactly(
                            tuple("jhin.a", "0.1.0", "Fixture jhin.a"),
                            tuple("jhin.b", "0.1.0", "Fixture jhin.b"),
                            tuple("jhin.c", "0.1.0", "Fixture jhin.c"));
            assertThat(registry.loadedPlugins().get(0).exports()).isEmpty();

            // per-plugin data dir exists, is owner-only, and proves the
            // context wiring (TCCL during start, table prefix of the plugin)
            Path dataA = home.resolve("data").resolve("jhin.a");
            assertThat(dataA).isDirectory();
            if (FileSystems.getDefault().supportedFileAttributeViews().contains("posix")) {
                assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(dataA)))
                        .isEqualTo("rwx------");
            }
            assertThat(Files.readString(dataA.resolve("tccl.txt"))).isEqualTo("true");
            assertThat(Files.readString(dataA.resolve("prefix.txt"))).isEqualTo("jhin_a_");

            // stream publications landed in the shared registry
            assertThat(received).extracting(StreamEvent::type).containsExactly("a", "b", "c");

            // routes landed and every one is owned by its plugin
            RouteMatcher matcher = new RouteMatcher(http.routeTable());
            RouteMatcher.Resolution hit = matcher.resolve("GET", "/a");
            assertThat(hit.status()).isEqualTo(RouteMatcher.Status.MATCHED);
            assertThat(hit.route().handler().handle(null).body())
                    .isEqualTo("a".getBytes(StandardCharsets.UTF_8));
            assertThatThrownBy(() -> http.route(new RouteSpec("GET", "/a", req -> null)))
                    .isInstanceOf(PluginException.class)
                    .hasMessage("route conflict: GET /a already owned by jhin.a");
            assertThatThrownBy(() -> http.route(new RouteSpec("GET", "/b", req -> null)))
                    .isInstanceOf(PluginException.class)
                    .hasMessage("route conflict: GET /b already owned by jhin.b");

            // service publications are attributed to their publishers
            assertThat(services.publishersByPlugin())
                    .containsEntry("jhin.a", List.of("fixture.a.Api"))
                    .containsEntry("jhin.b", List.of("fixture.b.Api"))
                    .containsEntry("jhin.c", List.of("fixture.c.Api"));

            // CLI commands landed in the shared book, tagged with their owner
            assertThat(lifecycle.commands())
                    .extracting(PluginLifecycle.CommandEntry::pluginId,
                            entry -> entry.spec().name())
                    .containsExactly(
                            tuple("jhin.a", "cmd-a"),
                            tuple("jhin.b", "cmd-b"),
                            tuple("jhin.c", "cmd-c"));

            // the health fallback reports real data through the catalog seam
            KernelRoutes.install(http, registry);
            HttpResponse health = new RouteMatcher(http.routeTable())
                    .resolve("GET", KernelRoutes.HEALTH_PATH)
                    .route()
                    .handler()
                    .handle(null);
            assertThat(health.status()).isEqualTo(200);
            Map<String, Object> payload = Json.readMap(
                    new String(health.body(), StandardCharsets.UTF_8));
            assertThat(payload.get("status")).isEqualTo("ok");
            assertThat(payload.get("plugins")).isEqualTo(registry.loaded());
            assertThat(payload.get("failed")).isEqualTo(List.of());

            // hooks: started in load order, shutdown hooks in load order,
            // stop() in reverse load order, one bad hook/stop cannot abort
            // the rest
            lifecycle.runStartedHooks();
            assertThat(Files.readString(home.resolve("data").resolve("started-order.txt")))
                    .isEqualTo("a\nb\nc\n");
            lifecycle.shutdown();
            assertThat(Files.readString(home.resolve("data").resolve("shutdown-order.txt")))
                    .isEqualTo("a\nb\nc\n");
            assertThat(Files.readString(home.resolve("data").resolve("stop-order.txt")))
                    .isEqualTo("c\nb\na\n");
        } finally {
            lifecycle.shutdown();
            database.close();
            streams.close();
        }
    }

    // acceptance: the failing plugin is isolated, its dependant is
    // cascade-failed with the graph's reason text, the unrelated one starts
    @Test
    void failingPluginIsIsolatedAndDependantsCascade() throws Exception {
        Path home = home("f-home");
        Path jarA = requiresJar("f-a", "jhin.a", "fixture.a", "APlugin", "jhin.b");
        Path jarB = throwingJar("f-b", "jhin.b", "fixture.b", "BPlugin");
        Path jarC = happyJar("f-c", "jhin.c", "fixture.c", "CPlugin", "c", false);

        Database database = Database.open(envFor(home));
        StreamRegistryImpl streams = new StreamRegistryImpl();
        ServiceRegistryImpl services = new ServiceRegistryImpl();
        HttpRegistryImpl http = new HttpRegistryImpl();
        PluginLifecycle lifecycle = new PluginLifecycle(home, ConfigStore.load(home), database,
                services, http, streams, PluginLifecycleTest.class.getClassLoader());
        try {
            ClassLoader before = Thread.currentThread().getContextClassLoader();
            PluginRegistry registry = lifecycle.load(candidates(jarA, jarB, jarC));
            assertThat(Thread.currentThread().getContextClassLoader()).isSameAs(before);

            assertThat(registry.failures()).containsExactly(
                    new PluginRegistry.Failure("jhin.a", "dependency jhin.b failed"),
                    new PluginRegistry.Failure("jhin.b", "boom"));
            assertThat(registry.failures())
                    .extracting(PluginRegistry.Failure::reason)
                    .containsExactlyInAnyOrder("boom", "dependency jhin.b failed");
            assertThat(registry.loadedPlugins())
                    .extracting(KernelInfo.Loaded::id)
                    .containsExactly("jhin.c");

            // the survivor really started: its route is served
            RouteMatcher.Resolution hit = new RouteMatcher(http.routeTable())
                    .resolve("GET", "/c");
            assertThat(hit.status()).isEqualTo(RouteMatcher.Status.MATCHED);
            assertThat(hit.route().handler().handle(null).body())
                    .isEqualTo("c".getBytes(StandardCharsets.UTF_8));

            // the health payload carries the two failures with their reasons
            KernelRoutes.install(http, registry);
            HttpResponse health = new RouteMatcher(http.routeTable())
                    .resolve("GET", KernelRoutes.HEALTH_PATH)
                    .route()
                    .handler()
                    .handle(null);
            Map<String, Object> payload = Json.readMap(
                    new String(health.body(), StandardCharsets.UTF_8));
            assertThat(payload.get("failed")).isEqualTo(registry.failed());
        } finally {
            lifecycle.shutdown();
            database.close();
            streams.close();
        }
    }

    // extra: a main class without a public no-arg constructor fails with a
    // pointed reason naming the class
    @Test
    void missingPublicNoArgConstructorFailsNamingTheClass() throws Exception {
        Path home = home("d-home");
        Path jar = fixtures().jarOf("d-ctor",
                Map.of(
                        "fixture.d.DPlugin",
                        "package fixture.d;\n"
                                + "import com.astroreen.jhin.sdk.JhinPlugin;\n"
                                + "import com.astroreen.jhin.sdk.PluginContext;\n"
                                + "public class DPlugin implements JhinPlugin {\n"
                                + "    public DPlugin(String ignored) {}\n"
                                + "    @Override public void start(PluginContext ctx) {}\n"
                                + "}\n"),
                Map.of("jhin-plugin.json",
                        manifest("jhin.d", "fixture.d.DPlugin", "[]")));

        Database database = Database.open(envFor(home));
        StreamRegistryImpl streams = new StreamRegistryImpl();
        PluginLifecycle lifecycle = new PluginLifecycle(home, ConfigStore.load(home), database,
                new ServiceRegistryImpl(), new HttpRegistryImpl(), streams,
                PluginLifecycleTest.class.getClassLoader());
        try {
            PluginRegistry registry = lifecycle.load(candidates(jar));
            assertThat(registry.loadedPlugins()).isEmpty();
            assertThat(registry.failures()).containsExactly(new PluginRegistry.Failure("jhin.d",
                    "main class fixture.d.DPlugin has no public no-arg constructor"));
        } finally {
            lifecycle.shutdown();
            database.close();
            streams.close();
        }
    }

    /** Resolves a per-test home under the shared work dir. */
    private static Path home(String name) {
        return JhinHome.resolve(envFor(work.resolve(name)));
    }

    private static Function<String, String> envFor(Path home) {
        return name -> "JHIN_HOME".equals(name) ? home.toString() : null;
    }

    /** Runs the real scan/parse pipeline over the given jars. */
    private static List<ManifestParser.Candidate> candidates(Path... jars) throws IOException {
        List<PluginScanner.ScannedJar> scanned =
                new PluginScanner(List.of(jars)).scan();
        assertThat(scanned).hasSize(jars.length);
        List<ManifestParser.Candidate> parsed = new ManifestParser().parseAll(scanned);
        assertThat(parsed).hasSize(jars.length);
        return parsed;
    }

    /**
     * Builds one well-formed fixture jar whose plugin registers a route, a CLI
     * command, a service and a stream event, plus the hook-order files. The
     * sabotaged variant throws from its on-shutdown hook and from {@code stop()}.
     */
    private static Path happyJar(String name, String id, String pkg, String cls,
            String marker, boolean sabotage) throws IOException {
        String shutdownHook = sabotage
                ? "ctx.onShutdown(() -> { append(root.resolve(\"shutdown-order.txt\"), \""
                        + marker + "\"); throw new RuntimeException(\"shutdown-boom\"); });"
                : "ctx.onShutdown(() -> append(root.resolve(\"shutdown-order.txt\"), \""
                        + marker + "\"));";
        String stopBody = sabotage
                ? "append(orderFile, \"" + marker + "\");\n"
                        + "        throw new RuntimeException(\"stop-boom\");"
                : "append(orderFile, \"" + marker + "\");";
        String source = "package " + pkg + ";\n"
                + "import com.astroreen.jhin.sdk.JhinPlugin;\n"
                + "import com.astroreen.jhin.sdk.PluginContext;\n"
                + "import com.astroreen.jhin.sdk.cli.CliCommandSpec;\n"
                + "import com.astroreen.jhin.sdk.http.HttpResponse;\n"
                + "import com.astroreen.jhin.sdk.http.RouteSpec;\n"
                + "import com.astroreen.jhin.sdk.stream.StreamEvent;\n"
                + "import java.nio.file.Files;\n"
                + "import java.nio.file.Path;\n"
                + "import java.nio.file.StandardOpenOption;\n"
                + "public class " + cls + " implements JhinPlugin {\n"
                + "    private Path orderFile;\n"
                + "    public " + cls + "() {}\n"
                + "    @Override public void start(PluginContext ctx) throws Exception {\n"
                + "        ctx.http().route(new RouteSpec(\"GET\", \"/" + marker
                + "\", req -> HttpResponse.text(200, \"" + marker + "\")));\n"
                + "        ctx.cli().command(new CliCommandSpec(\"cmd-" + marker + "\", \"cmd-"
                + marker + "\", \"command " + marker + "\", (args, out, err) -> 0));\n"
                + "        ctx.services().publish(Api.class, new Api());\n"
                + "        ctx.streams().publish(\"t\", new StreamEvent(\"" + marker + "\", 1));\n"
                + "        Path root = ctx.dataDir().getParent();\n"
                + "        orderFile = root.resolve(\"stop-order.txt\");\n"
                + "        Files.writeString(ctx.dataDir().resolve(\"tccl.txt\"),\n"
                + "                Boolean.toString(Thread.currentThread().getContextClassLoader()\n"
                + "                        == " + cls + ".class.getClassLoader()));\n"
                + "        Files.writeString(ctx.dataDir().resolve(\"prefix.txt\"),\n"
                + "                ctx.db().tablePrefix());\n"
                + "        ctx.onStarted(() -> append(root.resolve(\"started-order.txt\"), \""
                + marker + "\"));\n"
                + "        " + shutdownHook + "\n"
                + "    }\n"
                + "    @Override public void stop() {\n"
                + "        " + stopBody + "\n"
                + "    }\n"
                + "    private static void append(Path file, String line) {\n"
                + "        try {\n"
                + "            Files.writeString(file, line + \"\\n\",\n"
                + "                    StandardOpenOption.CREATE, StandardOpenOption.APPEND);\n"
                + "        } catch (Exception e) {\n"
                + "            throw new RuntimeException(e);\n"
                + "        }\n"
                + "    }\n"
                + "}\n";
        return fixtures().jarOf(name,
                Map.of(pkg + "." + cls, source, pkg + ".Api", "package " + pkg + ";\n"
                        + "public class Api {}\n"),
                Map.of("jhin-plugin.json", manifest(id, pkg + "." + cls, "[]")));
    }

    /**
     * Builds one fixture jar whose plugin declares a non-optional requirement
     * and only registers a route (it never starts when the requirement fails).
     */
    private static Path requiresJar(String name, String id, String pkg, String cls,
            String requiredId) throws IOException {
        String source = "package " + pkg + ";\n"
                + "import com.astroreen.jhin.sdk.JhinPlugin;\n"
                + "import com.astroreen.jhin.sdk.PluginContext;\n"
                + "import com.astroreen.jhin.sdk.http.HttpResponse;\n"
                + "import com.astroreen.jhin.sdk.http.RouteSpec;\n"
                + "public class " + cls + " implements JhinPlugin {\n"
                + "    public " + cls + "() {}\n"
                + "    @Override public void start(PluginContext ctx) throws Exception {\n"
                + "        ctx.http().route(new RouteSpec(\"GET\", \"/" + id + "\",\n"
                + "                req -> HttpResponse.text(200, \"" + id + "\")));\n"
                + "    }\n"
                + "}\n";
        return fixtures().jarOf(name, Map.of(pkg + "." + cls, source),
                Map.of("jhin-plugin.json", manifest(id, pkg + "." + cls,
                        "[{\"id\":\"" + requiredId
                                + "\",\"versionRange\":\"*\",\"optional\":false}]")));
    }

    /** Builds one fixture jar whose plugin throws from {@code start}. */
    private static Path throwingJar(String name, String id, String pkg, String cls)
            throws IOException {
        String source = "package " + pkg + ";\n"
                + "import com.astroreen.jhin.sdk.JhinPlugin;\n"
                + "import com.astroreen.jhin.sdk.PluginContext;\n"
                + "public class " + cls + " implements JhinPlugin {\n"
                + "    public " + cls + "() {}\n"
                + "    @Override public void start(PluginContext ctx) throws Exception {\n"
                + "        throw new RuntimeException(\"boom\");\n"
                + "    }\n"
                + "}\n";
        return fixtures().jarOf(name, Map.of(pkg + "." + cls, source),
                Map.of("jhin-plugin.json", manifest(id, pkg + "." + cls, "[]")));
    }

    private static String manifest(String id, String mainClass, String requires) {
        return "{\"id\":\"" + id + "\",\"version\":\"0.1.0\",\"apiVersion\":1,"
                + "\"name\":\"Fixture " + id + "\",\"description\":\"d\","
                + "\"mainClass\":\"" + mainClass + "\",\"exports\":[],"
                + "\"requires\":" + requires + "}";
    }
}
