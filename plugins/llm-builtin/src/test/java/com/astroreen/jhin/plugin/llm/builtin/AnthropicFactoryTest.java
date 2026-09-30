/**
 * {@link AnthropicFactory} behaviour: the format name, offline construction
 * of the Anthropic chat model (with and without a base URL override) and the
 * clear refusal on a missing api key.
 */
package com.astroreen.jhin.plugin.llm.builtin;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.llm.api.ProviderConfig;
import dev.langchain4j.model.anthropic.AnthropicChatModel;
import dev.langchain4j.model.chat.ChatModel;
import org.junit.jupiter.api.Test;

class AnthropicFactoryTest {

    private final AnthropicFactory factory = new AnthropicFactory();

    @Test
    void formatIsAnthropic() {
        assertThat(factory.format()).isEqualTo("anthropic");
    }

    @Test
    void createBuildsTheAnthropicChatModelOffline() {
        ChatModel model = factory.create(new ProviderConfig("sk-test-key", "claude-test", null));

        assertThat(model).isInstanceOf(AnthropicChatModel.class);
        assertThat(model.defaultRequestParameters().modelName()).isEqualTo("claude-test");
    }

    @Test
    void createAppliesTheBaseUrlOverrideWhenPresent() {
        ChatModel model = factory.create(
                new ProviderConfig("sk-test-key", "claude-test", "https://llm.example"));

        assertThat(model).isInstanceOf(AnthropicChatModel.class);
    }

    @Test
    void createRejectsAMissingApiKeyWithAClearMessage() {
        assertThatThrownBy(() -> factory.create(new ProviderConfig(null, "claude-test", null)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("anthropic factory requires a non-blank apiKey");

        assertThatThrownBy(() -> factory.create(new ProviderConfig("  ", "claude-test", null)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("anthropic factory requires a non-blank apiKey");
    }
}
