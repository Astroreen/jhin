/**
 * Test double of {@link com.astroreen.jhin.sdk.PluginContext} driving the real
 * {@link ExamplePlugin}: records the registered routes, CLI commands and
 * migrations, the published services and the on-started hooks. The database
 * fake records migration SQL and work units without executing them (the real
 * SQL path is covered by the QA script against a live SQLite file). Unused
 * parts throw.
 */
package com.astroreen.jhin.plugin.example;

import com.astroreen.jhin.sdk.ApiVersion;
import com.astroreen.jhin.sdk.ConfigView;
import com.astroreen.jhin.sdk.KernelInfo;
import com.astroreen.jhin.sdk.PluginContext;
import com.astroreen.jhin.sdk.PluginManifest;
import com.astroreen.jhin.sdk.ServiceRegistry;
import com.astroreen.jhin.sdk.cli.CliCommandSpec;
import com.astroreen.jhin.sdk.cli.CliRegistry;
import com.astroreen.jhin.sdk.db.DbAccess;
import com.astroreen.jhin.sdk.db.MigrationSpec;
import com.astroreen.jhin.sdk.db.SqlWork;
import com.astroreen.jhin.sdk.http.HttpRegistry;
import com.astroreen.jhin.sdk.http.RouteSpec;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class FakePluginContext implements PluginContext {

    private final Logger log = LoggerFactory.getLogger("jhin.example");
    private final List<RouteSpec> routes = new ArrayList<>();
    private final List<CliCommandSpec> commands = new ArrayList<>();
    private final List<MigrationSpec> migrations = new ArrayList<>();
    private final List<Runnable> startedHooks = new ArrayList<>();
    private final FakeServices services = new FakeServices();
    private final RecordingStreamRegistry streams = new RecordingStreamRegistry();

    @Override
    public PluginManifest manifest() {
        return new PluginManifest("jhin.example", "0.2.0", ApiVersion.CURRENT, "Example", "test",
                ExamplePlugin.class.getName(), List.of(), List.of());
    }

    @Override
    public Logger log() {
        return log;
    }

    @Override
    public Path dataDir() {
        return Path.of("build").resolve("tmp").resolve("jhin.example");
    }

    @Override
    public ConfigView config() {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public ServiceRegistry services() {
        return services;
    }

    @Override
    public HttpRegistry http() {
        return new HttpRegistry() {
            @Override
            public void route(RouteSpec spec) {
                routes.add(spec);
            }

            @Override
            public void filter(com.astroreen.jhin.sdk.http.FilterSpec spec) {
                throw new UnsupportedOperationException("not under test");
            }

            @Override
            public void tls(com.astroreen.jhin.sdk.http.TlsProvider provider) {
                throw new UnsupportedOperationException("not under test");
            }
        };
    }

    @Override
    public DbAccess db() {
        return new DbAccess() {
            @Override
            public void migrate(List<MigrationSpec> specs) {
                migrations.addAll(specs);
            }

            @Override
            public <R> R read(SqlWork<R> work) {
                throw new UnsupportedOperationException("not under test");
            }

            @Override
            public <R> R write(SqlWork<R> work) {
                return null;
            }

            @Override
            public String tablePrefix() {
                return "jhin_example_";
            }
        };
    }

    @Override
    public RecordingStreamRegistry streams() {
        return streams;
    }

    @Override
    public CliRegistry cli() {
        return new CliRegistry() {
            @Override
            public void command(CliCommandSpec spec) {
                commands.add(spec);
            }
        };
    }

    @Override
    public KernelInfo kernel() {
        throw new UnsupportedOperationException("not under test");
    }

    @Override
    public void onStarted(Runnable hook) {
        startedHooks.add(hook);
    }

    @Override
    public void onShutdown(Runnable hook) {
        throw new UnsupportedOperationException("not under test");
    }

    List<RouteSpec> routes() {
        return List.copyOf(routes);
    }

    List<CliCommandSpec> commands() {
        return List.copyOf(commands);
    }

    List<MigrationSpec> migrations() {
        return List.copyOf(migrations);
    }

    void fireStarted() {
        for (Runnable hook : List.copyOf(startedHooks)) {
            hook.run();
        }
    }

    <T> T published(Class<T> type) {
        List<T> all = services.findAll(type);
        return all.isEmpty() ? null : all.get(0);
    }

    /** Recording registry: keeps every publish in order. */
    private static final class FakeServices implements ServiceRegistry {

        private final Map<Class<?>, List<Object>> published = new LinkedHashMap<>();

        @Override
        public <T> void publish(Class<T> type, T instance) {
            published.computeIfAbsent(type, key -> new ArrayList<>()).add(instance);
        }

        @Override
        public <T> void publish(Class<T> type, String qualifier, T instance) {
            publish(type, instance);
        }

        @Override
        public <T> Optional<T> find(Class<T> type) {
            List<T> all = findAll(type);
            return all.isEmpty() ? Optional.empty() : Optional.of(all.get(0));
        }

        @Override
        public <T> Optional<T> find(Class<T> type, String qualifier) {
            return find(type);
        }

        @Override
        @SuppressWarnings("unchecked")
        public <T> List<T> findAll(Class<T> type) {
            List<Object> all = published.getOrDefault(type, List.of());
            return (List<T>) all;
        }
    }
}
