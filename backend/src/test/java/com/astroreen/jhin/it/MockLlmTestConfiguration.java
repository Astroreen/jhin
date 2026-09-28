package com.astroreen.jhin.it;

import com.astroreen.jhin.core.llm.LlmProviderFactory;
import com.astroreen.jhin.core.llm.ProviderConfig;
import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolProvider;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import dev.langchain4j.model.output.TokenUsage;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;

/**
 * Mock LLM для e2e: фабрика формата {@code mock} + детерминированный туал {@code it_echo}.
 * Провайдер создаётся через {@code POST /providers} с {@code format:"mock"} —
 * {@link com.astroreen.jhin.core.llm.ProviderRegistry} подхватывает фабрику автоматически.
 * Скрипт на run (каждый {@code create} — новый экземпляр): ход 1 — tool call {@code it_echo}
 * {@code {"text":"hello"}}, ход 2 — финальный текст {@code done}.
 */
@TestConfiguration
public class MockLlmTestConfiguration {

    static final String FORMAT = "mock";
    static final String TOOL_NAME = "it_echo";
    static final String ECHO_TEXT = "hello";
    static final String FINAL_TEXT = "done";
    static final String CALL_ID = "it-echo-call-1";

    @Bean
    public LlmProviderFactory mockLlmProviderFactory() {
        return new LlmProviderFactory() {
            @Override
            public String format() {
                return FORMAT;
            }

            @Override
            public ChatModel create(ProviderConfig cfg) {
                return new ScriptedEchoModel();
            }
        };
    }

    @Bean
    public ToolProvider itEchoToolProvider() {
        return () -> List.of(echoTool());
    }

    /** Эхо-тул: возвращает аргумент {@code text} как content — без внешних процессов. */
    static ToolDefinition echoTool() {
        return new ToolDefinition() {
            @Override
            public String name() {
                return TOOL_NAME;
            }

            @Override
            public String label() {
                return "it_echo";
            }

            @Override
            public String description() {
                return "test echo tool: returns the text argument";
            }

            @Override
            public Map<String, Object> parametersSchema() {
                return Map.of(
                        "type", "object", "properties", Map.of("text", Map.of("type", "string")));
            }

            @Override
            public String promptSnippet() {
                return "returns the given text";
            }

            @Override
            public List<String> promptGuidelines() {
                return List.of();
            }

            @Override
            public ToolResult execute(ToolCall call, ToolContext ctx) {
                Object text = call.arguments().get("text");
                return ToolResult.ok(text == null ? "" : String.valueOf(text));
            }
        };
    }

    /** Скриптованная модель одного run'а: тул-колл, затем финальный текст. */
    static final class ScriptedEchoModel implements ChatModel {

        private final AtomicInteger turns = new AtomicInteger();

        @Override
        public ChatResponse doChat(ChatRequest request) {
            if (turns.getAndIncrement() == 0) {
                return ChatResponse.builder()
                        .aiMessage(AiMessage.from(List.of(ToolExecutionRequest.builder()
                                .id(CALL_ID)
                                .name(TOOL_NAME)
                                .arguments("{\"text\":\"" + ECHO_TEXT + "\"}")
                                .build())))
                        .tokenUsage(new TokenUsage(3, 5, 8))
                        .build();
            }
            return ChatResponse.builder()
                    .aiMessage(AiMessage.from(FINAL_TEXT))
                    .tokenUsage(new TokenUsage(3, 5, 8))
                    .build();
        }
    }
}
