package com.astroreen.jhin.api.dto;

/** Сессия наружу: без accountId (scope и так по device-токену). */
public record SessionResponse(
        String id, String title, String workdir, String model, String providerId,
        String createdAt, String updatedAt) {}
