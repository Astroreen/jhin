/**
 * {@link TitleServiceImpl}: the 60-character rule, the title prompt inputs
 * (first {@code user_message} + last {@code message_end}) and the failure
 * semantics (model errors and a missing provider propagate, nothing is
 * written). The qa-mock-llm harness factory drives the title and fail
 * scripts of the {@code mock} format; {@link FakeChatModel} records the exact
 * request the model receives.
 */
package com.astroreen.jhin.plugin.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.llm.api.ProviderConfig;
import com.astroreen.jhin.plugin.qamockllm.QaMockFactory;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import dev.langchain4j.data.message.AiMessage;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.chat.ChatModel;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

class TitleServiceImplTest {

    private final QaMockFactory mockFactory =
            new QaMockFactory(LoggerFactory.getLogger("title-test"));

    @Test
    void returnedTitleNeverExceedsSixtyChars() {
        String longTitle = "A very long title line one that runs past the sixty character limit with ease and more";
        FakeChatModel model = new FakeChatModel().script(AiMessage.from(longTitle));
        TitleServiceImpl titles = new TitleServiceImpl(new FakeProviderRegistry(model), logger());

        String title = titles.regenerate(session("prov", "old"), List.of());

        assertThat(title).hasSize(TitleServiceImpl.MAX_TITLE_CHARS);
        assertThat(title).isEqualTo(longTitle.substring(0, TitleServiceImpl.MAX_TITLE_CHARS));
        assertThat(model.callCount()).isEqualTo(1);
    }

    @Test
    void normalizeDropsExtraLinesAndUnwrapsQuotes() {
        assertThat(TitleServiceImpl.normalize("\"A quoted title\"\nsecond line"))
                .isEqualTo("A quoted title");
        assertThat(TitleServiceImpl.normalize(null)).isEmpty();
    }

    @Test
    void promptCarriesTheFirstUserMessageAndTheLastMessageEnd() {
        FakeChatModel model = new FakeChatModel().script(AiMessage.from("Short title"));
        TitleServiceImpl titles = new TitleServiceImpl(new FakeProviderRegistry(model), logger());

        titles.regenerate(session("prov", "old"), List.of(
                event(1, EventType.USER_MESSAGE, "Fix the login bug in the auth module"),
                event(2, EventType.MESSAGE_END, "Fixed it in auth.ts"),
                event(3, EventType.USER_MESSAGE, "Also rewrite the signup"),
                event(4, EventType.MESSAGE_END, "Signup rewritten")));

        ChatMessage message = model.requests().get(0).messages().get(0);
        String prompt = ((UserMessage) message).singleText();
        assertThat(prompt).contains("Fix the login bug in the auth module");
        assertThat(prompt).contains("Signup rewritten");
        assertThat(prompt).doesNotContain("Also rewrite the signup");
        assertThat(prompt).doesNotContain("Fixed it in auth.ts");
    }

    @Test
    void modelFailurePropagatesAndProducesNoTitle() {
        FakeChatModel model = new FakeChatModel();
        TitleServiceImpl titles = new TitleServiceImpl(new FakeProviderRegistry(model), logger());

        assertThatThrownBy(() -> titles.regenerate(session("prov", "old"), List.of()))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void missingProviderFails() {
        TitleServiceImpl titles =
                new TitleServiceImpl(new FakeProviderRegistry(new FakeChatModel()), logger());

        assertThatThrownBy(() -> titles.regenerate(session(null, "old"), List.of()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("provider");
    }

    @Test
    void emptyHistoryStillAsksTheModel() {
        FakeChatModel model = new FakeChatModel().script(AiMessage.from("Fresh title"));
        TitleServiceImpl titles = new TitleServiceImpl(new FakeProviderRegistry(model), logger());

        String title = titles.regenerate(session("prov", "old"), List.of());

        assertThat(title).isEqualTo("Fresh title");
        assertThat(model.callCount()).isEqualTo(1);
    }

    @Test
    void qaMockTitleModelAnswerIsTruncated() {
        ChatModel model = mockFactory.create(new ProviderConfig(null, QaMockFactory.TITLE_MODEL, null));
        TitleServiceImpl titles = new TitleServiceImpl(new FakeProviderRegistry(model), logger());

        String title = titles.regenerate(session("prov", "old"), List.of(
                event(1, EventType.USER_MESSAGE, "hello"),
                event(2, EventType.MESSAGE_END, "hi")));

        assertThat(title).hasSize(TitleServiceImpl.MAX_TITLE_CHARS);
        assertThat(title).startsWith("Fix the authentication flow");
    }

    @Test
    void qaMockFailingModelPropagates() {
        ChatModel model = mockFactory.create(new ProviderConfig(null, QaMockFactory.FAIL_MODEL, null));
        TitleServiceImpl titles = new TitleServiceImpl(new FakeProviderRegistry(model), logger());

        assertThatThrownBy(() -> titles.regenerate(session("prov", "old"), List.of()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("scripted model failure");
    }

    private static Session session(String providerId, String title) {
        return new Session("s1", "local", title, "/tmp/work", "m", providerId,
                "active", 1L, 2L);
    }

    private static EventRecord event(long seq, EventType type, String text) {
        return new EventRecord("s1", seq, seq * 1000L, type,
                com.astroreen.jhin.sdk.json.Json.write(java.util.Map.of("text", text)));
    }

    private static org.slf4j.Logger logger() {
        return LoggerFactory.getLogger("title-test");
    }
}
