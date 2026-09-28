package com.astroreen.jhin.core.accounts;

public record DevicePrincipal(
        String id, String accountId, String name, boolean revoked, Long lastSeen, String lastIp) {}
