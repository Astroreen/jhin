/**
 * Schema migrations of the security plugin: accounts, enrolled devices and
 * the single-use enrollment codes that bind a device to an account.
 */
package com.astroreen.jhin.plugin.security;

import com.astroreen.jhin.sdk.db.MigrationSpec;
import java.util.List;

final class Migrations {

    private Migrations() {}

    /**
     * All migrations of this plugin, versions strictly increasing.
     *
     * @return the migration list handed to {@code ctx.db().migrate()}
     */
    static List<MigrationSpec> all() {
        return List.of(v1());
    }

    /**
     * V1: the three tables of the security domain. Every target carries the
     * mandatory {@code jhin_security_} prefix. Secrets never land in plain
     * text: device tokens and enrollment codes are stored as SHA-256 digests.
     *
     * @return migration version 1
     */
    static MigrationSpec v1() {
        return new MigrationSpec(1, """
                CREATE TABLE jhin_security_accounts(
                    id TEXT PRIMARY KEY,
                    name TEXT UNIQUE,
                    created_at INT
                );
                CREATE TABLE jhin_security_devices(
                    id TEXT PRIMARY KEY,
                    account_id TEXT,
                    name TEXT,
                    token_sha256 TEXT UNIQUE,
                    created_at INT,
                    last_seen_at INT,
                    revoked_at INT
                );
                CREATE TABLE jhin_security_enrollment_codes(
                    code_sha256 TEXT PRIMARY KEY,
                    account_id TEXT,
                    expires_at INT,
                    used_at INT
                );
                """);
    }
}
