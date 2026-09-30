/**
 * Append-only event log of a session with gap-free per-session sequences.
 *
 * <p>Sequence numbers are allocated inside the kernel write queue together
 * with the insert, so concurrent appends never produce gaps or duplicates.
 * Every successful append is published on the {@code sessions/<id>} topic after
 * it is persisted.
 */
package com.astroreen.jhin.plugin.sessions.api;

import java.util.List;

public interface EventLog {

    /**
     * Appends one event to a session. The {@code seq} is allocated as
     * {@code max + 1} of the session inside the write queue and is therefore
     * gap-free under concurrent appends. The event is persisted first and then
     * published on {@code sessions/<id>} as {@code StreamEvent(type, {seq, ts,
     * type, payload})}.
     *
     * @param sessionId the session to append to
     * @param type      the event kind
     * @param payload   the JSON payload of the event
     * @return the persisted event with its allocated {@code seq}
     * @throws com.astroreen.jhin.sdk.PluginException when the session is
     *         unknown; nothing is written in that case
     */
    EventRecord append(String sessionId, EventType type, String payload);

    /**
     * Lists the events of one session with {@code seq} greater than
     * {@code afterSeq}, in sequence order. Called for SSE replay where
     * {@code afterSeq} is the {@code fromSeq} query parameter.
     *
     * @param sessionId the session to read
     * @param afterSeq  exclusive lower bound on {@code seq}
     * @return the matching events in ascending sequence order
     */
    List<EventRecord> list(String sessionId, long afterSeq);
}
