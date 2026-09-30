/**
 * The boot sequence of the kernel: home layout, configuration, database,
 * bundled seeding, plugin load, the security checks and the web listener, in
 * that order.
 *
 * <p>Steps follow the plan exactly: (1) resolve {@code JHIN_HOME} and its
 * owner-only subdirectories, (2) load {@code config.json} and build the
 * kernel's own configuration view from the {@code kernel} section, (3) open
 * the shared SQLite file and its write queue, (4) apply the kernel
 * migrations, (5) seed the bundled plugins, (6) scan {@code plugins/*.jar}
 * and parse their manifests, (7) start every plugin in dependency order with
 * failures isolated and cascade-skipped, (8) check TLS material and filters,
 * warning verbatim when nothing guards the listener, (9) start the web server
 * on the configured address and port with the collected registries supplied
 * as pre-built singletons, (10) run the on-started hooks and, on shutdown,
 * stop everything in reverse order. The command-line path runs the same
 * sequence minus the web listener.
 *
 * <p>The instance is created by {@link #open()}, which covers steps 1–7 and
 * fails fatally when the home layout cannot be materialized. {@link #serve}
 * covers steps 8–10; {@link #close()} drives the graceful shutdown of step
 * 10 and is idempotent.
 */
package com.astroreen.jhin.kernel;

import com.astroreen.jhin.kernel.config.ConfigStore;
import com.astroreen.jhin.kernel.config.ConfigViewImpl;
import com.astroreen.jhin.kernel.config.JhinHome;
import com.astroreen.jhin.kernel.db.Database;
import com.astroreen.jhin.kernel.http.HttpRegistryImpl;
import com.astroreen.jhin.kernel.loader.ManifestParser;
import com.astroreen.jhin.kernel.loader.PluginLifecycle;
import com.astroreen.jhin.kernel.loader.PluginRegistry;
import com.astroreen.jhin.kernel.loader.PluginScanner;
import com.astroreen.jhin.kernel.seed.BundledPluginSeeder;
import com.astroreen.jhin.kernel.services.ServiceRegistryImpl;
import com.astroreen.jhin.kernel.stream.StreamRegistryImpl;
import com.astroreen.jhin.sdk.ConfigView;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;

