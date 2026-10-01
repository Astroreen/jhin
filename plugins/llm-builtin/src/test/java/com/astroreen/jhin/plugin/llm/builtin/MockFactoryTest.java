/**
 * The mock provider factory: the {@code mock} format name, the fail-fast
 * configuration check and the deterministic echo answer of the built model.
 */
package com.astroreen.jhin.plugin.llm.builtin;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.SystemMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import java.util.List;
import org.junit.jupiter.api.Test;

class MockFactoryTest {

    @Test
    void formatIsMock() {
        assertThat(new MockFactory().format()).isEqualTo("mock");
    }

    @Test
    void missingConfigurationIsRejected() {
        assertThatThrownBy(() -> new MockFactory().create(null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("mock");
    }

    @Test
    void modelEchoesTheLastUserMessageWithoutDelay() {
        ChatModel model = new MockChatModel(0);
        ChatRequest request = ChatRequest.builder()
                .messages(List.of(
                        SystemMessage.from("be brief"),
                        UserMessage.from("hello"),
                        AiMessage.from("earlier"),
                        UserMessage.from("ping")))
                .build();

        ChatResponse response = model.chat(request);

        assertThat(response.aiMessage().text()).isEqualTo("Echo: ping");
    }

    @Test
    void modelEchoesEmptyTextWhenNoUserMessageIsPresent() {
        ChatModel model = new MockChatModel(0);
        ChatRequest request = ChatRequest.builder()
                .messages(List.of(SystemMessage.from("be brief")))
                .build();

        ChatResponse response = model.chat(request);

        assertThat(response.aiMessage().text()).isEqualTo("Echo: ");
    }
}
