package com.astroreen.jhin.api.dto;

/** Тело POST /sessions/{id}/messages: text обязателен непустой. */
public record MessageRequest(String text) {}
