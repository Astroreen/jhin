/**
 * SQLite-backed {@link EventLog} over the {@code jhin_sessions_events} table.
 *
 * <p>Sequence allocation ({@code max + 1}) and the insert run in one
 * {@code DbAccess.write} unit, so the kernel write queue makes them atomic with
 * respect to every other write and sequences stay gap-free under concurrency.
 * The stream publication happens after the write unit has returned: an event is
 * never visible on the topic before it is durable.
 */
package com.astroreen.jhin.plugin.sessions;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.db.DbAccess;
import com.astroreen.jhin.sdk.stream.StreamEvent;
import com.astroreen.jhin.sdk.stream.StreamRegistry;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

final class EventLogImpl implements EventLog {

    private final DbAccess db;
    private final StreamRegistry streams;

    EventLogImpl(DbAccess db, StreamRegistry streams) {
        this.db = db;
        this.streams = streams;
    }

    @Override
    public EventRecord append(String sessionId, EventType type, String payload) {
        Objects.requireNonNull(sessionId, "sessionId");
        Objects.requireNonNull(type, "type");
        Objects.requireNonNull(payload, "payload");
        EventRecord record = db.write(connection -> {
            try (PreparedStatement check = connection.prepareStatement(
                    "SELECT 1 FROM jhin_sessions_sessions WHERE id = ?")) {
                check.setString(1, sessionId);
                try (ResultSet rs = check.executeQuery()) {
                    if (!rs.next()) {
                        throw new PluginException("unknown session id: " + sessionId);
                    }
                }
            }
            long seq = 1;
            try (PreparedStatement max = connection.prepareStatement(
                    "SELECT MAX(seq) FROM jhin_sessions_events WHERE session_id = ?")) {
                max.setString(1, sessionId);
                try (ResultSet rs = max.executeQuery()) {
                    if (rs.next()) {
                        long previous = rs.getLong(1);
                        if (!rs.wasNull()) {
                            seq = previous + 1;
                        }
                    }
                }
            }
            long ts = System.currentTimeMillis();
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO jhin_sessions_events(session_id, seq, ts, type, payload)"
                            + " VALUES (?, ?, ?, ?, ?)")) {
                insert.setString(1, sessionId);
                insert.setLong(2, seq);
                insert.setLong(3, ts);
                insert.setString(4, type.wire());
                insert.setString(5, payload);
                insert.executeUpdate();
            }
            return new EventRecord(sessionId, seq, ts, type, payload);
        });
        streams.publish(topic(sessionId), new StreamEvent(record.type().wire(), body(record)));
        return record;
    }

    @Override
    public List<EventRecord> list(String sessionId, long afterSeq) {
        Objects.requireNonNull(sessionId, "sessionId");
        return db.read(connection -> {
            List<EventRecord> out = new ArrayList<>();
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT session_id, seq, ts, type, payload FROM jhin_sessions_events"
                            + " WHERE session_id = ? AND seq > ? ORDER BY seq")) {
                query.setString(1, sessionId);
                query.setLong(2, afterSeq);
                try (ResultSet rs = query.executeQuery()) {
                    while (rs.next()) {
                        out.add(new EventRecord(
                                rs.getString("session_id"),
                                rs.getLong("seq"),
                                rs.getLong("ts"),
                                EventType.fromWire(rs.getString("type")),
                                rs.getString("payload")));
                    }
                }
            }
            return List.copyOf(out);
        });
    }

    /**
     * The stream topic of one session.
     *
     * @param sessionId the session id
     * @return {@code sessions/<id>}
     */
    static String topic(String sessionId) {
        return "sessions/" + sessionId;
    }

    /**
     * The wire body of one event: {@code seq}, {@code ts}, {@code type} and
     * {@code payload}. Shared with the SSE route so replay frames and live
     * frames have the exact same shape.
     *
     * @param record the event
     * @return the body map published on the topic and written to SSE frames
     */
    static Map<String, Object> body(EventRecord record) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("seq", record.seq());
        body.put("ts", record.ts());
        body.put("type", record.type().wire());
        body.put("payload", record.payload());
        return body;
    }
}
