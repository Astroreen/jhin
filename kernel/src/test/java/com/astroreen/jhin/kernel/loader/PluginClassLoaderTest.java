package com.astroreen.jhin.kernel.loader;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.astroreen.jhin.sdk.http.HttpRegistry;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class PluginClassLoaderTest {

    /** Shared fixture jar builder; created lazily against the temp work dir. */
    private static FixtureJars fixtures;

    @TempDir
    static Path work;

    @AfterAll
    static void writeFixtureList() throws IOException {
        Path out = Path.of("build", "t11-fixtures.txt");
        Files.createDirectories(out.getParent());
        Files.write(out, fixtures == null ? List.of() : fixtures.built());
    }

    // (1) exported dependency class loads and is identical across loaders
    @Test
    void exportedDependencyClassIsIdenticalAcrossLoaders() throws Exception {
        Path baseJar = jarOf("t1-base",
                Map.of(
                        "com.dep.api.Api", classSource("com.dep.api", "Api", "api"),
                        "com.dep.api.impl.ApiImpl", classSource("com.dep.api.impl", "ApiImpl", "impl"),
                        "com.dep.hidden.Secret", classSource("com.dep.hidden", "Secret", "secret")),
                Map.of());
        try (PluginClassLoader base = loader("base", baseJar, List.of("com.dep.api"), List.of());
                PluginClassLoader plug = loader("plug", emptyJar("t1-plug"), List.of(), List.of(base))) {
            Class<?> viaPlug = plug.loadClass("com.dep.api.Api");
            assertThat(viaPlug).isSameAs(base.loadClass("com.dep.api.Api"));
            assertThat(viaPlug.getClassLoader()).isSameAs(base);
            assertThat(plug.loadClass("com.dep.api.impl.ApiImpl"))
                    .isSameAs(base.loadClass("com.dep.api.impl.ApiImpl"));
        }
    }

    // (2) non-exported dependency class throws and lists visible exports
    @Test
    void nonExportedDependencyClassThrowsListingVisibleExports() throws Exception {
        Path baseJar = jarOf("t2-base",
                Map.of(
                        "com.dep.api.Api", classSource("com.dep.api", "Api", "api"),
                        "com.dep.hidden.Secret", classSource("com.dep.hidden", "Secret", "secret")),
                Map.of());
        try (PluginClassLoader base = loader("base", baseJar, List.of("com.dep.api"), List.of());
                PluginClassLoader plug = loader("plug", emptyJar("t2-plug"), List.of(), List.of(base))) {
            assertThat(base.loadClass("com.dep.hidden.Secret")).isNotNull();
            assertThatThrownBy(() -> plug.loadClass("com.dep.hidden.Secret"))
                    .isInstanceOf(ClassNotFoundException.class)
                    .hasMessage("plugin plug cannot see com.dep.hidden.Secret; visible exports: com.dep.api");
        }
    }

    // (3) shared contract class comes from the kernel loader
    @Test
    void sharedContractClassComesFromKernelLoader() throws Exception {
        try (PluginClassLoader plug = loader("plug", emptyJar("t3-plug"), List.of(), List.of())) {
            assertThat(plug.loadClass("com.astroreen.jhin.sdk.http.HttpRegistry"))
                    .isSameAs(HttpRegistry.class);
        }
    }

    // (4) kernel internals stay invisible
    @Test
    void kernelInternalClassIsNotVisible() throws Exception {
        Path baseJar = jarOf("t4-base",
                Map.of("com.dep.api.Api", classSource("com.dep.api", "Api", "api")), Map.of());
        try (PluginClassLoader base = loader("base", baseJar, List.of("com.dep.api"), List.of());
                PluginClassLoader bare = loader("plug", emptyJar("t4-plug"), List.of(), List.of());
                PluginClassLoader plug = loader("plug", emptyJar("t4-plug-dep"), List.of(), List.of(base))) {
            assertThat(PluginClassLoaderTest.class.getClassLoader()
                    .loadClass("com.astroreen.jhin.kernel.db.Database")).isNotNull();
            assertThatThrownBy(() -> bare.loadClass("com.astroreen.jhin.kernel.db.Database"))
                    .isInstanceOf(ClassNotFoundException.class)
                    .hasMessage("plugin plug cannot see com.astroreen.jhin.kernel.db.Database; "
                            + "visible exports: (none)");
            assertThatThrownBy(() -> plug.loadClass("com.astroreen.jhin.kernel.db.Database"))
                    .isInstanceOf(ClassNotFoundException.class)
                    .hasMessage("plugin plug cannot see com.astroreen.jhin.kernel.db.Database; "
                            + "visible exports: com.dep.api");
        }
    }

    // (5) own class shadows the same name in a non-exported dependency package
    @Test
    void ownClassShadowsNonExportedDependencyClass() throws Exception {
        Path baseJar = jarOf("t5-base",
                Map.of(
                        "com.dep.api.Api", classSource("com.dep.api", "Api", "api"),
                        "com.shadow.Hidden", classSource("com.shadow", "Hidden", "dep")),
                Map.of());
        Path plugJar = jarOf("t5-plug",
                Map.of("com.shadow.Hidden", classSource("com.shadow", "Hidden", "own")), Map.of());
        try (PluginClassLoader base = loader("base", baseJar, List.of("com.dep.api"), List.of());
                PluginClassLoader plug = loader("plug", plugJar, List.of(), List.of(base))) {
            Class<?> own = plug.loadClass("com.shadow.Hidden");
            assertThat(markerOf(own)).isEqualTo("own");
            assertThat(markerOf(base.loadClass("com.shadow.Hidden"))).isEqualTo("dep");
            assertThat(own).isNotSameAs(base.loadClass("com.shadow.Hidden"));
        }
    }

    // (6) transitive export visibility through A -> B -> C
    @Test
    void transitiveExportsAreVisibleThroughTheDependencyChain() throws Exception {
        Path cJar = jarOf("t6-c",
                Map.of("com.c.api.CApi", classSource("com.c.api", "CApi", "c")), Map.of());
        Path bJar = jarOf("t6-b",
                Map.of("com.b.api.BApi", classSource("com.b.api", "BApi", "b")), Map.of());
        Path aJar = jarOf("t6-a",
                Map.of("com.a.api.AApi", classSource("com.a.api", "AApi", "a")), Map.of());
        try (PluginClassLoader c = loader("c", cJar, List.of("com.c.api"), List.of());
                PluginClassLoader b = loader("b", bJar, List.of("com.b.api"), List.of(c));
                PluginClassLoader a = loader("a", aJar, List.of("com.a.api"), List.of(b))) {
            assertThat(a.loadClass("com.c.api.CApi")).isSameAs(c.loadClass("com.c.api.CApi"));
            assertThat(a.loadClass("com.b.api.BApi")).isSameAs(b.loadClass("com.b.api.BApi"));
        }
    }

    // (7) getResources: own + exported-dependency resources only
    @Test
    void getResourcesSeesOwnAndExportedDependencyResourcesOnly() throws Exception {
        Path baseJar = jarOf("t7-base", Map.of(),
                Map.of(
                        "com/dep/api/shared.txt", "dep",
                        "com/dep/hidden/secret.txt", "hidden",
                        "root.txt", "root"));
        Path extraJar = jarOf("t7-extra", Map.of(),
                Map.of(
                        "com/dep/api/shared.txt", "extra",
                        "com/other/x.txt", "other"));
        Path plugJar = jarOf("t7-plug", Map.of(),
                Map.of(
                        "com/dep/api/shared.txt", "own",
                        "com/plug/own.txt", "own2",
                        "root.txt", "own-root"));
        try (PluginClassLoader base = loader("base", baseJar, List.of("com.dep.api"), List.of());
                PluginClassLoader extra = loader("extra", extraJar, List.of("com.other"), List.of());
                PluginClassLoader plug = loader("plug", plugJar, List.of(), List.of(base, extra))) {
            // same path in own jar, in the exporting dependency and in a
            // dependency that does not export the package: the last one is out
            assertThat(contentsOf(plug.getResources("com/dep/api/shared.txt")))
                    .containsExactly("dep", "own");
            assertThat(contentOf(plug.getResource("com/dep/api/shared.txt"))).isEqualTo("dep");
            // non-exported package of a dependency is invisible
            assertThat(Collections.list(plug.getResources("com/dep/hidden/secret.txt"))).isEmpty();
            assertThat(plug.getResource("com/dep/hidden/secret.txt")).isNull();
            // unnamed package belongs to no export: own jar only
            assertThat(contentsOf(plug.getResources("root.txt"))).containsExactly("own-root");
            assertThat(contentOf(plug.getResource("com/plug/own.txt"))).isEqualTo("own2");
            // exported package of the second dependency is visible
            assertThat(contentsOf(plug.getResources("com/other/x.txt"))).containsExactly("other");
        }
    }

    // failure case: two dependencies export the same package
    @Test
    void duplicateExportResolvesInTopologicalOrderAndWarns() throws Exception {
        Path d1Jar = jarOf("t8-d1",
                Map.of("com.dup.Dup", classSource("com.dup", "Dup", "first")), Map.of());
        Path d2Jar = jarOf("t8-d2",
                Map.of("com.dup.Dup", classSource("com.dup", "Dup", "second")), Map.of());
        Logger log = (Logger) org.slf4j.LoggerFactory.getLogger(PluginClassLoader.class);
        ListAppender<ILoggingEvent> capture = new ListAppender<>();
        capture.start();
        log.addAppender(capture);
        try (PluginClassLoader d1 = loader("d1", d1Jar, List.of("com.dup"), List.of());
                PluginClassLoader d2 = loader("d2", d2Jar, List.of("com.dup"), List.of());
                PluginClassLoader plug = loader("plug", emptyJar("t8-plug"), List.of(), List.of(d1, d2))) {
            Class<?> resolved = plug.loadClass("com.dup.Dup");
            assertThat(markerOf(resolved)).isEqualTo("first");
            assertThat(resolved).isSameAs(d1.loadClass("com.dup.Dup"));
        } finally {
            log.detachAppender(capture);
        }
        List<ILoggingEvent> warns = capture.list.stream()
                .filter(event -> event.getLevel() == Level.WARN)
                .toList();
        assertThat(warns).hasSize(1);
        assertThat(warns.get(0).getFormattedMessage())
                .contains("com.dup")
                .contains("d1")
                .contains("d2");
    }

    @Test
    void closeIsIdempotent() throws Exception {
        PluginClassLoader plug = loader("plug", emptyJar("t9-plug"), List.of(), List.of());
        plug.close();
        assertThatCode(plug::close).doesNotThrowAnyException();
    }

    private static PluginClassLoader loader(String id, Path jar, List<String> exports,
            List<PluginClassLoader> deps) throws IOException {
        return new PluginClassLoader(id, new URL[] {jar.toUri().toURL()},
                PluginClassLoaderTest.class.getClassLoader(), exports, deps);
    }

    private static String classSource(String pkg, String simpleName, String marker) {
        return FixtureJars.classSource(pkg, simpleName, marker);
    }

    private static String markerOf(Class<?> type) throws ReflectiveOperationException {
        return (String) type.getMethod("marker").invoke(null);
    }

    private static String contentOf(URL url) throws IOException {
        try (InputStream in = url.openStream()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static List<String> contentsOf(java.util.Enumeration<URL> urls) throws IOException {
        List<String> texts = new ArrayList<>();
        for (URL url : Collections.list(urls)) {
            texts.add(contentOf(url));
        }
        return texts;
    }

    private static FixtureJars fixtures() {
        if (fixtures == null) {
            fixtures = new FixtureJars(work);
        }
        return fixtures;
    }

    private static Path emptyJar(String name) throws IOException {
        return fixtures().emptyJar(name);
    }

    private static Path jarOf(String name, Map<String, String> sources, Map<String, String> resources)
            throws IOException {
        return fixtures().jarOf(name, sources, resources);
    }
}
