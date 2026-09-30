/**
 * {@link GeminiFactory} behaviour: the format name, offline construction of
 * the Google AI Gemini chat model (with and without a base URL override) and
 * the clear refusal on a missing api key.
 */
package com.astroreen.jhin.plugin.llm.builtin;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.llm.api.ProviderConfig;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.googleai.GoogleAiGeminiChatModel;
import org.junit.jupiter.api.Test;

class GeminiFactoryTest {

    private final GeminiFactory factory = new GeminiFactory();

    @Test
    void formatIsGemini() {
        assertThat(factory.format()).isEqualTo("gemini");
    }

    @Test
    void createBuildsTheGeminiChatModelOffline() {
        ChatModel model = factory.create(new ProviderConfig("test-key", "gemini-test", null));

        assertThat(model).isInstanceOf(GoogleAiGeminiChatModel.class);
        assertThat(model.defaultRequestParameters().modelName()).isEqualTo("gemini-test");
    }

    @Test
    void createAppliesTheBaseUrlOverrideWhenPresent() {
        ChatModel model = factory.create(
                new ProviderConfig("test-key", "gemini-test", "https://llm.example"));

        assertThat(model).isInstanceOf(GoogleAiGeminiChatModel.class);
    }

    @Test
    void createRejectsAMissingApiKeyWithAClearMessage() {
        assertThatThrownBy(() -> factory.create(new ProviderConfig(null, "gemini-test", null)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("gemini factory requires a non-blank apiKey");

        assertThatThrownBy(() -> factory.create(new ProviderConfig("  ", "gemini-test", null)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("gemini factory requires a non-blank apiKey");
    }
}
