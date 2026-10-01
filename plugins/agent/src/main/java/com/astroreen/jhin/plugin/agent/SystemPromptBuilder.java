/**
 * Composes the system prompt of one run and runs the
 * {@code PromptInterceptor} chain over it.
 *
 * <p>Composition: the base prompt ({@code prompts/base-prompt.md} on the
 * plugin classpath) plus one section per resolved tool holding its
 * {@code promptSnippet} and {@code promptGuidelines}. Interceptors then run in
 * plugin load order over the composed {@link PromptContext}; a {@code null}
 * return or a {@link PluginVetoException} aborts the run before any model
 * call, exactly as the prompt SPI documents. A {@code null} return has no
 * message of its own, so the abort text names the interceptor.
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.plugin.agent.api.PluginVetoException;
import com.astroreen.jhin.plugin.agent.api.PromptContext;
import com.astroreen.jhin.plugin.agent.api.PromptInterceptor;
import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.sessions.api.Session;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.function.Supplier;

final class SystemPromptBuilder {

    private static final String BASE_PROMPT_RESOURCE = "prompts/base-prompt.md";

    private final Supplier<List<ToolDefinition>> tools;
    private final Supplier<List<PromptInterceptor>> interceptors;
    private final String basePrompt;

    SystemPromptBuilder(Supplier<List<ToolDefinition>> tools,
                        Supplier<List<PromptInterceptor>> interceptors) {
        this.tools = tools;
        this.interceptors = interceptors;
        this.basePrompt = loadBasePrompt();
    }

    /**
     * Composes the system prompt of one session and runs the interceptor
     * chain. Aborts by throwing {@link PluginVetoException}: either one
     * interceptor vetoed or one returned {@code null}.
     *
     * @param session the session the prompt is built for
     * @return the final prompt context, after every interceptor
     * @throws PluginVetoException when an interceptor returns {@code null} or
     *                             throws {@link PluginVetoException}
     */
    PromptContext build(Session session) {
        List<ToolDefinition> toolSet = tools.get();
        PromptContext ctx = new PromptContext(
                session.id(), compose(toolSet), session.workdir(), toolSet);
        for (PromptInterceptor interceptor : interceptors.get()) {
            if (interceptor == null) {
                continue;
            }
            PromptContext next = interceptor.intercept(ctx);
            if (next == null) {
                throw new PluginVetoException("prompt interceptor "
                        + interceptor.getClass().getName() + " vetoed the run (returned null)");
            }
            ctx = next;
        }
        return ctx;
    }

    private String compose(List<ToolDefinition> toolSet) {
        StringBuilder prompt = new StringBuilder(basePrompt.strip());
        if (!toolSet.isEmpty()) {
            prompt.append("\n\n# Available tools\n");
            for (ToolDefinition tool : toolSet) {
                prompt.append("\n## ").append(tool.label()).append(" (")
                        .append(tool.name()).append(")\n");
                prompt.append(tool.promptSnippet().strip()).append('\n');
                prompt.append(tool.promptGuidelines().strip()).append('\n');
            }
        }
        return prompt.toString();
    }

    private static String loadBasePrompt() {
        try (InputStream in = SystemPromptBuilder.class.getClassLoader()
                .getResourceAsStream(BASE_PROMPT_RESOURCE)) {
            if (in == null) {
                throw new IllegalStateException("missing classpath resource: " + BASE_PROMPT_RESOURCE);
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("cannot read " + BASE_PROMPT_RESOURCE, e);
        }
    }
}
