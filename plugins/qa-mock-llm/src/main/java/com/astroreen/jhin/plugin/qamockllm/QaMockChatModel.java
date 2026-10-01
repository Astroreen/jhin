/**
 * The deterministic scripted chat model behind the {@code mock} format: when
 * the request offers a {@code write} tool, the first call emits exactly one
 * {@code write} tool call and the next call answers with short text; when no
 * {@code write} tool is offered, the text answer comes directly.
 *
 * <p>The script is stateless across runs and stateful within one model
 * instance: the agent loop resolves one {@link ChatModel} per run and reuses
 * it for every model turn, so the one-shot flag on this instance is what
 * makes the run call {@code write} exactly once. The tool call carries a file
 * name and text content ({@link #TOOL_ARGUMENTS}), so an end-to-end run can
 * assert a real file appearing in the session workdir after
 * {@code tool_use} / {@code tool_result} were observed.
 *
 * <p>Every call logs the observed tool count
 * ({@code qa-mock-llm: tool specifications observed: N}), the diagnostic seam
 * a QA script greps to prove {@code tools: 0} after the tools plugin was
 * deleted. No network, no delay, fully deterministic.
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

final class QaMockChatModel implements ChatModel {

    /** The tool the scripted run calls once when it is offered. */
    static final String TOOL_NAME = "write";

    /** The call id of the scripted tool call. */
    static final String TOOL_CALL_ID = "qa-mock-call-1";

    /** The file the scripted tool call writes into the session workdir. */
    static final String FILE_PATH = "qa-mock-output.txt";

    /** The file content the scripted tool call writes. */
    static final String FILE_CONTENT = "written by the jhin.qa-mock-llm harness";

    /** The arguments of the scripted tool call: a file name and its content. */
    static final String TOOL_ARGUMENTS =
            "{\"path\":\"" + FILE_PATH + "\",\"content\":\"" + FILE_CONTENT + "\"}";

    /** The short text answer of every non-tool turn. */
    static final String TEXT_ANSWER = "Done.";

    private final Logger log;
    private final AtomicBoolean toolCallEmitted = new AtomicBoolean(false);

    QaMockChatModel(Logger log) {
        this.log = log;
    }

    /**
     * Answers with one {@code write} tool call on the first call that offers
     * the {@code write} tool, and with {@link #TEXT_ANSWER} otherwise.
     *
     * @param request the chat request to answer
     * @return the scripted answer
     */
    @Override
    public ChatResponse doChat(ChatRequest request) {
        int offered = toolCount(request);
        log.info("qa-mock-llm: tool specifications observed: {}", offered);
        if (offersWrite(request) && toolCallEmitted.compareAndSet(false, true)) {
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
    private static boolean offersWrite(ChatRequest request) {
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
