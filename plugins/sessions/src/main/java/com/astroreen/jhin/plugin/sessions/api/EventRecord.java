/**
 * One event row of the {@code jhin_sessions_events} table.
 *
 * <p>Sequence numbers are gap-free and allocated by
 * {@link EventLog#append}; {@code seq} orders the events of one session and is
 * the de-duplication key for SSE replay.
 */
package com.astroreen.jhin.plugin.sessions.api;

/**
 * @param sessionId the session the event belongs to
 * @param seq       monotonic sequence number within the session, starting at 1
 * @param ts        append time, epoch milliseconds
 * @param type      the event kind
 * @param payload   JSON payload of the event
 */
public record EventRecord(
        String sessionId,
        long seq,
        long ts,
        EventType type,
        String payload) {}
