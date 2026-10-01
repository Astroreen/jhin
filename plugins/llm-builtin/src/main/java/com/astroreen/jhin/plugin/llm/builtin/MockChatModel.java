/**
 * The deterministic chat model behind the {@code mock} format: answers every
 * request with {@code Echo: <prompt>} after a fixed delay.
 *
 * <p>The delay keeps a run alive long enough for a QA script to observe it
 * (and to cancel it) while the answer text proves the user message travelled
 * through the agent into the model. One-shot like every {@link ChatModel}
 * response: the caller receives the whole answer as one piece.
 */
package com.astroreen.jhin.plugin.llm.builtin;

import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;

final class MockChatModel implements ChatModel {

    /** Delay before every answer, in milliseconds. */
    static final long DEFAULT_DELAY_MILLIS = 2000L;

    private final long delayMillis;

    MockChatModel(long delayMillis) {
        this.delayMillis = delayMillis;
    }

    /**
     * Answers with {@code Echo: <prompt>} where the prompt is the last user
     * message of the request.
     *
     * @param request the chat request to answer
     * @return the echo answer
     */
    @Override
    public ChatResponse doChat(ChatRequest request) {
        String prompt = lastUserText(request);
        try {
            Thread.sleep(delayMillis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("mock model interrupted while delaying", e);
        }
        return ChatResponse.builder().aiMessage(AiMessage.from("Echo: " + prompt)).build();
    }

    /** The text of the last user message, empty when the request carries none. */
    private static String lastUserText(ChatRequest request) {
        String text = "";
        for (ChatMessage message : request.messages()) {
            if (message instanceof UserMessage user) {
                text = user.hasSingleText() ? user.singleText() : String.valueOf(user.contents());
            }
        }
        return text;
    }
}
