package com.astroreen.jhin.core.plugins;

import com.astroreen.jhin.core.agent.SystemPromptBuilder;
import com.astroreen.jhin.core.db.MigrationRunner;
import com.astroreen.jhin.core.llm.ProviderRegistry;
import com.astroreen.jhin.core.tools.ToolRegistry;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/**
 * Менеджер плагинов: на старте сканирует {@code ${jhin.home}/plugins/*.jar} (сортировка по имени
 * файла — детерминированный порядок загрузки), каждый jar грузится через {@link PluginLoader}.
 * Classloader'ы держатся открытыми всё время жизни процесса; {@link #close()} — best-effort
 * закрытие на shutdown.
 *
 * <p>Порядок ApplicationRunner'ов не гарантирован, поэтому перед загрузкой вызывается
 * {@link MigrationRunner#migrate()} (идемпотентно) — плагины грузятся после миграций/БД.
 * Порядок относительно McpService не важен: имя тула регистрируется один раз (первый
 * выигрывает; built-in зарегистрированы в конструкторе {@link ToolRegistry}).
 *
 * <p>Hot-reload не нужен: повторный {@link #loadAll()} пропускает уже загруженные jar'ы,
 * {@code /admin/reload} рестартует процесс (T24) и плагины перечитываются на старте.
 *
 * <p>Публичный API: {@link #loadedPlugins()}, {@link #loadAll()}, {@link #close()}.
 */
@Component
public class PluginManager implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(PluginManager.class);

    private final PluginLoader loader;
    private final MigrationRunner migrationRunner;
    private final Path pluginsDir;
    private final List<PluginLoader.LoadedJar> loaded = new CopyOnWriteArrayList<>();

    public PluginManager(
            ToolRegistry toolRegistry,
            ProviderRegistry providerRegistry,
            SystemPromptBuilder promptBuilder,
            MigrationRunner migrationRunner,
            @Value("${jhin.home}") String jhinHome) {
        this.loader = new PluginLoader(toolRegistry, providerRegistry, promptBuilder);
        this.migrationRunner = Objects.requireNonNull(migrationRunner, "migrationRunner");
        this.pluginsDir = Path.of(Objects.requireNonNull(jhinHome, "jhinHome")).resolve("plugins");
    }

    @Override
    public void run(ApplicationArguments args) {
        migrationRunner.migrate();
        loadAll();
    }

    /** Сканирует каталог plugins и загружает новые jar'ы. Пустой/отсутствующий каталог — норма. */
    public synchronized void loadAll() {
        if (!Files.isDirectory(pluginsDir)) {
            log.info("Plugins directory {} absent — no plugins", pluginsDir);
            return;
        }
        List<Path> jarFiles;
        try (Stream<Path> entries = Files.list(pluginsDir)) {
            jarFiles = entries
                    .filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().endsWith(".jar"))
                    .sorted(Comparator.comparing(path -> path.getFileName().toString()))
                    .toList();
        } catch (IOException e) {
            log.error("Cannot list plugins directory {} — no plugins: {}", pluginsDir, e.toString());
            return;
        }
        if (jarFiles.isEmpty()) {
            log.info("Plugins directory {} has no jars — no plugins", pluginsDir);
            return;
        }
        Set<String> alreadyLoaded =
                loaded.stream().map(jar -> jar.plugin().jarName()).collect(Collectors.toSet());
        for (Path jar : jarFiles) {
            String jarName = jar.getFileName().toString();
            if (alreadyLoaded.contains(jarName)) {
                log.info("Plugin jar {} already loaded — skipping", jarName);
                continue;
            }
            loader.load(jar).ifPresent(loaded::add);
        }
    }

    /** Сводки загруженных плагинов в детерминированном порядке загрузки (имя файла jar). */
    public synchronized List<LoadedPlugin> loadedPlugins() {
        return loaded.stream().map(PluginLoader.LoadedJar::plugin).toList();
    }

    /** Best-effort закрытие plugin-classloader'ов на shutdown. */
    @PreDestroy
    public synchronized void close() {
        for (PluginLoader.LoadedJar jar : loaded) {
            try {
                jar.classLoader().close();
            } catch (IOException | RuntimeException e) {
                log.warn("Cannot close plugin classloader for {}: {}", jar.plugin().jarName(), e.toString());
            }
        }
    }

    /**
     * Сводка одного загруженного плагина (пригодится T32 для /ui/manifest): имя jar и имена/
     * форматы реально загруженных реализаций строками. Для тулов — имена тулов, прошедших
     * first-wins реестра; для фабрик — форматы, не совпавшие с уже зарегистрированными.
     */
    public record LoadedPlugin(
            String jarName,
            List<String> tools,
            List<String> guards,
            List<String> transformers,
            List<String> interceptors,
            List<String> factories) {

        public LoadedPlugin {
            tools = List.copyOf(tools);
            guards = List.copyOf(guards);
            transformers = List.copyOf(transformers);
            interceptors = List.copyOf(interceptors);
            factories = List.copyOf(factories);
        }
    }
}
