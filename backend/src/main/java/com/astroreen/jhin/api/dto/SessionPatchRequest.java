package com.astroreen.jhin.api.dto;

/** Тело PATCH /sessions/{id}: только явные поля (null = не менять). Пустое тело — 400. */
public record SessionPatchRequest(String title, String model, String providerId) {}
