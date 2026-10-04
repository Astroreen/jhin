/**
 * {@link com.astroreen.jhin.plugin.sessions.api.TitleService} implementation
 * of the agent plugin: proposes a short session title through the configured
 * LLM provider of the session.
 *
 * <p>The request is built from the FIRST {@code user_message} event and the
 * LAST {@code message_end} event of the session history. The model is asked
 * for a title of at most {@value #MAX_TITLE_CHARS} characters and the answer
 * is truncated defensively, so the returned title never exceeds the limit.
 *
 * <p><b>Failure semantics.</b> The title is never written here — the caller
 * ({@code jhin.sessions}) owns the persistence. Any failure (no provider
 * configured, the provider factory missing, a model error, a timeout surfacing
 * as a model exception, a refusal or an empty answer) is propagated as a
 * {@link RuntimeException}, which the lifecycle service turns into
 * {@code 503 title_service_unavailable}; the stored title stays unchanged.
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.plugin.llm.api.ProviderRegistry;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.TitleService;
import com.astroreen.jhin.sdk.json.Json;
import dev.langchain4j.data.message.ChatMessage;
import dev.langchain4j.data.message.UserMessage;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.request.ChatRequest;
import dev.langchain4j.model.chat.response.ChatResponse;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;

final class TitleServiceImpl implements TitleService {

    /** The hard upper bound on a generated title, in characters. */
    static final int MAX_TITLE_CHARS = 60;

    private final ProviderRegistry providers;
    private final Logger log;

    TitleServiceImpl(ProviderRegistry providers, Logger log) {
        this.providers = providers;
        this.log = log;
    }

    /**
     * Proposes a short title for one session from its event history.
     *
     * @param session the session to retitle
     * @param history the full event history of the session, in sequence order
     * @return the new title; never {@code null} or blank and never longer
     *         than {@value #MAX_TITLE_CHARS} characters
     */
    @Override
    public String regenerate(Session session, List<EventRecord> history) {
        try {
            ChatModel model = modelFor(session);
            String raw = ask(model, prompt(session, history));
            String title = normalize(raw);
            if (title.isEmpty()) {
                throw new IllegalStateException("the model produced no title");
            }
            return title;
        } catch (RuntimeException e) {
            log.warn("title regeneration failed for session {}", session.id(), e);
            throw e;
        }
    }

    /**
     * The live chat model behind the session's configured provider: the same
     * seam the agent loop mints its run model through.
     */
    private ChatModel modelFor(Session session) {
        String providerId = session.providerId();
        if (providerId == null || providerId.isBlank()) {
            throw new IllegalStateException("session has no provider configured");
        }
        return providers.modelFor(session.accountId(), providerId);
    }

    /**
     * One-shot model call; no tools are offered, so the answer is plain text.
     */
    private static String ask(ChatModel model, String prompt) {
        List<ChatMessage> messages = new ArrayList<>();
        messages.add(UserMessage.from(prompt));
        ChatResponse response = model.chat(ChatRequest.builder().messages(messages).build());
        if (response == null || response.aiMessage() == null) {
            throw new IllegalStateException("the model returned no answer");
        }
        return response.aiMessage().text();
    }

    /**
     * The title request: the instruction, the first user message and the last
     * assistant message of the session.
     */
    private static String prompt(Session session, List<EventRecord> history) {
        StringBuilder prompt = new StringBuilder();
        prompt.append("You title conversations. Propose a short title of at most ")
                .append(MAX_TITLE_CHARS)
                .append(" characters for this conversation. Reply with the title only:")
                .append(" one line, no quotes, no trailing period.\n");
        String user = firstText(history, EventType.USER_MESSAGE);
        String assistant = lastText(history, EventType.MESSAGE_END);
        if (user == null && assistant == null) {
            prompt.append("\nCurrent title: ").append(session.title() == null ? "" : session.title());
            return prompt.toString();
        }
        if (user != null) {
            prompt.append("\nUser: ").append(user);
        }
        if (assistant != null) {
            prompt.append("\nAssistant: ").append(assistant);
        }
        return prompt.toString();
    }

    /**
     * The payload text of the first event of one kind; {@code null} when the
     * history carries none.
     */
    private static String firstText(List<EventRecord> history, EventType type) {
        for (EventRecord record : history) {
            if (record.type() == type) {
                return textOf(record.payload());
            }
        }
        return null;
    }

    /**
     * The payload text of the last event of one kind; {@code null} when the
     * history carries none.
     */
    private static String lastText(List<EventRecord> history, EventType type) {
        String text = null;
        for (EventRecord record : history) {
            if (record.type() == type) {
                text = textOf(record.payload());
            }
        }
        return text;
    }

    /** The {@code text} field of a payload JSON, {@code null} when absent. */
    private static String textOf(String payloadJson) {
        if (payloadJson == null || payloadJson.isBlank()) {
            return null;
        }
        try {
            Map<String, Object> payload = Json.readMap(payloadJson);
            Object text = payload.get("text");
            return (text == null) ? null : String.valueOf(text);
        } catch (RuntimeException e) {
            return null;
        }
    }

    /**
     * Normalizes a raw model answer into a title: first line, unwrapped
     * quotes, trimmed and truncated to {@value #MAX_TITLE_CHARS} characters.
     */
    static String normalize(String raw) {
        if (raw == null) {
            return "";
        }
        String title = raw.trim();
        int newline = title.indexOf('\n');
        if (newline >= 0) {
            title = title.substring(0, newline);
        }
        title = title.trim();
        if (title.length() >= 2
                && ((title.startsWith("\"") && title.endsWith("\""))
                        || (title.startsWith("'") && title.endsWith("'")))) {
            title = title.substring(1, title.length() - 1).trim();
        }
        if (title.length() > MAX_TITLE_CHARS) {
            title = title.substring(0, MAX_TITLE_CHARS).trim();
        }
        return title;
    }
}
