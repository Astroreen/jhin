package com.astroreen.jhin.core.accounts;

/** Plaintext device-токена живёт только в этом результате (момент выдачи). */
public record IssuedDevice(String id, String accountId, String name, String token) {}
