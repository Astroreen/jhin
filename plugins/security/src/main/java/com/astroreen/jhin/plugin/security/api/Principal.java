/**
 * The authenticated caller: one device enrolled for one account.
 *
 * <p>Attribute contract: a security filter stores this value under
 * {@link SecurityAttributes#PRINCIPAL} on the HTTP request after verifying the
 * bearer token. Consumers must not link against this class — they read the
 * attribute as an opaque {@link Object} and extract the account id
 * reflectively through the public {@link #accountId()} accessor (a plain
 * {@link String} attribute value is already the account id). The record
 * component accessors are public and stable, so that reflective lookup keeps
 * working across plugin class loaders.
 */
package com.astroreen.jhin.plugin.security.api;

/**
 * @param accountId   id of the owning account
 * @param accountName name of the owning account, for display
 * @param deviceId    id of the device the token belongs to
 */
public record Principal(String accountId, String accountName, String deviceId) {
}
