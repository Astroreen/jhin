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
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
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
    private final ConcurrentHashMap<String, CopyOnWriteArrayList<Subscription>> subscriptions =
            new ConcurrentHashMap<>();

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

    /**
     * Подписка на новые события сессии. Уведомление приходит строго после успешной записи
     * (seq уже назначен) и в порядке seq — с потока {@link WriteQueue}. Контракт слушателя:
     * не блокировать и не бросать (исключение проглатывается и не ломает append).
     */
    public EventSubscription subscribe(String sessionId, Consumer<Event> listener) {
        Subscription subscription = new Subscription(sessionId, listener);
        subscriptions
                .computeIfAbsent(sessionId, id -> new CopyOnWriteArrayList<>())
                .add(subscription);
        return subscription;
    }

    /** Живых подписок на все сессии (для контроля утечек). */
    public int subscriptionCount() {
        return subscriptions.values().stream().mapToInt(List::size).sum();
    }

    private void notifyListeners(Event event) {
        List<Subscription> listeners = subscriptions.get(event.sessionId());
        if (listeners == null) {
            return;
        }
        for (Subscription subscription : listeners) {
            try {
                subscription.listener.accept(event);
            } catch (Exception ignored) {
                // контракт: сломанный слушатель не ломает append и не мешает остальным
            }
        }
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
        Event event = new Event(sessionId, seq, ts, type, parsePayload(payloadJson));
        notifyListeners(event);
        return event;
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

    private final class Subscription implements EventSubscription {

        private final String sessionId;
        private final Consumer<Event> listener;
        private final AtomicBoolean active = new AtomicBoolean(true);

        Subscription(String sessionId, Consumer<Event> listener) {
            this.sessionId = sessionId;
            this.listener = listener;
        }

        @Override
        public void unsubscribe() {
            if (active.compareAndSet(true, false)) {
                subscriptions.computeIfPresent(sessionId, (id, listeners) -> {
                    listeners.remove(this);
                    return listeners.isEmpty() ? null : listeners;
                });
            }
        }

        @Override
        public boolean isActive() {
            return active.get();
        }
    }
}
