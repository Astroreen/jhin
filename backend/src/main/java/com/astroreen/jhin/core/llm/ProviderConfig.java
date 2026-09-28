package com.astroreen.jhin.core.llm;

/**
 * Параметры сборки LLM-клиента. {@code baseUrl} — nullable (openai-совместимые кастомные
 * эндпоинты). {@code apiKey} — plaintext секрет, живёт только в фабрике и в БД, не логируется.
 */
public record ProviderConfig(String format, String apiKey, String model, String baseUrl) {}
