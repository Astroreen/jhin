package com.astroreen.jhin.core.agent.spi;

/**
 * Состояние сборки system prompt: текущий текст + контекст сессии. Иммутабельный,
 * переписывание текста — через {@link #withSystemPrompt(String)} (возвращает новый инстанс).
 */
public record PromptContext(String workdir, String sessionId, String runId, String systemPrompt) {

    /** Новый контекст с заменённым system prompt (workdir/sessionId/runId без изменений). */
    public PromptContext withSystemPrompt(String systemPrompt) {
        return new PromptContext(workdir, sessionId, runId, systemPrompt);
    }
}
