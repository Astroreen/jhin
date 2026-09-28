package com.astroreen.jhin.example;

import com.astroreen.jhin.core.agent.spi.PluginVetoException;
import com.astroreen.jhin.core.agent.spi.PromptContext;
import com.astroreen.jhin.core.agent.spi.PromptInterceptor;

/**
 * Демо-перехватчик system prompt: добавляет строку в конец промпта через {@link
 * PromptContext#withSystemPrompt(String)}. Регистрация — через {@code
 * META-INF/services/com.astroreen.jhin.core.agent.spi.PromptInterceptor}.
 */
public final class ExamplePromptInterceptor implements PromptInterceptor {

    static final String NOTE =
            "The example plugin is active: current time is available via the example_time tool.";

    @Override
    public PromptContext intercept(PromptContext ctx) throws PluginVetoException {
        String base = ctx.systemPrompt() == null ? "" : ctx.systemPrompt();
        return ctx.withSystemPrompt(base + "\n" + NOTE);
    }
}
