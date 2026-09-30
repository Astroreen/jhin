/**
 * Schema migrations of the llm plugin: the provider table holding the LLM
 * credentials and metadata the registry CRUD operates on.
 *
 * <p>Every target carries the mandatory {@code jhin_llm_} prefix the kernel
 * migration guard derives from the plugin id {@code jhin.llm}.
 */
package com.astroreen.jhin.plugin.llm;

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
     * V1: the {@code jhin_llm_providers} table. The column list is the
     * provider contract of the plan: {@code id}, {@code account_id},
     * {@code format}, the api key column (stored as-is, no crypto in MVP and
     * never returned by any route), {@code model}, {@code base_url} and
     * {@code created_at}.
     *
     * @return migration version 1
     */
    static MigrationSpec v1() {
        return new MigrationSpec(1, """
                CREATE TABLE jhin_llm_providers(
                    id TEXT PRIMARY KEY,
                    account_id TEXT,
                    format TEXT,
                    api_key_enc TEXT,
                    model TEXT,
                    base_url TEXT,
                    created_at INT
                );
                CREATE INDEX jhin_llm_providers_account_idx ON jhin_llm_providers(account_id);
                """);
    }
}
