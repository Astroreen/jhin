/**
 * The QA harness mock provider factory ({@code mock} format) and its plugin
 * entry point.
 *
 * <p>Nothing is exported: the factory implements
 * {@code com.astroreen.jhin.plugin.llm.api.LlmProviderFactory} and builds a
 * scripted LangChain4j {@code ChatModel}, all resolved through the
 * {@code jhin.llm} exports at runtime. The whole jar is a test harness — it is
 * built with the composite but deliberately excluded from the release bundle.
 */
package com.astroreen.jhin.plugin.qamockllm;
