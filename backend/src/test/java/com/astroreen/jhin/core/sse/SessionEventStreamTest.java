package com.astroreen.jhin.core.sse;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.core.db.DatabaseConfig;
import com.astroreen.jhin.core.db.MigrationRunner;
import com.astroreen.jhin.core.db.WriteQueue;
import com.astroreen.jhin.core.events.Event;
import com.astroreen.jhin.core.events.EventLogService;
import com.astroreen.jhin.core.events.EventTypes;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;

class SessionEventStreamTest {

    private static final long AWAIT_TIMEOUT_MILLIS = 5_000;

    @TempDir
    Path jhinHome;

    private WriteQueue writeQueue;
    private ScheduledExecutorService scheduler;
    private GatedEventLog eventLog;
    private SseRegistry registry;
    private SseStreamService streamService;

    @BeforeEach
    void setUp() throws Exception {
        DataSource dataSource = DatabaseConfig.createDataSource(jhinHome);
        new MigrationRunner(dataSource).migrate();
        writeQueue = new WriteQueue();
        eventLog = new GatedEventLog(JdbcClient.create(dataSource), writeQueue, new ObjectMapper());
        scheduler = Executors.newSingleThreadScheduledExecutor();
        registry = new SseRegistry();
        streamService = new SseStreamService(registry, 60_000, 60_000, scheduler);
    }

    @AfterEach
    void tearDown() {
        registry.closeAll();
        streamService.shutdown();
        writeQueue.close();
    }

    @Test
    void replayThenLiveDeliversEachSeqExactlyOnceInOrder() {
        append("s1", 1);
        append("s1", 2);

        FakeSink sink = new FakeSink();
        SessionEventStream stream = new SessionEventStream(eventLog, streamService, sink, "d1", "s1", 0);
        stream.open();

        awaitUntil(() -> sink.frames.size() >= 2);
        append("s1", 3);
        awaitUntil(() -> sink.frames.size() >= 3);
        stream.close();

        assertThat(sink.frames)
                .containsExactly(
                        "id: 1\nevent: text_delta\ndata: {\"text\":\"t1\"}\n\n",
                        "id: 2\nevent: text_delta\ndata: {\"text\":\"t2\"}\n\n",
                        "id: 3\nevent: text_delta\ndata: {\"text\":\"t3\"}\n\n");
    }

    @Test
    void resumeFromSeqDeliversOnlyEventsAfterTheGap() {
        append("s1", 1);
        append("s1", 2);
        append("s1", 3);
        append("s1", 4);
        append("s1", 5);

        FakeSink sink = new FakeSink();
        SessionEventStream stream = new SessionEventStream(eventLog, streamService, sink, "d1", "s1", 4);
        stream.open();

        awaitUntil(() -> sink.frames.size() >= 2);
        stream.close();

        assertThat(seqs(sink)).containsExactly(4L, 5L);
    }

    @Test
    void eventAppendedDuringReplayIsDeliveredExactlyOnce() {
        append("s1", 1);
        append("s1", 2);
        eventLog.arm(false);

        FakeSink sink = new FakeSink();
        SessionEventStream stream = new SessionEventStream(eventLog, streamService, sink, "d1", "s1", 0);
        stream.open();

        awaitUntil(() -> eventLog.entered.getCount() == 0);
        append("s1", 3);
        eventLog.gate.countDown();

        awaitUntil(() -> sink.frames.size() >= 3);
        stream.close();

        assertThat(seqs(sink)).containsExactly(1L, 2L, 3L);
    }

    @Test
    void eventAppendedAfterSnapshotIsDeliveredWithoutGap() {
        append("s1", 1);
        append("s1", 2);
        eventLog.arm(true);

        FakeSink sink = new FakeSink();
        SessionEventStream stream = new SessionEventStream(eventLog, streamService, sink, "d1", "s1", 0);
        stream.open();

        awaitUntil(() -> eventLog.entered.getCount() == 0);
        append("s1", 3);
        eventLog.gate.countDown();

        awaitUntil(() -> sink.frames.size() >= 3);
        stream.close();

        assertThat(seqs(sink)).containsExactly(1L, 2L, 3L);
    }

    @Test
    void twoStreamsOnTheSameSessionBothReceiveAllEvents() {
        FakeSink first = new FakeSink();
        FakeSink second = new FakeSink();
        SessionEventStream firstStream = new SessionEventStream(eventLog, streamService, first, "d1", "s1", 0);
        SessionEventStream secondStream = new SessionEventStream(eventLog, streamService, second, "d2", "s1", 0);
        firstStream.open();
        secondStream.open();

        for (int i = 1; i <= 3; i++) {
            append("s1", i);
        }
        awaitUntil(() -> first.frames.size() >= 3 && second.frames.size() >= 3);
        firstStream.close();
        secondStream.close();

        assertThat(seqs(first)).containsExactly(1L, 2L, 3L);
        assertThat(seqs(second)).containsExactly(1L, 2L, 3L);
        assertThat(second.frames).containsExactlyElementsOf(first.frames);
    }

