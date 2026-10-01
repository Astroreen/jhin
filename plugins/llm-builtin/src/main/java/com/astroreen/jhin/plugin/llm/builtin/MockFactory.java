/**
 * {@code LlmProviderFactory} for the {@code mock} format: a deterministic
 * in-process chat model for QA runs that must not reach a network endpoint.
 *
 * <p>Registered by {@link LlmBuiltinPlugin} only when the plugin's {@code qa}
 * configuration flag is on (environment variable {@code JHIN_LLM_BUILTIN_QA},
 * values strictly {@code true} or {@code false} like the sessions QA helper);
 * off by default, so a production {@code GET /providers/formats} never lists
 * the format. The model answers every prompt with {@code Echo: <prompt>}
 * after a fixed delay (see {@link MockChatModel}), which makes a QA script
 * able to observe a live run and to land a cancellation inside it.
 */
package com.astroreen.jhin.plugin.llm.builtin;

import com.astroreen.jhin.plugin.llm.api.LlmProviderFactory;
import com.astroreen.jhin.plugin.llm.api.ProviderConfig;
import dev.langchain4j.model.chat.ChatModel;

public final class MockFactory implements LlmProviderFactory {

    /** The provider format this factory builds. */
    public static final String FORMAT = "mock";

    /**
     * Returns the {@code mock} format the registry matches on.
     *
     * @return the provider format name
     */
    @Override
    public String format() {
        return FORMAT;
    }

    /**
     * Builds the deterministic chat model. The configuration is only checked
     * for presence; the model itself performs no network I/O and needs no
     * credential.
     *
     * @param cfg the provider configuration (ignored beyond validation)
     * @return the ready chat model
     * @throws IllegalArgumentException when {@code cfg} is {@code null}
     */
    @Override
    public ChatModel create(ProviderConfig cfg) {
        if (cfg == null) {
            throw new IllegalArgumentException(FORMAT + " factory requires a configuration");
        }
        return new MockChatModel(MockChatModel.DEFAULT_DELAY_MILLIS);
    }
}
