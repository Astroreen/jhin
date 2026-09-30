/**
 * Drives the life of every plugin of one load pass: resolve, build the class
 * loader, instantiate, wire the context, start, isolate failures and stop.
 *
 * <p>The input is the parsed manifest of each candidate jar; the dependency
 * graph decides the order and rejects the broken candidates up front
 * (missing requirements, version mismatches, cycles). For every surviving
 * node, in order, the plugin's own {@link PluginClassLoader} is built, the
 * main class is instantiated through its public no-arg constructor and
 * {@code start(ctx)} runs with the plugin loader installed as the thread
 * context class loader (restored afterwards). Any {@link Throwable} from
 * instantiation or start fails exactly that plugin: the reason is recorded,
 * every non-optional dependant is cascade-failed with the reason
 * {@code dependency <id> failed}, and the loader is closed. Hooks registered
 * through the context are collected and run later: {@link #runStartedHooks()}
 * in load order once the host is up, and on {@link #shutdown()} first the
 * on-shutdown hooks (load order), then {@code stop()} in reverse load order,
 * then the loaders — every step guarded so one failure cannot abort the rest.
 */
package com.astroreen.jhin.kernel.loader;

import com.astroreen.jhin.kernel.KernelInfoImpl;
import com.astroreen.jhin.kernel.config.ConfigStore;
import com.astroreen.jhin.kernel.config.ConfigViewImpl;
import com.astroreen.jhin.kernel.db.Database;
import com.astroreen.jhin.kernel.db.DbAccessImpl;
import com.astroreen.jhin.kernel.db.MigrationBookkeeper;
import com.astroreen.jhin.kernel.http.HttpRegistryImpl;
import com.astroreen.jhin.kernel.services.ServiceRegistryImpl;
import com.astroreen.jhin.kernel.stream.StreamRegistryImpl;
import com.astroreen.jhin.sdk.JhinPlugin;
import com.astroreen.jhin.sdk.KernelInfo;
import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.PluginManifest;
import com.astroreen.jhin.sdk.cli.CliCommandSpec;
import com.astroreen.jhin.sdk.cli.CliRegistry;
import java.io.IOException;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.net.URL;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Function;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class PluginLifecycle {

    private static final Logger log = LoggerFactory.getLogger(PluginLifecycle.class);

    /** Owner-only permission bits applied to per-plugin data directories. */
    private static final Set<PosixFilePermission> OWNER_ONLY =
            PosixFilePermissions.fromString("rwx------");

    private final Path home;
    private final ConfigStore config;
    private final Database database;
    private final MigrationBookkeeper bookkeeper;
    private final ServiceRegistryImpl services;
    private final HttpRegistryImpl http;
    private final StreamRegistryImpl streams;
    private final ClassLoader kernelLoader;
    private final Function<PluginRegistry, KernelInfo> kernelInfoFactory;
    private final CommandBook commandBook = new CommandBook();

    /** Started plugins in load order. */
    private final List<Started> started = new ArrayList<>();

    /** On-started hooks of all started plugins, in load order. */
    private final List<Runnable> startedHooks = new ArrayList<>();

    /** Set once {@link #shutdown()} has run. */
    private boolean stopped;

    /**
     * Creates a lifecycle over the shared kernel pieces, with the kernel
     * facts of {@link KernelInfoImpl}.
     *
     * @param home        the installation root ({@code JHIN_HOME})
     * @param config      the parsed {@code config.json}
     * @param database    the shared SQLite file
     * @param services    the shared service registry
     * @param http        the shared HTTP registry
     * @param streams     the shared stream registry
     * @param kernelLoader the loader sharing the contract classes with plugins
     */
    public PluginLifecycle(Path home, ConfigStore config, Database database,
            ServiceRegistryImpl services, HttpRegistryImpl http, StreamRegistryImpl streams,
            ClassLoader kernelLoader) {
        this(home, config, database, services, http, streams, kernelLoader, null);
    }

    /**
     * Creates a lifecycle over the shared kernel pieces. The factory is the * seam through which the boot sequence supplies the kernel facts
     * ({@link KernelInfoImpl}): it receives the registry of the load pass, so * {@link KernelInfo#plugins()} can report the started plugins as * they come.
     *
     * @param home             the installation root ({@code JHIN_HOME})
     * @param config           the parsed {@code config.json}
     * @param database         the shared SQLite file
     * @param services         the shared service registry
     * @param http             the shared HTTP registry
     * @param streams          the shared stream registry
     * @param kernelLoader     the loader sharing the contract classes with plugins
     * @param kernelInfoFactory builds the kernel facts for every context, or
     *                         {@code null} for {@link KernelInfoImpl}
     */
    public PluginLifecycle(Path home, ConfigStore config, Database database,
            ServiceRegistryImpl services, HttpRegistryImpl http, StreamRegistryImpl streams,
            ClassLoader kernelLoader, Function<PluginRegistry, KernelInfo> kernelInfoFactory) {
        this.home = Objects.requireNonNull(home, "home");
        this.config = Objects.requireNonNull(config, "config");
        this.database = Objects.requireNonNull(database, "database");
        this.bookkeeper = new MigrationBookkeeper(database);
        this.services = Objects.requireNonNull(services, "services");
        this.http = Objects.requireNonNull(http, "http");
        this.streams = Objects.requireNonNull(streams, "streams");
        this.kernelLoader = Objects.requireNonNull(kernelLoader, "kernelLoader");
        this.kernelInfoFactory = (kernelInfoFactory != null)
                ? kernelInfoFactory : registry -> new KernelInfoImpl(home, registry);
    }

    /**
     * Starts every candidate plugin. The dependency graph decides the order
     * and rejects broken candidates first; each surviving plugin is then
     * instantiated and started in isolation, so one failure cannot prevent
     * the others from starting.
     *
     * @param candidates the accepted manifests with their jars, in any order
     * @return the catalog of started and rejected plugins
     */
    public PluginRegistry load(List<ManifestParser.Candidate> candidates) {
        Objects.requireNonNull(candidates, "candidates");
        PluginRegistry registry = new PluginRegistry();
        KernelInfo kernelInfo = kernelInfoFactory.apply(registry);

        Map<String, ManifestParser.Candidate> byId = new LinkedHashMap<>();
        for (ManifestParser.Candidate candidate : candidates) {
            Objects.requireNonNull(candidate, "candidate");
            byId.put(candidate.manifest().id(), candidate);
        }
        List<DependencyGraph.Node> nodes = candidates.stream()
                .map(candidate -> new DependencyGraph.Node(candidate.manifest()))
                .toList();
        DependencyGraph.Result result = DependencyGraph.resolve(nodes);

        Set<String> failedIds = new HashSet<>();
        for (DependencyGraph.Failure failure : result.failed()) {
            registry.addFailed(failure.id(), failure.reason());
            failedIds.add(failure.id());
        }

        Map<String, Integer> loadIndex = new HashMap<>();
        List<DependencyGraph.Node> ordered = result.ordered();
        for (int i = 0; i < ordered.size(); i++) {
            loadIndex.put(ordered.get(i).id(), i);
        }

        Map<String, PluginClassLoader> loaders = new HashMap<>();
        for (DependencyGraph.Node node : ordered) {
            String id = node.id();
            String cascade = cascadeReason(node, failedIds);
            if (cascade != null) {
                registry.addFailed(id, cascade);
                failedIds.add(id);
                log.error("plugin {} skipped: {}", id, cascade);
                continue;
            }
            PluginClassLoader loader = null;
            try {
                ManifestParser.Candidate candidate = byId.get(id);
                loader = buildLoader(node, candidate.jar(), loaders, loadIndex);
                Started entry = startPlugin(node, loader, kernelInfo);
                loaders.put(id, loader);
                started.add(entry);
                startedHooks.addAll(entry.contextHooks());
                List<String> exports = node.manifest().exports() == null
                        ? List.of() : node.manifest().exports();
                registry.addLoaded(new KernelInfo.Loaded(id, node.version(),
                        node.manifest().name(), exports));
            } catch (Throwable failure) {
                String reason = reasonOf(failure);
                registry.addFailed(id, reason);
                failedIds.add(id);
                log.error("plugin {} failed: {}", id, reason);
                if (loader != null) {
                    closeQuietly(loader, id);
                }
            }
        }
        return registry;
    }

    /**
     * Runs the on-started hooks in load order. Called once the host is fully
     * up; every hook is guarded so one failure cannot skip the rest.
     */
    public void runStartedHooks() {
        for (Runnable hook : List.copyOf(startedHooks)) {
            try {
                hook.run();
            } catch (Throwable failure) {
                log.warn("on-started hook failed: {}", reasonOf(failure), failure);
            }
        }
    }

    /**
     * The CLI commands registered by the started plugins, in registration * order, each with its owning plugin. Called by the CLI dispatch path.
     *
     * @return the registered commands
     */
    public List<CommandEntry> commands() {
        return commandBook.commands();
    }

    /**
     * Stops everything this lifecycle owns: the on-shutdown hooks in load * order, then {@link JhinPlugin#stop()} in reverse load order, then the
     * class loaders in reverse load order. Every step is guarded so one * failure cannot abort the rest. Idempotent.
     */
    public void shutdown() {
        synchronized (started) {
            if (stopped) {
                return;
            }
            stopped = true;
        }
        for (Started entry : started) {
            for (Runnable hook : entry.shutdownHooks()) {
                try {
                    hook.run();
                } catch (Throwable failure) {
                    log.warn("on-shutdown hook of {} failed: {}",
                            entry.id(), reasonOf(failure), failure);
                }
            }
        }
        for (int i = started.size() - 1; i >= 0; i--) {
            Started entry = started.get(i);
            try {
                entry.plugin().stop();
            } catch (Throwable failure) {
                log.warn("stop of {} failed: {}", entry.id(), reasonOf(failure), failure);
            }
        }
        for (int i = started.size() - 1; i >= 0; i--) {
            closeQuietly(started.get(i).loader(), started.get(i).id());
        }
    }

    /**
     * Builds the class loader of one plugin: its jar plus the loaders of the * requirements that started, in topological order.
     */
    private PluginClassLoader buildLoader(DependencyGraph.Node node, Path jar,
            Map<String, PluginClassLoader> loaders, Map<String, Integer> loadIndex) throws IOException {
        List<PluginClassLoader> deps = new ArrayList<>();
        node.requires().stream()
                .map(requirement -> loaders.get(requirement.id()))
                .filter(Objects::nonNull)
                .sorted(Comparator.comparingInt(dep -> loadIndex.get(dep.pluginId())))
                .forEach(deps::add);
        return new PluginClassLoader(node.id(), new URL[] {jar.toUri().toURL()},
                kernelLoader, node.manifest().exports(), deps);
    }

    /**
     * Instantiates one plugin and runs its {@code start} with the plugin * loader as the thread context class loader. Any failure propagates to the
     * caller, which isolates it to this plugin.
     */
    private Started startPlugin(DependencyGraph.Node node, PluginClassLoader loader,
            KernelInfo kernelInfo) throws Exception {
        PluginManifest manifest = node.manifest();
        String id = manifest.id();
        Class<?> main = Class.forName(manifest.mainClass(), true, loader);
        if (!JhinPlugin.class.isAssignableFrom(main)) {
            throw new PluginException("main class " + manifest.mainClass()
                    + " does not implement JhinPlugin");
        }
        JhinPlugin plugin = instantiate(main);
        Path dataDir = createDataDir(id);
        PluginContextImpl context = new PluginContextImpl(manifest,
                LoggerFactory.getLogger("plugin." + id),
                dataDir,
                new ConfigViewImpl(id, config.section(id)),
                services, http,
                new DbAccessImpl(id, database, bookkeeper),
                streams, commandBook,
                kernelInfo);
        ClassLoader previous = Thread.currentThread().getContextClassLoader();
        Thread.currentThread().setContextClassLoader(loader);
        try {
            plugin.start(context);
        } finally {
            Thread.currentThread().setContextClassLoader(previous);
        }
        return new Started(id, plugin, loader,
                context.startedHooks(), context.shutdownHooks());
    }

    /**
     * Instantiates the main class through its public no-arg constructor; the * absence of one is a failure naming the class.
     */
    private static JhinPlugin instantiate(Class<?> main) {
        Constructor<?> constructor;
        try {
            constructor = main.getConstructor();
        } catch (NoSuchMethodException absent) {
            throw new PluginException("main class " + main.getName()
                    + " has no public no-arg constructor");
        }
        try {
            return (JhinPlugin) constructor.newInstance();
        } catch (ReflectiveOperationException e) {
            throw new PluginException("main class " + main.getName()
                    + " cannot be instantiated: " + reasonOf(e), e);
        }
    }

    /**
     * Creates {@code JHIN_HOME/data/<id>} with owner-only permissions where
     * the file store supports them.
     */
    private Path createDataDir(String pluginId) {
        Path dir = home.resolve("data").resolve(pluginId);
        try {
            Files.createDirectories(dir);
        } catch (IOException e) {
            throw new PluginException("cannot create data directory " + dir, e);
        }
        if (!FileSystems.getDefault().supportedFileAttributeViews().contains("posix")) {
            return dir;
        }
        try {
            Files.setPosixFilePermissions(dir, OWNER_ONLY);
        } catch (UnsupportedOperationException | IOException e) {
            // Permission bits are best effort; never fail the layout on them.
        }
        return dir;
    }

    /**
     * The cascade reason of a node whose non-optional requirement already * failed: {@code dependency <id> failed} naming the first failing
     * requirement in declaration order, the same text the dependency graph * uses. {@code null} when the node may still start.
     */
    private static String cascadeReason(DependencyGraph.Node node, Set<String> failedIds) {
        for (PluginManifest.Requirement requirement : node.requires()) {
            if (!requirement.optional() && failedIds.contains(requirement.id())) {
                return "dependency " + requirement.id() + " failed";
            }
        }
        return null;
    }

    /**
     * The reason recorded for one failure: the deepest cause's detail text,
     * or its class name when it carries none.
     */
    private static String reasonOf(Throwable failure) {
        Throwable cause = failure;
        while (cause instanceof InvocationTargetException && cause.getCause() != null) {
            cause = cause.getCause();
        }
        String text = cause.getMessage();
        return (text == null || text.isBlank()) ? cause.getClass().getName() : text;
    }

    /** Closes one loader, logging and swallowing close failures. */
    private static void closeQuietly(PluginClassLoader loader, String pluginId) {
        try {
            loader.close();
        } catch (IOException e) {
            log.warn("closing loader of {} failed: {}", pluginId, reasonOf(e), e);
        }
    }

    /**
     * One started plugin together with what its context collected.
     *
     * @param id            the plugin id
     * @param plugin        the plugin instance
     * @param loader        the plugin's class loader
     * @param contextHooks  the on-started hooks, in registration order
     * @param shutdownHooks the on-shutdown hooks, in registration order
     */
    private record Started(String id, JhinPlugin plugin, PluginClassLoader loader,
            List<Runnable> contextHooks, List<Runnable> shutdownHooks) {}

    /**
     * One registered CLI command together with its owning plugin.
     *
     * @param pluginId the id of the registering plugin
     * @param spec     the command specification
     */
    public record CommandEntry(String pluginId, CliCommandSpec spec) {}

    /**
     * The shared CLI command book: every command of every plugin, tagged with
     * the registering plugin the same way the HTTP and service registries tag
     * their entries. Duplicate command names are refused naming the owner.
     */
    public static final class CommandBook implements CliRegistry {

        /** Attribution used for commands registered outside {@link #attributedTo}. */
        public static final String HOST_OWNER = "kernel";

        /** Owner id of the registration block running on this thread. */
        private final ThreadLocal<String> currentOwner = new ThreadLocal<>();

        /** Command name to its single registration. */
        private final Map<String, CommandEntry> byName = new LinkedHashMap<>();

        /**
         * Runs {@code action} with {@code pluginId} recorded as the owner of
         * every command the action registers. The previous attribution is
         * restored afterwards.
         *
         * @param pluginId id recorded for commands registered inside {@code action}
         * @param action   the registration block to run
         */
        public void attributedTo(String pluginId, Runnable action) {
            Objects.requireNonNull(pluginId, "pluginId");
            Objects.requireNonNull(action, "action");
            String previous = currentOwner.get();
            currentOwner.set(pluginId);
            try {
                action.run();
            } finally {
                if (previous == null) {
                    currentOwner.remove();
                } else {
                    currentOwner.set(previous);
                }
            }
        }

        /**
         * Registers one command on behalf of the currently attributed plugin.
         *
         * @param spec the command to register
         * @throws PluginException when the command name is already registered
         */
        @Override
        public void command(CliCommandSpec spec) {
            Objects.requireNonNull(spec, "spec");
            CommandEntry entry = new CommandEntry(owner(), spec);
            synchronized (byName) {
                CommandEntry existing = byName.get(spec.name());
                if (existing != null) {
                    throw new PluginException("cli conflict: command " + spec.name()
                            + " already registered by " + existing.pluginId());
                }
                byName.put(spec.name(), entry);
            }
        }

        /**
         * The registered commands, in registration order.
         *
         * @return the commands with their owners
         */
        public List<CommandEntry> commands() {
            synchronized (byName) {
                return List.copyOf(byName.values());
            }
        }

        private String owner() {
            String owner = currentOwner.get();
            return owner == null ? HOST_OWNER : owner;
        }
    }
}
