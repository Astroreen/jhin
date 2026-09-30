/**
 * The LLM provider factory SPI: one implementation per provider format,
 * published to the cross-plugin service registry by the plugin that bundles
 * the matching LangChain4j integration.
 *
 * <p>Discovery is live: the registry resolves factories through
 * {@code services().findAll(LlmProviderFactory.class)} at call time and picks
 * the first instance whose {@link #format()} matches, so a factory plugin
 * installed later becomes visible without restarting the registry.
 */
package com.astroreen.jhin.plugin.llm.api;

import dev.langchain4j.model.chat.ChatModel;

public interface LlmProviderFactory {

    /**
     * The provider format this factory builds, for example {@code anthropic}.
     * Unique per factory; the registry matches it against the requested
     * format and lists the registered values at {@code GET /providers/formats}.
     *
     * @return the provider format name
     */
    String format();

    /**
     * Builds a chat model for the given configuration. Called by the registry
     * on creation to fail fast on a configuration the provider cannot honour
     * (for example a blank api key) and by consumers that need a live model.
     *
     * @param cfg the provider configuration (api key, model, base URL)
     * @return the ready chat model
     * @throws IllegalArgumentException when the configuration is unusable for
     *                                  this format
     */
    ChatModel create(ProviderConfig cfg);
}
