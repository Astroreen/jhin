/**
 * {@code LlmProviderFactory} for the {@code mock} format: builds the
 * deterministic scripted chat models of {@link QaMockChatModel},
 * {@link QaMockAskingModel}, {@link QaMockFilesModel},
 * {@link QaMockFailingModel} and {@link QaMockTitleModel} (selected by the
 * configuration's {@code model} name) that an end-to-end run can observe
 * without any network endpoint.
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

    /** The {@code model} name that makes every call fail. */
    public static final String FAIL_MODEL = "fail";

    /** The {@code model} name that answers with an over-long fixed title. */
    public static final String TITLE_MODEL = "title";

    /** The {@code model} name that emits one blocking {@code ask_user} question. */
    public static final String ASK_MODEL = "ask";

    /** The {@code model} name that emits two {@code write} tool calls. */
    public static final String FILES_MODEL = "files";

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
     * Builds the deterministic scripted chat model. The {@code model} name
     * selects the script: {@link #FAIL_MODEL} refuses every call,
     * {@link #TITLE_MODEL} answers with an over-long fixed title,
     * {@link #ASK_MODEL} emits one blocking {@code ask_user} question,
     * {@link #FILES_MODEL} emits two {@code write} tool calls and anything
     * else is the plain scripted run model. The configuration is otherwise
     * only checked for presence; the models perform no network I/O.
     *
     * @param cfg the provider configuration (the {@code model} name selects
     *            the script)
     * @return the ready chat model
     * @throws IllegalArgumentException when {@code cfg} is {@code null}
     */
    @Override
    public ChatModel create(ProviderConfig cfg) {
        if (cfg == null) {
            throw new IllegalArgumentException(FORMAT + " factory requires a configuration");
        }
        if (FAIL_MODEL.equals(cfg.model())) {
            return new QaMockFailingModel();
        }
        if (TITLE_MODEL.equals(cfg.model())) {
            return new QaMockTitleModel();
        }
        if (ASK_MODEL.equals(cfg.model())) {
            return new QaMockAskingModel(log);
        }
        if (FILES_MODEL.equals(cfg.model())) {
            return new QaMockFilesModel(log);
        }
        return new QaMockChatModel(log);
    }
}
