package com.astroreen.jhin.core.plugins;

import com.astroreen.jhin.core.agent.SystemPromptBuilder;
import com.astroreen.jhin.core.agent.spi.PromptInterceptor;
import com.astroreen.jhin.core.llm.LlmProviderFactory;
import com.astroreen.jhin.core.llm.ProviderRegistry;
import com.astroreen.jhin.core.tools.ToolRegistry;
import com.astroreen.jhin.core.tools.spi.ToolCallGuard;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolProvider;
import com.astroreen.jhin.core.tools.spi.ToolResultTransformer;
import java.io.IOException;
import java.net.MalformedURLException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.ServiceConfigurationError;
import java.util.ServiceLoader;
import java.util.function.Consumer;
import java.util.zip.ZipException;
import java.util.zip.ZipFile;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Загрузка одного plugin-jar: {@link URLClassLoader} (parent = app classloader, стандартная
 * parent-delegation — плагины видят SPI-классы ядра) + {@link ServiceLoader} по 5 SPI
 * ({@link ToolProvider}, {@link ToolCallGuard}, {@link ToolResultTransformer},
 * {@link PromptInterceptor}, {@link LlmProviderFactory}) с регистрацией в реестры.
 *
 * <p>Изоляция ошибок (приложение не падает):
 * <ul>
 *   <li>битый jar (не zip) → ERROR + skip всего jar;</li>
 *   <li>битый META-INF/services (имя несуществующего класса, ошибка конструктора) → ERROR +
 *       skip одного провайдера, остальные реализации того же jar грузятся;</li>
 *   <li>jar без единой загруженной реализации → ERROR + skip.</li>
 * </ul>
 *
 * <p>Имена в {@link PluginManager.LoadedPlugin} — только реально загруженные: тул-имена,
 * прошедшие first-wins реестра, и форматы фабрик, не совпавшие с уже зарегистрированными.
 */
public final class PluginLoader {

    private static final Logger log = LoggerFactory.getLogger(PluginLoader.class);

    /** Предохранитель: больше подряд идущих битых записей ServiceLoader — прерываем скан SPI. */
    private static final int MAX_CONSECUTIVE_ERRORS = 32;

    private final ToolRegistry toolRegistry;
    private final ProviderRegistry providerRegistry;
    private final SystemPromptBuilder promptBuilder;

    public PluginLoader(
            ToolRegistry toolRegistry, ProviderRegistry providerRegistry, SystemPromptBuilder promptBuilder) {
        this.toolRegistry = Objects.requireNonNull(toolRegistry, "toolRegistry");
        this.providerRegistry = Objects.requireNonNull(providerRegistry, "providerRegistry");
        this.promptBuilder = Objects.requireNonNull(promptBuilder, "promptBuilder");
    }

    /**
     * Итог загрузки одного jar: открытый classloader (держится открытым всё время жизни процесса)
     * и сводка загруженных реализаций.
     */
    public record LoadedJar(URLClassLoader classLoader, PluginManager.LoadedPlugin plugin) {}

    /**
     * Загружает plugin-jar и регистрирует найденные реализации. Ошибки уровня jar/провайдера
     * логируются и пропускаются — метод не бросает исключений.
     *
     * @return пусто, если jar пропущен (битый или без единой загруженной реализации)
     */
    public Optional<LoadedJar> load(Path jar) {
        String jarName = jar.getFileName().toString();
        if (!isReadableZip(jar, jarName)) {
            return Optional.empty();
        }
        URLClassLoader classLoader;
        try {
            classLoader =
                    new URLClassLoader(new URL[] {jar.toUri().toURL()}, PluginLoader.class.getClassLoader());
        } catch (MalformedURLException | RuntimeException e) {
            log.error("Plugin jar {}: cannot create classloader — skipped: {}", jarName, e.toString());
            return Optional.empty();
        }
        try {
            List<String> tools = new ArrayList<>();
            List<String> guards = new ArrayList<>();
            List<String> transformers = new ArrayList<>();
            List<String> interceptors = new ArrayList<>();
            List<String> factories = new ArrayList<>();
            int loaded =
                    loadProviders(
                                    ToolProvider.class,
                                    classLoader,
                                    jarName,
                                    provider -> registerTools(provider, tools))
                            + loadProviders(
                                    ToolCallGuard.class,
                                    classLoader,
                                    jarName,
                                    guard -> {
                                        toolRegistry.register(guard);
                                        guards.add(guard.getClass().getName());
                                    })
                            + loadProviders(
                                    ToolResultTransformer.class,
                                    classLoader,
                                    jarName,
                                    transformer -> {
                                        toolRegistry.register(transformer);
                                        transformers.add(transformer.getClass().getName());
                                    })
                            + loadProviders(
                                    PromptInterceptor.class,
                                    classLoader,
                                    jarName,
                                    interceptor -> {
                                        promptBuilder.register(interceptor);
                                        interceptors.add(interceptor.getClass().getName());
                                    })
                            + loadProviders(
                                    LlmProviderFactory.class,
                                    classLoader,
                                    jarName,
                                    factory -> registerFactory(factory, factories));
            if (loaded == 0) {
                log.error("Plugin jar {}: no usable SPI implementations — skipped", jarName);
                closeQuietly(classLoader);
                return Optional.empty();
            }
            PluginManager.LoadedPlugin plugin =
                    new PluginManager.LoadedPlugin(jarName, tools, guards, transformers, interceptors, factories);
            return Optional.of(new LoadedJar(classLoader, plugin));
        } catch (Throwable t) {
            log.error("Plugin jar {}: load failed — skipped", jarName, t);
            closeQuietly(classLoader);
            return Optional.empty();
        }
    }

