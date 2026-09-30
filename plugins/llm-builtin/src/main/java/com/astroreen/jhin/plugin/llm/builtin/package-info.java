/**
 * The three deletable built-in LLM provider factories ({@code anthropic},
 * {@code openai}, {@code gemini}) and their plugin entry point.
 *
 * <p>Nothing is exported: the factories implement
 * {@code com.astroreen.jhin.plugin.llm.api.LlmProviderFactory} and build
 * LangChain4j chat models, all resolved through the {@code jhin.llm} exports
 * at runtime. The whole jar is removable — without it
 * {@code GET /providers/formats} returns {@code []}.
 */
package com.astroreen.jhin.plugin.llm.builtin;
