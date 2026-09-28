package com.astroreen.jhin.core.agent;

/**
 * Строка таблицы {@code runs} без timestamp'ов: статус — RUNNING|DONE|CANCELLED|ERROR|INTERRUPTED,
 * {@code error} — причина неуспешного завершения (nullable).
 */
public record RunRecord(String id, String sessionId, String status, String model, String providerId, String error) {}
