package com.astroreen.jhin.core.accounts;

/** Платёжный plaintext enrollment-кода живёт только в этом результате (момент выдачи). */
public record IssueResult(String code, long expiresAt) {}