public final class KernelBoot implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(KernelBoot.class);

    /** Address the listener binds to when nothing configures it. */
    private static final String DEFAULT_ADDRESS = "0.0.0.0";

    /** Port the listener binds to when nothing configures it. */
    private static final int DEFAULT_PORT = 8443;

    /** The boot driving the application context, if any is running. */
    private static volatile KernelBoot active;

    private final ConfigView kernelConfig;
    private final Database database;
    private final HttpRegistryImpl http;
    private final StreamRegistryImpl streams;
    private final PluginLifecycle lifecycle;

    /** Catalog of the current load pass, live behind the health fallbacks. */
    private volatile PluginRegistry plugins;

    /** Set once {@link #close()} has run. */
    private boolean closed;

    private KernelBoot(ConfigView kernelConfig, Database database,
            HttpRegistryImpl http, StreamRegistryImpl streams, PluginLifecycle lifecycle) {
        this.kernelConfig = kernelConfig;
        this.database = database;
        this.http = http;
        this.streams = streams;
        this.lifecycle = lifecycle;
    }

    /**
     * Runs boot steps 1–7: the home layout, the configuration, the database
     * with its kernel migrations, the bundled seeding and the isolated plugin
     * load. A failure of the layout, the configuration or the database is
     * fatal; a failed plugin is not.
     *
     * @return the finished boot, ready for the listener or the dispatch
     */
    public static KernelBoot open() {
        Path home = JhinHome.resolve();
        ConfigStore config = ConfigStore.load(home);
        ConfigView kernelConfig = new ConfigViewImpl("kernel", config.section("kernel"));
        Database database = Database.open();
        new BundledPluginSeeder(database).seed();
        ServiceRegistryImpl services = new ServiceRegistryImpl();
        HttpRegistryImpl http = new HttpRegistryImpl();
        StreamRegistryImpl streams = new StreamRegistryImpl();
        PluginLifecycle lifecycle = new PluginLifecycle(home, config, database,
                services, http, streams, KernelBoot.class.getClassLoader(),
                registry -> new KernelInfoImpl(home, registry));
        KernelBoot boot = new KernelBoot(kernelConfig, database, http, streams, lifecycle);
        KernelRoutes.install(http, boot.catalog());
        boot.plugins = lifecycle.load(candidates(home));
        boot.reportLoad();
        return boot;
    }

    /**
     * The boot driving the application context. Read by the Spring wiring to
     * hand the web server its pre-built singletons; {@code null} while no
     * boot runs (tests build their own instances).
     *
     * @return the active boot, or {@code null} outside the server path
     */
    public static KernelBoot active() {
        return active;
    }

    /**
     * Runs boot steps 8–10: the TLS and filter checks, the web listener on
     * the configured address and port, and the on-started hooks once the
     * listener is up. The graceful shutdown of step 10 is wired to the JVM
     * before the listener starts.
     *
     * @param args the command-line arguments passed on to the web server
     */
    public void serve(String[] args) {
        Objects.requireNonNull(args, "args");
        active = this;
        String address = effectiveAddress(args);
        int port = effectivePort(args);
        if (http.acceptedTls().isEmpty()) {
            log.info("no TLS material registered; the listener speaks plain HTTP");
        }
        if (http.filterPipeline().isEmpty()) {
            log.warn("SECURITY: no HTTP filter registered — this server is fully open on "
                    + address + ":" + port + ". Install a security plugin.");
        }
        Runtime.getRuntime().addShutdownHook(new Thread(this::close, "jhin-shutdown"));
        SpringApplication application = new SpringApplication(KernelMain.class);
        Map<String, Object> defaults = new LinkedHashMap<>();
        defaults.put("server.address", address);
        defaults.put("server.port", Integer.toString(port));
        application.setDefaultProperties(defaults);
        application.run(args);
        lifecycle.runStartedHooks();
    }

    /**
     * Runs the on-started hooks in load order. Called by the command-line
     * path after the load and by the server path once the listener is up.
     */
    public void runStartedHooks() {
        lifecycle.runStartedHooks();
    }

    /**
     * The CLI commands of the started plugins, in registration order. Read by
     * the command-line dispatch.
     *
     * @return the registered commands with their owners
     */
    public List<PluginLifecycle.CommandEntry> commands() {
        return lifecycle.commands();
    }

    /**
     * The HTTP registry filled during the load. Served to the application
     * context as a pre-built singleton.
     *
     * @return the shared HTTP registry
     */
    public HttpRegistryImpl http() {
        return http;
    }

    /**
     * The stream registry filled during the load. Served to the application
     * context as a pre-built singleton.
     *
     * @return the shared stream registry
     */
    public StreamRegistryImpl streams() {
        return streams;
    }

    /**
     * Closes everything this boot owns in the shutdown order of step 10: the
     * plugin life cycle (on-shutdown hooks, {@code stop()} and the class
     * loaders), the stream registry, then the database with its write queue.
     * Idempotent.
     */
    @Override
    public void close() {
        synchronized (this) {
            if (closed) {
                return;
            }
            closed = true;
        }
        lifecycle.shutdown();
        streams.close();
        database.close();
    }

    /** The catalog behind the health fallbacks: the live registry once set. */
    private KernelRoutes.PluginCatalog catalog() {
        return new KernelRoutes.PluginCatalog() {

            @Override
            public List<Map<String, Object>> loaded() {
                PluginRegistry current = plugins;
                return (current == null) ? List.of() : current.loaded();
            }

            @Override
            public List<Map<String, Object>> failed() {
                PluginRegistry current = plugins;
                return (current == null) ? List.of() : current.failed();
            }
        };
    }

    /** Step 6: the accepted candidates of {@code plugins/*.jar}, in scan order. */
    private static List<ManifestParser.Candidate> candidates(Path home) {
        PluginScanner scanner = new PluginScanner(home.resolve("plugins"));
        return new ManifestParser().parseAll(scanner.scan());
    }

    /** One report of everything the load skipped, at the end of step 7. */
    private void reportLoad() {
        List<PluginRegistry.Failure> failures = plugins.failures();
        if (failures.isEmpty()) {
            return;
        }
        StringBuilder reasons = new StringBuilder();
        for (PluginRegistry.Failure failure : failures) {
            if (reasons.length() > 0) {
                reasons.append("; ");
            }
            reasons.append(failure.id()).append(": ").append(failure.reason());
        }
        log.error("plugin load finished with {} failed: {}",
                failures.size(), reasons);
    }

    /** The listener address: the kernel configuration, overridden by the arguments. */
    private String effectiveAddress(String[] args) {
        String address = kernelConfig.get("address", DEFAULT_ADDRESS);
        for (int i = 0; i < args.length; i++) {
            String arg = args[i];
            if (arg.startsWith("--server.address=")) {
                address = arg.substring("--server.address=".length());
            } else if (arg.equals("--server.address") && i + 1 < args.length) {
                address = args[i + 1];
            }
        }
        return address;
    }

    /** The listener port: the kernel configuration, overridden by the arguments. */
    private int effectivePort(String[] args) {
        int port = kernelConfig.getInt("port", DEFAULT_PORT);
        for (int i = 0; i < args.length; i++) {
            String arg = args[i];
            String value = null;
            if (arg.startsWith("--server.port=")) {
                value = arg.substring("--server.port=".length());
            } else if (arg.equals("--server.port") && i + 1 < args.length) {
                value = args[i + 1];
            }
            if (value != null) {
                try {
                    port = Integer.parseInt(value);
                } catch (NumberFormatException ignored) {
                    // A malformed override keeps the configured port.
                }
            }
        }
        return port;
    }
}
