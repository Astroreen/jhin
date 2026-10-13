/**
 * The deterministic scripted chat model behind the {@code ask_user} seam of
 * the {@code mock} format ({@code model: ask}): when the request offers an
 * {@code ask_user} tool, the first call emits exactly one {@code ask_user}
 * tool call — one question with two predefined options — and the next call
 * answers with short text; when no {@code ask_user} tool is offered, the text
 * answer comes directly.
 *
 * <p>The script is stateless across runs and stateful within one model
 * instance, exactly like {@link QaMockChatModel}: the agent loop resolves one
 * {@link ChatModel} per run and reuses it for every model turn, so the
 * one-shot flag on this instance is what makes the run ask exactly one
 * question. The question blocks on the {@code QuestionBridge} of
 * jhin.tools-builtin until the answer arrives, so an end-to-end run can
 * observe the pending-question composer panel, deliver an answer and find it
 * as the tool result — without any network endpoint.
 *
 * <p>Every call logs the observed tool count
 * ({@code qa-mock-llm: tool specifications observed: N}), the same
 * diagnostic seam as {@link QaMockChatModel}. No network, no delay, fully
 * deterministic.
 */
package com.astroreen.jhin.plugin.qamockllm;

import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;

final class QaMockAskingModel implements ChatModel {

    /** The tool the scripted run calls once when it is offered. */
    static final String TOOL_NAME = "ask_user";

    /** The call id of the scripted tool call. */
    static final String TOOL_CALL_ID = "qa-mock-ask-1";

    /** The question of the scripted tool call. */
    static final String QUESTION = "Proceed with the deployment?";

    /** The arguments of the scripted tool call: the question and its options. */
    static final String TOOL_ARGUMENTS =
            "{\"question\":\"" + QUESTION + "\",\"options\":[\"Yes\",\"No\"]}";

    /** The short text answer of every non-tool turn. */
    static final String TEXT_ANSWER = "Done.";

    private final Logger log;
    private final AtomicBoolean toolCallEmitted = new AtomicBoolean(false);

    QaMockAskingModel(Logger log) {
        this.log = log;
    }

    /**
     * Answers with one {@code ask_user} tool call on the first call that
     * offers the {@code ask_user} tool, and with {@link #TEXT_ANSWER}
     * otherwise.
     *
     * @param request the chat request to answer
     * @return the scripted answer
     */
    @Override
    public ChatResponse doChat(ChatRequest request) {
        int offered = toolCount(request);
        log.info("qa-mock-llm: tool specifications observed: {}", offered);
        if (offersAskUser(request) && toolCallEmitted.compareAndSet(false, true)) {
            ToolExecutionRequest call = ToolExecutionRequest.builder()
                    .id(TOOL_CALL_ID)
                    .name(TOOL_NAME)
                    .arguments(TOOL_ARGUMENTS)
                    .build();
            return ChatResponse.builder().aiMessage(AiMessage.from(call)).build();
        }
        return ChatResponse.builder().aiMessage(AiMessage.from(TEXT_ANSWER)).build();
    }

    /** The number of tool specifications the request offers, zero when none. */
    private static int toolCount(ChatRequest request) {
        List<ToolSpecification> specs = request.toolSpecifications();
        return specs == null ? 0 : specs.size();
    }

    /** Whether the request offers a tool named {@link #TOOL_NAME}. */
    private static boolean offersAskUser(ChatRequest request) {
        List<ToolSpecification> specs = request.toolSpecifications();
        if (specs == null) {
            return false;
        }
        for (ToolSpecification spec : specs) {
            if (spec != null && TOOL_NAME.equals(spec.name())) {
                return true;
            }
        }
        return false;
    }
}
