package com.astroreen.jhin.core.llm;

import dev.langchain4j.model.chat.ChatModel;

/**
 * Точка расширения плагинов для LLM-бэкендов: фабрика по строке формата
 * (anthropic|openai|gemini|...). Встроенные фабрики — {@link BuiltinFactories}, плагинные (T25)
 * подключаются через {@link ProviderRegistry#register(LlmProviderFactory)}.
 */
public interface LlmProviderFactory {

    /** Строка формата провайдера (колонка providers.format). */
    String format();

    /** Собирает {@link ChatModel} из конфига (без сетевых вызовов при сборке). */
    ChatModel create(ProviderConfig cfg);
}
