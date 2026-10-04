/**
 * The scripted title model of the {@code title} model name: every call
 * answers with one fixed, over-long title, so a QA run can prove the
 * {@code 60}-character truncation rule of title regeneration end to end.
 */
package com.astroreen.jhin.plugin.qamockllm;

import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;

final class QaMockTitleModel implements ChatModel {

    /**
     * The fixed answer, deliberately longer than 60 characters so the caller
     * must truncate it.
     */
    static final String TITLE =
            "Fix the authentication flow across the gateway, the proxy and every dependent microservice";

    /**
     * Answers with the fixed over-long title.
     *
     * @param request the chat request to answer
     * @return the scripted answer
     */
    @Override
    public ChatResponse doChat(ChatRequest request) {
        return ChatResponse.builder().aiMessage(AiMessage.from(TITLE)).build();
    }
}
