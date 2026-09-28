package com.astroreen.jhin.core.tools.spi;

import java.util.List;
import java.util.Map;

/** Описание тула: схема и промпт-материал для LLM + исполнение. */
public interface ToolDefinition {

    /** Уникальное имя тула (например "bash"). */
    String name();

    /** Короткий человекочитаемый ярлык. */
    String label();

    /** Описание для LLM. */
    String description();

    /** JSON Schema объекта аргументов (params map). */
    Map<String, Object> parametersSchema();

    /** Короткие строки подсказки для system prompt. */
    String promptSnippet();

    /** Буллеты-гайдлайны для system prompt. */
    List<String> promptGuidelines();

    ToolResult execute(ToolCall call, ToolContext ctx);
}
