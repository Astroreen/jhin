/**
 * CRUD over LLM providers: creation resolves a registered
 * {@link LlmProviderFactory} by format and persists the credentials and
 * metadata; the read and delete operations are scoped by account.
 *
 * <p>Access is always scoped to one account. Without a security plugin every
 * caller is the single implicit account {@link #LOCAL_ACCOUNT}.
 *
 * <p>Added in T33: {@link #modelFor(String, String)} — the agent plugin needs
 * the live {@link dev.langchain4j.model.chat.ChatModel} behind a stored
 * provider id, and the api key must never leave this plugin.
 */
package com.astroreen.jhin.plugin.llm.api;

import dev.langchain4j.model.chat.ChatModel;
import java.util.List;
import java.util.Optional;

public interface ProviderRegistry {

    /** The implicit account used when no security plugin is present. */
    String LOCAL_ACCOUNT = "local";

    /**
     * Creates a provider owned by {@link #LOCAL_ACCOUNT}. Called when no
     * security plugin is present.
     *
     * @param format the provider format to resolve a factory by
     * @param cfg    the provider configuration
     * @return the persisted provider metadata
     * @throws IllegalArgumentException when {@code format} is null or blank or
     *                                  {@code cfg} is {@code null}
     * @throws ProviderException        with code
     *                                  {@link ProviderException#CODE_UNKNOWN_FORMAT}
     *                                  when no registered factory matches
     */
    ProviderRecord create(String format, ProviderConfig cfg);

    /**
     * Creates a provider owned by the given account. Resolves the factory
     * whose {@link LlmProviderFactory#format()} equals {@code format}
     * (first-wins) and builds the model once to fail fast on an unusable
     * configuration; only the metadata is stored.
     *
     * @param accountId the owning account
     * @param format    the provider format to resolve a factory by
     * @param cfg       the provider configuration
     * @return the persisted provider metadata
     * @throws IllegalArgumentException when {@code accountId} or {@code format}
     *                                  is null or blank or {@code cfg} is
     *                                  {@code null}
     * @throws ProviderException        with code
     *                                  {@link ProviderException#CODE_UNKNOWN_FORMAT}
     *                                  when no registered factory matches
     */
    ProviderRecord create(String accountId, String format, ProviderConfig cfg);

    /**
     * Lists the providers of one account, newest first.
     *
     * @param accountId the owning account
     * @return the providers of the account ordered by creation time descending
     */
    List<ProviderRecord> list(String accountId);

    /**
     * Fetches one provider by id, restricted to the given account. A provider
     * owned by another account is indistinguishable from an unknown one.
     *
     * @param accountId the owning account
     * @param id        the provider id
     * @return the provider metadata, or empty when unknown
     */
    Optional<ProviderRecord> get(String accountId, String id);

    /**
     * Deletes one provider, restricted to the given account. The api key is
     * removed with the row and was never readable through this interface.
     *
     * @param accountId the owning account
     * @param id        the provider id
     * @return {@code true} when a provider was deleted
     */
    boolean delete(String accountId, String id);

    /**
     * The sorted formats of all currently registered factories. The set is
     * discovered live, so factories published later appear in subsequent
     * calls.
     *
     * @return the registered factory formats, sorted
     */
    List<String> formats();

    /**
     * Builds the live chat model behind one stored provider id. The api key is
     * read here and handed straight to the matching
     * {@link LlmProviderFactory}; it never crosses this interface. The factory
     * is resolved live (first-wins by format), so a factory plugin installed
     * later is honoured without a registry restart. Added in T33 for the agent
     * plugin, which mints the model of the session provider at run start.
     *
     * @param accountId  the owning account
     * @param providerId the stored provider id
     * @return a fresh chat model for the provider configuration
     * @throws IllegalArgumentException when {@code accountId} or
     *                                  {@code providerId} is null or blank
     * @throws ProviderException        with code
     *                                  {@link ProviderException#CODE_NOT_FOUND}
     *                                  when the provider is unknown or foreign,
     *                                  or {@link ProviderException#CODE_UNKNOWN_FORMAT}
     *                                  when no registered factory matches
     */
    ChatModel modelFor(String accountId, String providerId);
}
