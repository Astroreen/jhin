/**
 * Acceptance test: 500 concurrent appends across 5 sessions under 5 threads
 * produce gap-free per-session sequences 1..100. Sequence allocation runs
 * inside one write unit per append, so the kernel write lane keeps it atomic.
 */
package com.astroreen.jhin.plugin.sessions;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventRecord;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.SessionStore;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.stream.LongStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class EventLogConcurrencyTest {

    private static final int SESSIONS = 5;
    private static final int THREADS = 5;
    private static final int APPENDS_PER_THREAD = 100;
    private static final int TOTAL = SESSIONS * 100;

    @TempDir
    Path tmp;

    private TestDbAccess db;
    private RecordingStreamRegistry streams;
    private EventLog eventLog;
    private List<String> sessionIds;

    @BeforeEach
    void setUp() {
        db = TestDbAccess.open(tmp);
        db.migrate(Migrations.all());
        streams = new RecordingStreamRegistry();
        SessionStore store = new SessionStoreImpl(db);
        eventLog = new EventLogImpl(db, streams);
        sessionIds = new ArrayList<>();
        for (int i = 0; i < SESSIONS; i++) {
            sessionIds.add(store.create("session-" + i, "/tmp/" + i).id());
        }
    }

    @AfterEach
    void tearDown() {
        db.close();
    }

    @Test
    void fiveHundredConcurrentAppendsProduceGapFreeSequences() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(THREADS);
        try {
            CountDownLatch start = new CountDownLatch(1);
            List<Future<?>> futures = new ArrayList<>();
            for (int thread = 0; thread < THREADS; thread++) {
                futures.add(pool.submit(() -> {
                    start.await();
                    for (int i = 0; i < APPENDS_PER_THREAD; i++) {
                        eventLog.append(sessionIds.get(i % SESSIONS), EventType.TEXT_DELTA, "{}");
                    }
                    return null;
                }));
            }
            start.countDown();
            for (Future<?> future : futures) {
                future.get(60, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }

        for (String sessionId : sessionIds) {
            List<EventRecord> events = eventLog.list(sessionId, 0);
            assertThat(events).hasSize(TOTAL / SESSIONS);
            assertThat(events.stream().map(EventRecord::seq))
                    .containsExactlyElementsOf(LongStream.rangeClosed(1, 100).boxed().toList());
        }
        assertThat(streams.allPublished()).hasSize(TOTAL);
    }
}
