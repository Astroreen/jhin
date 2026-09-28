package com.astroreen.jhin.core.llm;

import dev.langchain4j.model.anthropic.AnthropicChatModel;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.googleai.GoogleAiGeminiChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Встроенные фабрики LLM-бэкендов: anthropic, openai (openai-совместимые эндпоинты через
 * baseUrl) и gemini. Каждая — бин {@link LlmProviderFactory}, реестр собирает их списком.
 */
@Configuration
public class BuiltinFactories {

    @Bean
    public LlmProviderFactory anthropicLlmProviderFactory() {
        return new LlmProviderFactory() {
            @Override
            public String format() {
                return "anthropic";
            }

            @Override
            public ChatModel create(ProviderConfig cfg) {
                return AnthropicChatModel.builder()
                        .apiKey(cfg.apiKey())
                        .modelName(cfg.model())
                        .build();
            }
        };
    }

    @Bean
    public LlmProviderFactory openaiLlmProviderFactory() {
        return new LlmProviderFactory() {
            @Override
            public String format() {
                return "openai";
            }

            @Override
            public ChatModel create(ProviderConfig cfg) {
                OpenAiChatModel.OpenAiChatModelBuilder builder = OpenAiChatModel.builder()
                        .apiKey(cfg.apiKey())
                        .modelName(cfg.model());
                if (cfg.baseUrl() != null && !cfg.baseUrl().isBlank()) {
                    builder.baseUrl(cfg.baseUrl());
                }
                return builder.build();
            }
        };
    }

    @Bean
    public LlmProviderFactory geminiLlmProviderFactory() {
        return new LlmProviderFactory() {
            @Override
            public String format() {
                return "gemini";
            }

            @Override
            public ChatModel create(ProviderConfig cfg) {
                GoogleAiGeminiChatModel.GoogleAiGeminiChatModelBuilder builder =
                        GoogleAiGeminiChatModel.builder().apiKey(cfg.apiKey()).modelName(cfg.model());
                if (cfg.baseUrl() != null && !cfg.baseUrl().isBlank()) {
                    builder.baseUrl(cfg.baseUrl());
                }
                return builder.build();
            }
        };
    }
}
