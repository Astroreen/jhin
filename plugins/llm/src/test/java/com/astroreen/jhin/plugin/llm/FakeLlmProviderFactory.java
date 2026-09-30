/**
 * Fake {@link LlmProviderFactory} for registry and route tests: one format,
 * a stub {@link ChatModel} and a recording of every configuration the
 * registry validated through {@code create}.
 */
package com.astroreen.jhin.plugin.llm;

import com.astroreen.jhin.plugin.llm.api.LlmProviderFactory;
import com.astroreen.jhin.plugin.llm.api.ProviderConfig;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import java.util.ArrayList;
import java.util.List;

final class FakeLlmProviderFactory implements LlmProviderFactory {

    private final String format;
    private final List<ProviderConfig> created = new ArrayList<>();

    FakeLlmProviderFactory(String format) {
        this.format = format;
    }

    @Override
    public String format() {
        return format;
    }

    @Override
    public ChatModel create(ProviderConfig cfg) {
        created.add(cfg);
        return new StubChatModel();
    }

    /** Every configuration handed to {@link #create}, in call order. */
    List<ProviderConfig> created() {
        return List.copyOf(created);
    }

    /** Minimal chat model stub: answers every request with a fixed message. */
    private static final class StubChatModel implements ChatModel {

        @Override
        public ChatResponse doChat(ChatRequest request) {
            return ChatResponse.builder()
                    .aiMessage(AiMessage.from("stub"))
                    .build();
        }
    }
}