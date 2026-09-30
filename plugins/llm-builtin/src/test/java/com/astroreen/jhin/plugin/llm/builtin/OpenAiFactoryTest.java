/**
 * {@link OpenAiFactory} behaviour: the format name, offline construction of
 * the OpenAI chat model (with and without a base URL override) and the clear
 * refusal on a missing api key.
 */
package com.astroreen.jhin.plugin.llm.builtin;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.llm.api.ProviderConfig;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.openai.OpenAiChatModel;
import org.junit.jupiter.api.Test;

class OpenAiFactoryTest {

    private final OpenAiFactory factory = new OpenAiFactory();

    @Test
    void formatIsOpenai() {
        assertThat(factory.format()).isEqualTo("openai");
    }

    @Test
    void createBuildsTheOpenAiChatModelOffline() {
        ChatModel model = factory.create(new ProviderConfig("sk-test-key", "gpt-test", null));

        assertThat(model).isInstanceOf(OpenAiChatModel.class);
        assertThat(model.defaultRequestParameters().modelName()).isEqualTo("gpt-test");
    }

    @Test
    void createAppliesTheBaseUrlOverrideWhenPresent() {
        ChatModel model = factory.create(
                new ProviderConfig("sk-test-key", "gpt-test", "https://llm.example"));

        assertThat(model).isInstanceOf(OpenAiChatModel.class);
    }

    @Test
    void createRejectsAMissingApiKeyWithAClearMessage() {
        assertThatThrownBy(() -> factory.create(new ProviderConfig(null, "gpt-test", null)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("openai factory requires a non-blank apiKey");

        assertThatThrownBy(() -> factory.create(new ProviderConfig("  ", "gpt-test", null)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("openai factory requires a non-blank apiKey");
    }
}
