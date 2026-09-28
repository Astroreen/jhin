package com.astroreen.jhin.api.dto;

/** Ответ {@code POST /enroll}: plaintext device-токен возвращается ровно один раз. */
public record EnrollResponse(String deviceToken, String accountId, String accountName) {}
