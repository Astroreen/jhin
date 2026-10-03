package com.astroreen.jhin.kernel.loader;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.kernel.config.ConfigStore;
import com.astroreen.jhin.kernel.config.JhinHome;
import com.astroreen.jhin.kernel.db.Database;
import com.astroreen.jhin.kernel.http.HttpRegistryImpl;
import com.astroreen.jhin.kernel.services.ServiceRegistryImpl;
import com.astroreen.jhin.kernel.stream.StreamRegistryImpl;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The scheduler seam end to end: a fixture plugin schedules work through
 * {@code ctx.sched()} and the runs land, the cancel bookkeeping behaves and
 * the host shutdown stops the firings and terminates the executor. The
 * termination assertion polls with a generous test-only bound (the product
 * bound stays at 5 s) so a loaded machine cannot flake it — plan UNVERIFIED
 * #6.
 */
class PluginSchedulerWiringTest {

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

    // happy path: one-shot fires, periodic fires repeatedly, a throwing
    // periodic keeps its schedule, cancel is idempotent, shutdown stops
    // everything and terminates the executor
    @Test
    void pluginScheduledWorkRunsAndDiesWithTheHost() throws Exception {
        Path home = home("s-home");
        Path jar = schedJar("s-sched", "jhin.sched", "fixture.sched", "SchedPlugin");

        Database database = Database.open(envFor(home));
        PluginLifecycle lifecycle = new PluginLifecycle(home, ConfigStore.load(home), database,
                new ServiceRegistryImpl(), new HttpRegistryImpl(), new StreamRegistryImpl(),
                PluginSchedulerWiringTest.class.getClassLoader());
        try {
            PluginRegistry registry = lifecycle.load(candidates(jar));
            assertThat(registry.failures()).isEmpty();

            Path dir = home.resolve("data").resolve("jhin.sched");

            // the one-shot flips within 2 s
            await(() -> Files.exists(dir.resolve("oneshot.txt")), 2_000);
            assertThat(Files.readString(dir.resolve("oneshot.txt"))).isEqualTo("oneshot\n");

            // the periodic fires at least twice within 3 s
            await(() -> lines(dir.resolve("tick.txt")) >= 2, 3_000);

            // the throwing periodic keeps firing: the exception is swallowed
            await(() -> lines(dir.resolve("boom.txt")) >= 2, 3_000);

            // the cancel results recorded by the plugin: true, then false
            assertThat(Files.readString(dir.resolve("cancel.txt"))).isEqualTo("true\nfalse\n");

            int ticks = lines(dir.resolve("tick.txt"));

            lifecycle.shutdown();

            // the executor terminates after the host shutdown (generous poll)
            await(lifecycle.scheduler()::terminated, 10_000);
            assertThat(lifecycle.scheduler().terminated()).isTrue();

            // no new firings after the shutdown
            sleep(300);
            assertThat(lines(dir.resolve("tick.txt"))).isEqualTo(ticks);
        } finally {
            lifecycle.shutdown();
            database.close();
        }
    }

    /** Resolves a per-test home under the shared work dir. */
    private static Path home(String name) {
        return JhinHome.resolve(envFor(work.resolve(name)));
    }

    private static java.util.function.Function<String, String> envFor(Path home) {
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
     * Builds one fixture jar whose plugin schedules a one-shot, two periodics
     * (one of them throwing on every run) and one periodic it cancels right
     * away, recording the cancel results.
     */
    private static Path schedJar(String name, String id, String pkg, String cls)
            throws IOException {
        String source = "package " + pkg + ";\n"
                + "import com.astroreen.jhin.sdk.JhinPlugin;\n"
                + "import com.astroreen.jhin.sdk.PluginContext;\n"
                + "import com.astroreen.jhin.sdk.sched.TaskSpec;\n"
                + "import java.nio.file.Files;\n"
                + "import java.nio.file.Path;\n"
                + "import java.nio.file.StandardOpenOption;\n"
                + "public class " + cls + " implements JhinPlugin {\n"
                + "    public " + cls + "() {}\n"
                + "    @Override public void start(PluginContext ctx) {\n"
                + "        Path dir = ctx.dataDir();\n"
                + "        ctx.sched().schedule(TaskSpec.oneShot(\"oneshot\", 200,\n"
                + "                () -> append(dir.resolve(\"oneshot.txt\"), \"oneshot\")));\n"
                + "        ctx.sched().schedule(TaskSpec.periodic(\"tick\", 0, 100,\n"
                + "                () -> append(dir.resolve(\"tick.txt\"), \"tick\")));\n"
                + "        ctx.sched().schedule(TaskSpec.periodic(\"boom\", 0, 100, () -> {\n"
                + "            append(dir.resolve(\"boom.txt\"), \"boom\");\n"
                + "            throw new RuntimeException(\"deliberate\");\n"
                + "        }));\n"
                + "        ctx.sched().schedule(TaskSpec.periodic(\"retired\", 10_000, 100,\n"
                + "                () -> append(dir.resolve(\"retired.txt\"), \"retired\")));\n"
                + "        boolean first = ctx.sched().cancel(\"retired\");\n"
                + "        boolean second = ctx.sched().cancel(\"retired\");\n"
                + "        append(dir.resolve(\"cancel.txt\"), Boolean.toString(first));\n"
                + "        append(dir.resolve(\"cancel.txt\"), Boolean.toString(second));\n"
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
                Map.of(pkg + "." + cls, source),
                Map.of("jhin-plugin.json", manifest(id, pkg + "." + cls)));
    }

    private static String manifest(String id, String mainClass) {
        return "{\"id\":\"" + id + "\",\"version\":\"0.1.0\",\"apiVersion\":1,"
                + "\"name\":\"Fixture " + id + "\",\"description\":\"d\","
                + "\"mainClass\":\"" + mainClass + "\",\"exports\":[],\"requires\":[]}";
    }

    /** Counts the lines of one firing log file; absent means zero. */
    private static int lines(Path file) {
        try {
            return Files.readAllLines(file).size();
        } catch (IOException absent) {
            return 0;
        }
    }

    /** Polls the condition until it holds or the timeout passes. */
    private static void await(BooleanSupplier condition, long timeoutMillis) {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
        while (System.nanoTime() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            sleep(20);
        }
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
