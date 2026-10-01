/**
 * In-memory {@link EventLog} fake for agent tests: allocates gap-free per
 * session sequences and records every appended event. The real implementation
 * lives in the sessions plugin and is package-private there, so the agent
 * tests exercise the exported API contract against this fake instead.
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

final class FakeEventLog implements EventLog {

    private final Map<String, List<EventRecord>> sessions = new ConcurrentHashMap<>();

    @Override
    public EventRecord append(String sessionId, EventType type, String payload) {
        List<EventRecord> log = sessions.computeIfAbsent(sessionId, key -> new CopyOnWriteArrayList<>());
        synchronized (log) {
            long seq = log.isEmpty() ? 1 : log.get(log.size() - 1).seq() + 1;
            EventRecord record = new EventRecord(sessionId, seq, System.currentTimeMillis(), type, payload);
            log.add(record);
            return record;
        }
    }

    @Override
    public List<EventRecord> list(String sessionId, long afterSeq) {
        List<EventRecord> log = sessions.getOrDefault(sessionId, List.of());
        List<EventRecord> out = new ArrayList<>();
        for (EventRecord record : log) {
            if (record.seq() > afterSeq) {
                out.add(record);
            }
        }
        return List.copyOf(out);
    }

    /**
     * The wire event types of one session, in append order.
     *
     * @param sessionId the session to read
     * @return the recorded event kinds
     */
    List<EventType> types(String sessionId) {
        return list(sessionId, 0).stream().map(EventRecord::type).toList();
    }
}
