/**
 * {@code LlmProviderFactory} for the {@code gemini} format: builds a
 * {@link dev.langchain4j.model.googleai.GoogleAiGeminiChatModel} (the
 * LangChain4j class lives in {@code dev.langchain4j.model.googleai}, without
 * an extra {@code .gemini} package segment) from the provider configuration.
 *
 * <p>The api key is required: a {@code null} or blank {@code cfg.apiKey()}
 * fails with {@code "gemini factory requires a non-blank apiKey"}. The model
 * name is taken from {@code cfg.model()}. When {@code cfg.baseUrl()} is
 * non-blank it is applied via the builder's {@code baseUrl} override (for
 * regional and proxy endpoints); otherwise the provider default endpoint is
 * used. Constructing the model performs no network I/O — the client only
 * talks to the endpoint when a chat call is made.
 */
package com.astroreen.jhin.plugin.llm.builtin;

import com.astroreen.jhin.plugin.llm.api.LlmProviderFactory;
import com.astroreen.jhin.plugin.llm.api.ProviderConfig;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.googleai.GoogleAiGeminiChatModel;

public final class GeminiFactory implements LlmProviderFactory {

    /** The provider format this factory builds. */
    public static final String FORMAT = "gemini";

    /**
     * Returns the {@code gemini} format the registry matches on.
     *
     * @return the provider format name
     */
    @Override
    public String format() {
        return FORMAT;
    }

    /**
     * Builds a Google AI Gemini chat model. The api key must be present and
     * non-blank; the model name is taken from the configuration and a
     * non-blank base URL overrides the provider default endpoint. Does no
     * network I/O.
     *
     * @param cfg the provider configuration (api key, model, base URL)
     * @return the ready chat model
     * @throws IllegalArgumentException when the api key is null or blank
     */
    @Override
    public ChatModel create(ProviderConfig cfg) {
        if (cfg == null || cfg.apiKey() == null || cfg.apiKey().isBlank()) {
            throw new IllegalArgumentException(FORMAT + " factory requires a non-blank apiKey");
        }
        GoogleAiGeminiChatModel.GoogleAiGeminiChatModelBuilder builder = GoogleAiGeminiChatModel.builder()
                .apiKey(cfg.apiKey())
                .modelName(cfg.model());
        if (cfg.baseUrl() != null && !cfg.baseUrl().isBlank()) {
            builder.baseUrl(cfg.baseUrl());
        }
        return builder.build();
    }
}
