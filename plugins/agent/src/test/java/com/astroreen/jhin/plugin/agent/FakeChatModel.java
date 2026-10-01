/**
 * Scripted in-process {@link ChatModel} fake for agent tests: pops one
 * prepared {@link AiMessage} per call and records every request. Implements
 * the production entry point {@code doChat}, so the real LangChain4j
 * {@code chat} default path runs around it.
 */
package com.astroreen.jhin.plugin.agent;

import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;

final class FakeChatModel implements dev.langchain4j.model.chat.ChatModel {

    private final ConcurrentLinkedQueue<AiMessage> scripted = new ConcurrentLinkedQueue<>();
    private final List<ChatRequest> requests = new CopyOnWriteArrayList<>();

    FakeChatModel script(AiMessage... answers) {
        scripted.addAll(List.of(answers));
        return this;
    }

    List<ChatRequest> requests() {
        return List.copyOf(requests);
    }

    int callCount() {
        return requests.size();
    }

    @Override
    public ChatResponse doChat(ChatRequest request) {
        requests.add(request);
        AiMessage answer = scripted.poll();
        if (answer == null) {
            throw new IllegalStateException("fake model has no scripted answer left");
        }
        return ChatResponse.builder().aiMessage(answer).build();
    }
}
