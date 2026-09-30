/**
 * One provider row of the {@code jhin_llm_providers} table, as returned by
 * the CRUD routes: metadata only.
 *
 * <p>The provider table has exactly one more column than this DTO — the api
 * key. The DTO omits it by design so serialized route responses stay
 * metadata-only and no route can ever leak the credential; the key is written
 * on create and never read back into any response shape.
 */
package com.astroreen.jhin.plugin.llm.api;

/**
 * @param id        unique provider id
 * @param accountId owning account; {@code local} when no security plugin is present
 * @param format    the provider format the matching factory was resolved by
 * @param model     the model name this provider is configured with
 * @param baseUrl   the endpoint override; {@code null} for the provider default
 * @param createdAt creation time, epoch milliseconds
 */
public record ProviderRecord(
        String id,
        String accountId,
        String format,
        String model,
        String baseUrl,
        long createdAt) {}
