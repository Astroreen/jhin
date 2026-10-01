/**
 * {@code LlmProviderFactory} for the {@code mock} format: builds the
 * deterministic scripted chat model of {@link QaMockChatModel} that an
 * end-to-end run can observe without any network endpoint.
 *
 * <p>Published by {@link QaMockLlmPlugin} unconditionally (the jar itself is
 * the QA opt-in) under the {@code mock} qualifier. The configuration is only
 * checked for presence; the model performs no network I/O and needs no
 * credential. The observed tool count of every model call is logged through
 * the plugin logger so a QA script can prove {@code tools: 0} after the
 * tools plugin jar was deleted.
 */
package com.astroreen.jhin.plugin.qamockllm;

import com.astroreen.jhin.plugin.llm.api.LlmProviderFactory;
import com.astroreen.jhin.plugin.llm.api.ProviderConfig;
import dev.langchain4j.model.chat.ChatModel;
import org.slf4j.Logger;

public final class QaMockFactory implements LlmProviderFactory {

    /** The provider format this factory builds. */
    public static final String FORMAT = "mock";

    private final Logger log;

    /**
     * Creates the factory over the plugin logger used for the tool-count
     * diagnostics.
     *
     * @param log the logger of the qa-mock-llm plugin
     */
    public QaMockFactory(Logger log) {
        this.log = log;
    }

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
     * Builds the deterministic scripted chat model. The configuration is only
     * checked for presence; the model itself performs no network I/O.
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
        return new QaMockChatModel(log);
    }
}
