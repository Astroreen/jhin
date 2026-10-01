/**
 * Public API of the llm plugin: the provider factory SPI, the provider
 * registry and the metadata DTO the routes serialize.
 *
 * <p>This package is exported through the plugin manifest together with the
 * LangChain4j packages {@code dev.langchain4j.model.chat},
 * {@code dev.langchain4j.data.message}, {@code dev.langchain4j.agent.tool},
 * {@code dev.langchain4j.model.chat.request},
 * {@code dev.langchain4j.model.chat.response} and
 * {@code dev.langchain4j.model.output} (the last four added in T33, when the
 * agent plugin started building {@code ChatRequest} tool specifications and
 * reading {@code ChatResponse} tool requests across the plugin boundary).
 * Manifest exports are the plugin-to-plugin class sharing mechanism: a plugin
 * that {@code requires jhin.llm} (for example {@code jhin.llm-builtin}, which
 * publishes {@link LlmProviderFactory} implementations) compiles against and
 * resolves these types from this plugin's class loader at runtime. Nothing
 * outside the exported packages may be referenced across plugin boundaries.
 */
package com.astroreen.jhin.plugin.llm.api;
