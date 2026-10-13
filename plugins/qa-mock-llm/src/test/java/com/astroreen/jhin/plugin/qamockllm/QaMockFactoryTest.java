/**
 * The qa-mock-llm harness: the factory format and fail-fast check, and the
 * scripted model behavior — one {@code write} tool call while the tool is
 * offered, one blocking {@code ask_user} question from the {@code ask} model
 * while that tool is offered, a text answer on the second call and on any
 * call without the scripted tool (the failure paths prove the models never
 * invent a tool call).
 */
package com.astroreen.jhin.plugin.qamockllm;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.llm.api.ProviderConfig;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ToolExecutionResultMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

class QaMockFactoryTest {

    private final QaMockFactory factory =
            new QaMockFactory(LoggerFactory.getLogger("qa-mock-test"));

    @Test
    void formatIsMock() {
        assertThat(factory.format()).isEqualTo("mock");
    }

    @Test
    void missingConfigurationIsRejected() {
        assertThatThrownBy(() -> factory.create(null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("mock");
    }

    @Test
    void firstCallWithWriteOfferedEmitsExactlyOneWriteToolCall() {
        ChatModel model = factory.create(new ProviderConfig(null, "mock-1", null));

        ChatResponse response = model.chat(request("do the work", writeTool()));

        List<ToolExecutionRequest> calls = response.aiMessage().toolExecutionRequests();
        assertThat(calls).hasSize(1);
        assertThat(calls.get(0).name()).isEqualTo(QaMockChatModel.TOOL_NAME);
        assertThat(calls.get(0).arguments()).isEqualTo(QaMockChatModel.TOOL_ARGUMENTS);
        assertThat(QaMockChatModel.TOOL_ARGUMENTS).contains(QaMockChatModel.FILE_PATH);
    }

    @Test
    void secondCallAfterTheToolResultAnswersWithText() {
        ChatModel model = factory.create(new ProviderConfig(null, "mock-1", null));
        model.chat(request("do the work", writeTool()));

        ChatRequest second = ChatRequest.builder()
                .messages(List.of(
                        UserMessage.from("do the work"),
                        AiMessage.from(List.of(ToolExecutionRequest.builder()
                                .id(QaMockChatModel.TOOL_CALL_ID)
                                .name(QaMockChatModel.TOOL_NAME)
                                .arguments(QaMockChatModel.TOOL_ARGUMENTS)
                                .build())),
                        ToolExecutionResultMessage.builder()
                                .id(QaMockChatModel.TOOL_CALL_ID)
                                .toolName(QaMockChatModel.TOOL_NAME)
                                .text("ok")
                                .build()))
                .toolSpecifications(List.of(writeTool()))
                .build();

        ChatResponse response = model.chat(second);

        assertThat(response.aiMessage().text()).isEqualTo(QaMockChatModel.TEXT_ANSWER);
        assertThat(response.aiMessage().hasToolExecutionRequests()).isFalse();
    }

    @Test
    void noWriteToolAnswersWithTextDirectly() {
        ChatModel model = factory.create(new ProviderConfig(null, "mock-1", null));

        ChatResponse response = model.chat(request("do the work",
                ToolSpecification.builder().name("read").build()));

        assertThat(response.aiMessage().text()).isEqualTo(QaMockChatModel.TEXT_ANSWER);
        assertThat(response.aiMessage().hasToolExecutionRequests()).isFalse();
    }

    @Test
    void noToolsAtAllAnswersWithTextDirectly() {
        ChatModel model = factory.create(new ProviderConfig(null, "mock-1", null));

        ChatResponse response = model.chat(request("do the work"));

        assertThat(response.aiMessage().text()).isEqualTo(QaMockChatModel.TEXT_ANSWER);
        assertThat(response.aiMessage().hasToolExecutionRequests()).isFalse();
    }

    @Test
    void failModelRefusesEveryCall() {
        ChatModel model = factory.create(new ProviderConfig(null, QaMockFactory.FAIL_MODEL, null));

        assertThatThrownBy(() -> model.chat(request("title this")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("scripted model failure");
    }

    @Test
    void titleModelAnswersWithAnOverlongTitle() {
        ChatModel model = factory.create(new ProviderConfig(null, QaMockFactory.TITLE_MODEL, null));

        ChatResponse response = model.chat(request("title this"));

        assertThat(response.aiMessage().text()).isEqualTo(QaMockTitleModel.TITLE);
        assertThat(response.aiMessage().text()).hasSizeGreaterThan(60);
    }

    @Test
    void askModelEmitsExactlyOneAskUserToolCall() {
        ChatModel model = factory.create(new ProviderConfig(null, QaMockFactory.ASK_MODEL, null));

        ChatResponse response = model.chat(request("continue", askUserTool()));

        List<ToolExecutionRequest> calls = response.aiMessage().toolExecutionRequests();
        assertThat(calls).hasSize(1);
        assertThat(calls.get(0).name()).isEqualTo(QaMockAskingModel.TOOL_NAME);
        assertThat(calls.get(0).arguments()).isEqualTo(QaMockAskingModel.TOOL_ARGUMENTS);
        assertThat(QaMockAskingModel.TOOL_ARGUMENTS).contains(QaMockAskingModel.QUESTION);
    }

    @Test
    void askModelAnswersWithTextOnSecondCall() {
        ChatModel model = factory.create(new ProviderConfig(null, QaMockFactory.ASK_MODEL, null));
        model.chat(request("continue", askUserTool()));

        ChatRequest second = ChatRequest.builder()
                .messages(List.of(
                        UserMessage.from("continue"),
                        AiMessage.from(List.of(ToolExecutionRequest.builder()
                                .id(QaMockAskingModel.TOOL_CALL_ID)
                                .name(QaMockAskingModel.TOOL_NAME)
                                .arguments(QaMockAskingModel.TOOL_ARGUMENTS)
                                .build())),
                        ToolExecutionResultMessage.builder()
                                .id(QaMockAskingModel.TOOL_CALL_ID)
                                .toolName(QaMockAskingModel.TOOL_NAME)
                                .text("Yes")
                                .build()))
                .toolSpecifications(List.of(askUserTool()))
                .build();

        ChatResponse response = model.chat(second);

        assertThat(response.aiMessage().text()).isEqualTo(QaMockAskingModel.TEXT_ANSWER);
        assertThat(response.aiMessage().hasToolExecutionRequests()).isFalse();
    }

    @Test
    void askModelWithoutAskUserToolAnswersWithTextDirectly() {
        ChatModel model = factory.create(new ProviderConfig(null, QaMockFactory.ASK_MODEL, null));

        ChatResponse response = model.chat(request("continue", writeTool()));

        assertThat(response.aiMessage().text()).isEqualTo(QaMockAskingModel.TEXT_ANSWER);
        assertThat(response.aiMessage().hasToolExecutionRequests()).isFalse();
    }

    private static ToolSpecification writeTool() {
        return ToolSpecification.builder().name(QaMockChatModel.TOOL_NAME).build();
    }

    private static ToolSpecification askUserTool() {
        return ToolSpecification.builder().name(QaMockAskingModel.TOOL_NAME).build();
    }

    private static ChatRequest request(String text, ToolSpecification... specs) {
        ChatRequest.Builder builder = ChatRequest.builder()
                .messages(List.of(UserMessage.from(text)));
        if (specs.length > 0) {
            builder.toolSpecifications(List.of(specs));
        }
        return builder.build();
    }
}
