package com.astroreen.jhin.core.agent;

import com.astroreen.jhin.core.agent.spi.PluginVetoException;
import com.astroreen.jhin.core.agent.spi.PromptContext;
import com.astroreen.jhin.core.agent.spi.PromptInterceptor;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import org.springframework.stereotype.Service;

/**
 * Сборка system prompt для одного run'а.
 *
 * <p>Порядок сборки:
 * <ol>
 *   <li>база — classpath-ресурс {@code prompts/base-prompt.md} (UTF-8);</li>
 *   <li>секция на каждый тул (стабильный порядок: сортировка по {@code name()}):
 *   {@code \n## {name}\n{promptSnippet}\nGuidelines:\n- {guideline}\n- {guideline}...};
 *   блок {@code Guidelines} пропускается, если список пуст;</li>
 *   <li>если {@code {workdir}/AGENTS.md} существует — {@code \n## Project Instructions
 *   (AGENTS.md)\n} + его полное содержимое (UTF-8). Отсутствие файла — молча пропускаем.
 *   Слишком большой файл (&gt; 100_000 символов) — трункация на границе строки + маркер
 *   {@code \n... [truncated]} (если перевод строки в лимите не найден — жёсткий срез по
 *   лимиту);</li>
 *   <li>упаковка в {@link PromptContext};</li>
 *   <li>каждый {@link PromptInterceptor} строго последним шагом, в порядке списка:
 *   {@code ctx = interceptor.intercept(ctx)}.</li>
 * </ol>
 *
 * <p>Вето: {@link PluginVetoException} от интерцептора пробрасывается вызывающему — run
 * прерывается (агент-цикл T20 отобразит это как error-событие). RuntimeException от
 * сломанного интерцептора пробрасывается как есть — сломанный плагин должен быть видимой
 * ошибкой, не глушится. Возврат {@code null} из интерцептора трактуется как вето
 * {@code PluginVetoException("interceptor returned null")} (защита от сломанного плагина).
 *
 * <p>Spring инжектит {@code List<PromptInterceptor>} в порядке {@code @Order}; тот же
 * публичный конструктор используется тестами напрямую.
 */
@Service
public class SystemPromptBuilder {

    /** Лимит символов содержимого AGENTS.md; больше — трункация на границе строки. */
    static final int AGENTS_MD_LIMIT = 100_000;

    private static final String BASE_PROMPT_RESOURCE = "/prompts/base-prompt.md";
    private static final String TRUNCATION_MARKER = "\n... [truncated]";

    private final List<PromptInterceptor> interceptors;

    public SystemPromptBuilder(List<PromptInterceptor> interceptors) {
        this.interceptors = List.copyOf(interceptors);
    }

    /**
     * Собирает system prompt и прогоняет цепочку интерцепторов (последний шаг).
     *
     * @param workdir рабочая директория сессии (здесь же ищется AGENTS.md)
     * @param sessionId идентификатор сессии
     * @param runId идентификатор run'а (nullable)
     * @param tools доступные тулы — секции в порядке сортировки по имени
     * @return финальный контекст после всех интерцепторов
     * @throws PluginVetoException вето плагина (или null-ответ интерцептора)
     */
    public PromptContext build(String workdir, String sessionId, String runId, List<ToolDefinition> tools)
            throws PluginVetoException {
        StringBuilder text = new StringBuilder(loadBasePrompt());
        tools.stream()
                .sorted(Comparator.comparing(ToolDefinition::name))
                .forEach(tool -> appendToolSection(text, tool));
        appendProjectInstructions(text, workdir);

        PromptContext ctx = new PromptContext(workdir, sessionId, runId, text.toString());
        for (PromptInterceptor interceptor : interceptors) {
            ctx = interceptor.intercept(ctx);
            if (ctx == null) {
                throw new PluginVetoException("interceptor returned null");
            }
        }
        return ctx;
    }

    private static void appendToolSection(StringBuilder text, ToolDefinition tool) {
        text.append("\n## ").append(tool.name()).append('\n').append(tool.promptSnippet());
        List<String> guidelines = tool.promptGuidelines();
        if (guidelines != null && !guidelines.isEmpty()) {
            text.append("\nGuidelines:\n");
            for (int i = 0; i < guidelines.size(); i++) {
                if (i > 0) {
                    text.append('\n');
                }
                text.append("- ").append(guidelines.get(i));
            }
        }
    }

    private static void appendProjectInstructions(StringBuilder text, String workdir) {
        Path agents = Path.of(workdir, "AGENTS.md");
        if (!Files.isRegularFile(agents)) {
            return;
        }
        String content;
        try {
            content = Files.readString(agents, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        text.append("\n## Project Instructions (AGENTS.md)\n").append(truncate(content));
    }

    /** Слишком большой AGENTS.md: срез на границе строки + маркер; без границы — жёсткий срез. */
    private static String truncate(String content) {
        if (content.length() <= AGENTS_MD_LIMIT) {
            return content;
        }
        int cut = content.lastIndexOf('\n', AGENTS_MD_LIMIT);
        if (cut < 0) {
            cut = AGENTS_MD_LIMIT;
        }
        return content.substring(0, cut) + TRUNCATION_MARKER;
    }

    private static String loadBasePrompt() {
        try (InputStream in = SystemPromptBuilder.class.getResourceAsStream(BASE_PROMPT_RESOURCE)) {
            if (in == null) {
                throw new IllegalStateException("Missing classpath resource " + BASE_PROMPT_RESOURCE);
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
