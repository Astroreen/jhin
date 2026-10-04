/**
 * The scripted failing model of the {@code fail} model name: every call is
 * refused with an {@link IllegalStateException}, so a QA run can prove the
 * LLM-failure path (title regeneration answers {@code 503} and leaves the
 * stored title unchanged) without any network endpoint.
 */
package com.astroreen.jhin.plugin.qamockllm;

import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;

final class QaMockFailingModel implements ChatModel {

    /** The failure every call raises. */
    static final String MESSAGE = "qa-mock-llm: scripted model failure";

    /**
     * Refuses the call, exactly like a provider outage would.
     *
     * @param request the chat request to answer
     * @return never
     */
    @Override
    public ChatResponse doChat(ChatRequest request) {
        throw new IllegalStateException(MESSAGE);
    }
}
