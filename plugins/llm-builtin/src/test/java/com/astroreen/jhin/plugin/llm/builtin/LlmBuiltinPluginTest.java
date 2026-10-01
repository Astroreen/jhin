/**
 * Entry-point behaviour: {@code start} publishes exactly the three built-in
 * {@code LlmProviderFactory} services — one per format, each under its format
 * as the service qualifier (several implementations of one type must coexist,
 * and the registry refuses a duplicate {@code (type, qualifier)} pair).
 */
package com.astroreen.jhin.plugin.llm.builtin;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.llm.api.LlmProviderFactory;
import com.astroreen.jhin.plugin.llm.builtin.RecordingServiceRegistry.Publication;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class LlmBuiltinPluginTest {

    private RecordingServiceRegistry services;

    @BeforeEach
    void setUp() {
        services = new RecordingServiceRegistry();
    }

    @Test
    void startPublishesThreeFactoriesUnderTheirFormatQualifiers() {
        new LlmBuiltinPlugin().start(new FakePluginContext(services));

        List<LlmProviderFactory> factories = services.findAll(LlmProviderFactory.class);
        assertThat(factories).hasSize(3);
        assertThat(factories).extracting(LlmProviderFactory::format)
                .containsExactlyInAnyOrder("anthropic", "openai", "gemini");

        List<Publication> publications = services.publications();
        assertThat(publications).hasSize(3);
        assertThat(publications).allSatisfy(publication -> {
            assertThat(publication.type()).isEqualTo(LlmProviderFactory.class);
            assertThat(publication.qualifier()).isNotBlank();
        });
        assertThat(publications)
                .extracting(Publication::qualifier)
                .containsExactlyInAnyOrder("anthropic", "openai", "gemini");
    }

    @Test
    void eachPublishedInstanceMatchesItsFormat() {
        new LlmBuiltinPlugin().start(new FakePluginContext(services));

        assertThat(services.find(LlmProviderFactory.class, "anthropic"))
                .containsInstanceOf(AnthropicFactory.class);
        assertThat(services.find(LlmProviderFactory.class, "openai"))
                .containsInstanceOf(OpenAiFactory.class);
        assertThat(services.find(LlmProviderFactory.class, "gemini"))
                .containsInstanceOf(GeminiFactory.class);
    }

    @Test
    void qaFlagPublishesTheMockFactoryAsWell() {
        new LlmBuiltinPlugin().start(
                new FakePluginContext(services, java.util.Map.of("qa", "true")));

        assertThat(services.findAll(LlmProviderFactory.class)).hasSize(4);
        assertThat(services.find(LlmProviderFactory.class, "mock"))
                .containsInstanceOf(MockFactory.class);
    }
}
