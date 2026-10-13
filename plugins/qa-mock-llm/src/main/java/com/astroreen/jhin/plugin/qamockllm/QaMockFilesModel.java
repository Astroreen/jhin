/**
 * The deterministic scripted chat model behind the multi-file seam of the
 * {@code mock} format ({@code model: files}): while the request offers a
 * {@code write} tool, the first two calls emit one {@code write} tool call
 * each — two different files with known line counts — and every later call
 * answers with short text. The run therefore ends with a changed-files
 * summary of exactly two paths and exact {@code +N/−0} stats, the T310
 * end-to-end fixture.
 *
 * <p>The script is stateless across runs and stateful within one model
 * instance, exactly like {@link QaMockChatModel}: the agent loop resolves one
 * {@link ChatModel} per run and reuses it for every model turn, so the
 * call counter on this instance is what makes the run write exactly two
 * files. When no {@code write} tool is offered, the text answer comes
 * directly.
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
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;

final class QaMockFilesModel implements ChatModel {

    /** The tool the scripted run calls twice when it is offered. */
    static final String TOOL_NAME = "write";

    /** The call id of the first scripted tool call. */
    static final String FIRST_CALL_ID = "qa-mock-file-1";

    /** The call id of the second scripted tool call. */
    static final String SECOND_CALL_ID = "qa-mock-file-2";

    /** The file the first scripted tool call writes. */
    static final String FIRST_PATH = "docs/alpha.txt";

    /** The file the second scripted tool call writes. */
    static final String SECOND_PATH = "src/beta.txt";

    /** The two-line content of {@link #FIRST_PATH}. */
    static final String FIRST_CONTENT = "alpha one\nalpha two";

    /** The three-line content of {@link #SECOND_PATH}. */
    static final String SECOND_CONTENT = "beta one\nbeta two\nbeta three";

    /** The arguments of the first scripted tool call. */
    static final String FIRST_ARGUMENTS =
            "{\"path\":\"" + FIRST_PATH + "\",\"content\":\""
                    + FIRST_CONTENT.replace("\n", "\\n") + "\"}";

    /** The arguments of the second scripted tool call. */
    static final String SECOND_ARGUMENTS =
            "{\"path\":\"" + SECOND_PATH + "\",\"content\":\""
                    + SECOND_CONTENT.replace("\n", "\\n") + "\"}";

    /** The short text answer of every turn after the two tool calls. */
    static final String TEXT_ANSWER = "Done.";

    /** The number of scripted tool calls this model emits. */
    static final int SCRIPTED_CALLS = 2;

    private final Logger log;
    private final AtomicInteger calls = new AtomicInteger();

    QaMockFilesModel(Logger log) {
        this.log = log;
    }

    /**
     * Answers with two {@code write} tool calls — {@link #FIRST_PATH} and
     * {@link #SECOND_PATH} — on the first two calls that offer the
     * {@code write} tool, and with {@link #TEXT_ANSWER} otherwise.
     *
     * @param request the chat request to answer
     * @return the scripted answer
     */
    @Override
    public ChatResponse doChat(ChatRequest request) {
        int offered = toolCount(request);
        log.info("qa-mock-llm: tool specifications observed: {}", offered);
        if (offersWrite(request)) {
            int nth = calls.getAndIncrement();
            if (nth == 0) {
                return ChatResponse.builder().aiMessage(AiMessage.from(toolCall(
                        FIRST_CALL_ID, FIRST_ARGUMENTS))).build();
            }
            if (nth == 1) {
                return ChatResponse.builder().aiMessage(AiMessage.from(toolCall(
                        SECOND_CALL_ID, SECOND_ARGUMENTS))).build();
            }
        }
        return ChatResponse.builder().aiMessage(AiMessage.from(TEXT_ANSWER)).build();
    }

    /** The tool call carrying the given id and arguments. */
    private static ToolExecutionRequest toolCall(String id, String arguments) {
        return ToolExecutionRequest.builder()
                .id(id)
                .name(TOOL_NAME)
                .arguments(arguments)
                .build();
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
