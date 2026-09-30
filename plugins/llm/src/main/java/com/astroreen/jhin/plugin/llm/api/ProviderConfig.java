/**
 * Configuration a {@link LlmProviderFactory} builds a chat model from: the
 * api key, the model name and the optional base URL override.
 *
 * <p>The record itself validates nothing: the factory decides which fields
 * its format requires (for example throwing on a blank api key).
 */
package com.astroreen.jhin.plugin.llm.api;

/**
 * @param apiKey  the provider credential, stored as-is and never returned by
 *                any route; may be blank when the format needs none
 * @param model   the model name
 * @param baseUrl the endpoint override honoured when present,
 *                {@code null} for the provider default
 */
public record ProviderConfig(String apiKey, String model, String baseUrl) {}