    /** Один вызов {@code tools()} на провайдера: снимок стабилизирует identity-учёт имён. */
    private void registerTools(ToolProvider provider, List<String> toolNames) {
        List<ToolDefinition> definitions = List.copyOf(provider.tools());
        toolRegistry.register(() -> definitions);
        for (ToolDefinition definition : definitions) {
            String name = definition.name();
            if (toolRegistry.find(name).filter(d -> d == definition).isPresent()) {
                toolNames.add(name);
            }
        }
    }

    private void registerFactory(LlmProviderFactory factory, List<String> formats) {
        String format = factory.format();
        boolean fresh = !providerRegistry.knownFormats().contains(format);
        providerRegistry.register(factory);
        if (fresh) {
            formats.add(format);
        }
    }

    /**
     * ServiceLoader-итерация по провайдерам одного SPI с изоляцией ошибок: {@link
     * ServiceConfigurationError} (битый META-INF/services, несуществующий класс) — skip одного
     * провайдера; любое другое падение итератора — прекращение скана этого SPI (итератор не
     * продвигается и может зациклиться). Возвращает число загруженных провайдеров.
     */
    private <T> int loadProviders(Class<T> spi, ClassLoader classLoader, String jarName, Consumer<T> registrar) {
        int loaded = 0;
        int consecutiveErrors = 0;
        Iterator<T> iterator = ServiceLoader.load(spi, classLoader).iterator();
        while (true) {
            T provider;
            try {
                if (!iterator.hasNext()) {
                    break;
                }
                provider = iterator.next();
                consecutiveErrors = 0;
            } catch (ServiceConfigurationError e) {
                log.error(
                        "Plugin jar {}: broken {} entry — skipped: {}",
                        jarName,
                        spi.getSimpleName(),
                        e.getMessage());
                if (++consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
                    log.error("Plugin jar {}: {} scan aborted — too many broken entries", jarName, spi.getSimpleName());
                    break;
                }
                continue;
            } catch (Throwable t) {
                log.error(
                        "Plugin jar {}: {} scan aborted — skipped: {}",
                        jarName,
                        spi.getSimpleName(),
                        t.toString());
                break;
            }
            try {
                registrar.accept(provider);
                loaded++;
            } catch (Throwable t) {
                log.error(
                        "Plugin jar {}: {} {} failed to register — skipped",
                        jarName,
                        spi.getSimpleName(),
                        provider.getClass().getName(),
                        t);
            }
        }
        return loaded;
    }

    /** Битый jar (не zip) → ERROR + skip: URLClassLoader молча отдаёт пустой ресурс-набор. */
    private static boolean isReadableZip(Path jar, String jarName) {
        try (ZipFile ignored = new ZipFile(jar.toFile())) {
            return true;
        } catch (ZipException e) {
            log.error("Plugin jar {}: not a valid jar file — skipped: {}", jarName, e.getMessage());
            return false;
        } catch (IOException | RuntimeException e) {
            log.error("Plugin jar {}: cannot read jar — skipped: {}", jarName, e.toString());
            return false;
        }
    }

    private static void closeQuietly(URLClassLoader classLoader) {
        try {
            classLoader.close();
        } catch (IOException | RuntimeException e) {
            log.warn("Cannot close plugin classloader: {}", e.toString());
        }
    }
}
