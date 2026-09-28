package com.astroreen.jhin.core.agent.spi;

/**
 * Перехватчик сборки system prompt: плагины мутируют/переписывают финальный system prompt,
 * вернув новый {@link PromptContext}. Бросить {@link PluginVetoException} — прервать run с
 * причиной (вето).
 */
public interface PromptInterceptor {

    PromptContext intercept(PromptContext ctx) throws PluginVetoException;
}
