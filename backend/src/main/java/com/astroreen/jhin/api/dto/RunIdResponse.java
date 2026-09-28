package com.astroreen.jhin.api.dto;

/** Ответ messages/cancel: runId = null — активного run нет (cancel идемпотентен). */
public record RunIdResponse(String runId) {}
