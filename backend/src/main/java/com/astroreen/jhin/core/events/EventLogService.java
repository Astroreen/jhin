package com.astroreen.jhin.core.events;

import com.astroreen.jhin.core.db.WriteQueue;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

@Service
public class EventLogService {

    private static final String SQL_INSERT =
            "INSERT INTO events (session_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)";
    private static final String SQL_MAX_SEQ = "SELECT COALESCE(MAX(seq), 0) FROM events WHERE session_id = ?";
    private static final String SQL_READ_RANGE =
            "SELECT session_id, seq, ts, type, payload FROM events WHERE session_id = ? AND seq >= ?"
                    + " ORDER BY seq ASC";

    private final JdbcClient jdbcClient;
    private final WriteQueue writeQueue;
    private final ObjectMapper objectMapper;

    @Autowired
    public EventLogService(
            JdbcClient jdbcClient, WriteQueue writeQueue, ObjectProvider<ObjectMapper> objectMappers) {
        this(jdbcClient, writeQueue, objectMappers.getIfAvailable(ObjectMapper::new));
    }

    public EventLogService(JdbcClient jdbcClient, WriteQueue writeQueue, ObjectMapper objectMapper) {
        this.jdbcClient = jdbcClient;
        this.writeQueue = writeQueue;
        this.objectMapper = objectMapper;
    }

    public CompletableFuture<Event> append(String sessionId, String type, Map<String, Object> payload) {
        return writeQueue.submit(() -> appendNow(sessionId, type, payload));
    }

    public List<Event> readRange(String sessionId, long fromSeq) {
        return jdbcClient
                .sql(SQL_READ_RANGE)
                .param(sessionId)
                .param(fromSeq)
                .query(this::mapRow)
                .list();
    }

    public long latestSeq(String sessionId) {
        return jdbcClient.sql(SQL_MAX_SEQ).param(sessionId).query(EventLogService::mapSeq).single();
    }

    private Event appendNow(String sessionId, String type, Map<String, Object> payload)
            throws JsonProcessingException {
        long seq = latestSeq(sessionId) + 1;
        long ts = System.currentTimeMillis();
        String payloadJson = objectMapper.writeValueAsString(payload);
        jdbcClient
                .sql(SQL_INSERT)
                .param(sessionId)
                .param(seq)
                .param(ts)
                .param(type)
                .param(payloadJson)
                .update();
        return new Event(sessionId, seq, ts, type, parsePayload(payloadJson));
    }

    private Event mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new Event(
                rs.getString("session_id"),
                rs.getLong("seq"),
                rs.getLong("ts"),
                rs.getString("type"),
                parsePayloadQuietly(rs.getString("payload")));
    }

    private static Long mapSeq(ResultSet rs, int rowNum) throws SQLException {
        return rs.getLong(1);
    }

    private JsonNode parsePayload(String payloadJson) throws JsonProcessingException {
        JsonNode node = payloadJson == null || payloadJson.isBlank() ? null : objectMapper.readTree(payloadJson);
        return node == null || node.isNull() ? null : node;
    }

    private JsonNode parsePayloadQuietly(String payloadJson) {
        try {
            return parsePayload(payloadJson);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Corrupt event payload: " + payloadJson, e);
        }
    }
}
