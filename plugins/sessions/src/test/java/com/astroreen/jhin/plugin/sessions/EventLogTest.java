/**
 * Event log behaviour: persistence before publication, {@code list} replay
 * semantics and the failure contract for unknown sessions (a rejected append
 * writes nothing).
 */
package com.astroreen.jhin.plugin.sessions;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import com.astroreen.jhin.sdk.PluginException;
import com.astroreen.jhin.sdk.stream.StreamEvent;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class EventLogTest {

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private RecordingStreamRegistry streams;
    private SessionStore store;
    private EventLog eventLog;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        db.migrate(Migrations.all());
        streams = new RecordingStreamRegistry();
        store = new SessionStoreImpl(db);
        eventLog = new EventLogImpl(db, streams);
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void appendPersistsThenPublishesToSessionTopic() {
        Session session = store.create("alice", "demo", "/tmp/demo");

        EventRecord first = eventLog.append(session.id(), EventType.USER_MESSAGE, "{\"text\":\"hi\"}");
        EventRecord second = eventLog.append(session.id(), EventType.TEXT_DELTA, "{\"text\":\"ho\"}");

        assertThat(first.sessionId()).isEqualTo(session.id());
        assertThat(first.seq()).isEqualTo(1L);
        assertThat(first.ts()).isPositive();
        assertThat(first.payload()).isEqualTo("{\"text\":\"hi\"}");
        assertThat(second.seq()).isEqualTo(2L);

        List<StreamEvent> published = streams.publishedOn("sessions/" + session.id());
        assertThat(published).hasSize(2);
        assertThat(published.get(0).type()).isEqualTo("user_message");
        assertThat(published.get(0).payload()).isEqualTo(Map.of(
                "seq", 1L,
                "ts", first.ts(),
                "type", "user_message",
                "payload", "{\"text\":\"hi\"}"));
        assertThat(published.get(1).type()).isEqualTo("text_delta");
    }

    @Test
    void listReturnsEventsAfterTheGivenSeq() {
        Session session = store.create("demo", "/tmp/demo");
        for (int i = 0; i < 5; i++) {
            eventLog.append(session.id(), EventType.TEXT_DELTA, "{}");
        }

        List<EventRecord> all = eventLog.list(session.id(), 0);
        assertThat(all).hasSize(5);
        assertThat(all.stream().map(EventRecord::seq)).containsExactly(1L, 2L, 3L, 4L, 5L);

        List<EventRecord> tail = eventLog.list(session.id(), 3);
        assertThat(tail.stream().map(EventRecord::seq)).containsExactly(4L, 5L);
    }

    @Test
    void appendToUnknownSessionThrowsAndWritesNothing() {
        Session session = store.create("demo", "/tmp/demo");
        eventLog.append(session.id(), EventType.ERROR, "{}");
        long rowsBefore = countEventRows();

        assertThatThrownBy(() -> eventLog.append("missing-session", EventType.TEXT_DELTA, "{}"))
                .isInstanceOf(PluginException.class)
                .hasMessageContaining("missing-session");

        assertThat(countEventRows()).isEqualTo(rowsBefore);
        assertThat(streams.allPublished()).hasSize(1);
    }

    private long countEventRows() {
        return db.read(connection -> {
            try (var statement = connection.createStatement();
                    var rs = statement.executeQuery("SELECT count(*) FROM jhin_sessions_events")) {
                return rs.next() ? rs.getLong(1) : -1;
            }
        });
    }
}