    @Test
    void closeUnsubscribesUnregistersAndCancelsTimers() {
        FakeSink first = new FakeSink();
        FakeSink second = new FakeSink();
        SessionEventStream firstStream = new SessionEventStream(eventLog, streamService, first, "d1", "s1", 0);
        SessionEventStream secondStream = new SessionEventStream(eventLog, streamService, second, "d1", "s2", 0);
        firstStream.open();
        secondStream.open();
        assertThat(eventLog.subscriptionCount()).isEqualTo(2);
        assertThat(streamService.activeStreamCount()).isEqualTo(2);
        assertThat(sseActive()).isEqualTo(2);

        firstStream.close();
        secondStream.close();
        firstStream.close();

        assertThat(eventLog.subscriptionCount()).isZero();
        assertThat(streamService.activeStreamCount()).isZero();
        assertThat(sseActive()).isZero();
        assertThat(first.completions).hasValue(1);
        assertThat(second.completions).hasValue(1);
    }

    @Test
    void registryCloseDeviceClosesStreamAndClearsResources() {
        FakeSink sink = new FakeSink();
        SessionEventStream stream = new SessionEventStream(eventLog, streamService, sink, "d1", "s1", 0);
        stream.open();
        append("s1", 1);
        awaitUntil(() -> sink.frames.size() >= 1);

        registry.closeDevice("d1");

        assertThat(sink.completions).hasValue(1);
        assertThat(sink.isOpen()).isFalse();
        assertThat(eventLog.subscriptionCount()).isZero();
        assertThat(streamService.activeStreamCount()).isZero();
        assertThat(sseActive()).isZero();

        int delivered = sink.frames.size();
        append("s1", 2);
        sleep(200);
        assertThat(sink.frames).hasSize(delivered);
    }

    @Test
    void sendFailureClosesStreamAndUnsubscribes() {
        SseSink broken = new SseSink() {
            final AtomicBoolean open = new AtomicBoolean(true);

            @Override
            public void send(String frame) {
                throw new UncheckedIOException(new IOException("broken pipe"));
            }

            @Override
            public void comment(String text) {}

            @Override
            public void complete() {
                open.set(false);
            }

            @Override
            public boolean isOpen() {
                return open.get();
            }
        };
        append("s1", 1);

        SessionEventStream stream = new SessionEventStream(eventLog, streamService, broken, "d1", "s1", 0);
        stream.open();

        awaitUntil(() -> eventLog.subscriptionCount() == 0);
        assertThat(streamService.activeStreamCount()).isZero();
        assertThat(sseActive()).isZero();
    }

    private void append(String sessionId, int n) {
        eventLog.append(sessionId, EventTypes.TEXT_DELTA, Map.of("text", "t" + n)).join();
    }

    private int sseActive() {
        return registry.activeCount();
    }

    private static List<Long> seqs(FakeSink sink) {
        return sink.frames.stream()
                .map(frame -> Long.parseLong(frame.substring("id: ".length(), frame.indexOf('\n'))))
                .toList();
    }

    private static void awaitUntil(BooleanSupplier condition) {
        long deadline = System.currentTimeMillis() + AWAIT_TIMEOUT_MILLIS;
        while (System.currentTimeMillis() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            sleep(5);
        }
        assertThat(condition.getAsBoolean())
                .as("condition not met within " + AWAIT_TIMEOUT_MILLIS + "ms")
                .isTrue();
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** EventLog с управляемым readRange: гейт + режим «снимок до/после гейта». */
    static final class GatedEventLog extends EventLogService {

        volatile CountDownLatch gate = new CountDownLatch(0);
        volatile CountDownLatch entered = new CountDownLatch(0);
        volatile boolean snapshotFirst;

        GatedEventLog(JdbcClient jdbcClient, WriteQueue writeQueue, ObjectMapper objectMapper) {
            super(jdbcClient, writeQueue, objectMapper);
        }

        void arm(boolean snapshotFirst) {
            this.snapshotFirst = snapshotFirst;
            this.gate = new CountDownLatch(1);
            this.entered = new CountDownLatch(1);
        }

        @Override
        public List<Event> readRange(String sessionId, long fromSeq) {
            if (snapshotFirst) {
                List<Event> snapshot = super.readRange(sessionId, fromSeq);
                entered.countDown();
                await(gate);
                return snapshot;
            }
            entered.countDown();
            await(gate);
            return super.readRange(sessionId, fromSeq);
        }

        private static void await(CountDownLatch latch) {
            try {
                latch.await(AWAIT_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }
}
