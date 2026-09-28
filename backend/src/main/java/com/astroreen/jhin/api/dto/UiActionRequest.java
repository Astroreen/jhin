package com.astroreen.jhin.api.dto;

import java.util.Map;

/** Тело POST /sessions/{id}/ui-action: action обязателен, payload — любой JSON-объект или null. */
public record UiActionRequest(String action, Map<String, Object> payload) {}
