/**
 * The account registry of the security plugin: create accounts and look them
 * up by id or name. Published to the cross-plugin service registry, so any
 * plugin can manage the account namespace without depending on the plugin
 * implementation.
 */
package com.astroreen.jhin.plugin.security.api;

import java.util.List;
import java.util.Optional;

public interface AccountDirectory {

    /**
     * Creates a new account with a generated id. The name is unique across all
     * accounts (case-sensitive).
     *
     * @param name the account name, must not be null or blank
     * @return the persisted account
     * @throws IllegalArgumentException when {@code name} is null or blank
     * @throws SecurityException         with code {@code conflict} (HTTP 409)
     *                                   when the name is already taken
     */
    Account create(String name);

    /**
     * Fetches one account by id.
     *
     * @param id the account id
     * @return the account, or empty when unknown
     */
    Optional<Account> findById(String id);

    /**
     * Fetches one account by its unique name.
     *
     * @param name the account name
     * @return the account, or empty when unknown
     */
    Optional<Account> findByName(String name);

    /**
     * Lists all accounts in creation order.
     *
     * @return all accounts, oldest first
     */
    List<Account> list();

    /**
     * One account row of the {@code jhin_security_accounts} table.
     *
     * @param id        unique account id
     * @param name      unique account name
     * @param createdAt creation time, epoch milliseconds
     */
    record Account(String id, String name, long createdAt) {
    }
}
