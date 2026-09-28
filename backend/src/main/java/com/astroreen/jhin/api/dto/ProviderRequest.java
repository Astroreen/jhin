package com.astroreen.jhin.api.dto;

/**
 * Тело {@code POST /providers}. {@code apiKey} — plaintext секрет: сохраняется как есть,
 * наружу не возвращается (ответы — без него). {@code baseUrl} и {@code isDefault} опциональны.
 */
public record ProviderRequest(
        String name, String format, String apiKey, String model, String baseUrl, Boolean isDefault) {}
