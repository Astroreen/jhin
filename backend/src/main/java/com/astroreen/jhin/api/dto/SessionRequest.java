package com.astroreen.jhin.api.dto;

/** Тело POST /sessions: title и workdir обязательны непустые, model/providerId опциональны. */
public record SessionRequest(String title, String workdir, String model, String providerId) {}
