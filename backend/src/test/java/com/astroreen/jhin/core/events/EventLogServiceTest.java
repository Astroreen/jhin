package com.astroreen.jhin.core.events;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.core.db.DatabaseConfig;
import com.astroreen.jhin.core.db.MigrationRunner;
import com.astroreen.jhin.core.db.WriteQueue;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.stream.IntStream;
import java.util.stream.LongStream;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.simple.JdbcClient;

class EventLogServiceTest {

    private static final long TIMEOUT_SECONDS = 10;

    @TempDir
    Path jhinHome;

    private WriteQueue writeQueue;
    private EventLogService eventLog;

    @BeforeEach
    void setUp() throws Exception {
        DataSource dataSource = DatabaseConfig.createDataSource(jhinHome);
        new MigrationRunner(dataSource).migrate();
        writeQueue = new WriteQueue();
        eventLog = new EventLogService(JdbcClient.create(dataSource), writeQueue, new ObjectMapper());
    }

    @AfterEach
    void tearDown() {
        writeQueue.close();
    }

    @Test
    void sequentialAppendsProduceGaplessSeqAndInclusiveReadRange() throws Exception {
        Event first = eventLog.append("s1", EventTypes.USER_MESSAGE, Map.of("n", 1)).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        Event second = eventLog.append("s1", EventTypes.MESSAGE_START, Map.of("n", 2)).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        Event third = eventLog.append("s1", EventTypes.MESSAGE_END, Map.of("n", 3)).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);

        assertThat(List.of(first.seq(), second.seq(), third.seq())).containsExactly(1L, 2L, 3L);
        assertThat(eventLog.latestSeq("s1")).isEqualTo(3);

        List<Event> fromOne = eventLog.readRange("s1", 1);
        assertThat(fromOne).hasSize(3);
        assertThat(fromOne).extracting(Event::seq).containsExactly(1L, 2L, 3L);

        List<Event> fromTwo = eventLog.readRange("s1", 2);
        assertThat(fromTwo).hasSize(2);
        assertThat(fromTwo).extracting(Event::seq).containsExactly(2L, 3L);

        assertThat(eventLog.readRange("s1", 99)).isEmpty();
    }

    @Test
    @SuppressWarnings("unchecked")
    void hundredConcurrentAppendsProduceGaplessSeqWithoutDuplicates() throws Exception {
        CompletableFuture<Event>[] futures = new CompletableFuture[100];
        IntStream.range(0, 100).parallel().forEach(i -> futures[i] =
                eventLog.append("s1", EventTypes.TEXT_DELTA, Map.of("i", i)));

        CompletableFuture.allOf(futures).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);

        List<Event> events = eventLog.readRange("s1", 1);
        assertThat(events).hasSize(100);
        assertThat(events)
                .extracting(Event::seq)
                .containsExactlyElementsOf(LongStream.rangeClosed(1, 100).boxed().toList());
        assertThat(eventLog.latestSeq("s1")).isEqualTo(100);
    }

    @Test
    void twoSessionsKeepIndependentSeq() throws Exception {
        List<CompletableFuture<Event>> futures = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            futures.add(eventLog.append("session-a", EventTypes.TEXT_DELTA, Map.of("i", i)));
            futures.add(eventLog.append("session-b", EventTypes.TEXT_DELTA, Map.of("i", i)));
        }
        for (CompletableFuture<Event> future : futures) {
            future.get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        }

        assertThat(eventLog.latestSeq("session-a")).isEqualTo(5);
        assertThat(eventLog.latestSeq("session-b")).isEqualTo(5);

        List<Event> eventsA = eventLog.readRange("session-a", 1);
        assertThat(eventsA).extracting(Event::seq).containsExactly(1L, 2L, 3L, 4L, 5L);
        assertThat(eventsA).extracting(e -> e.payloadAsMap().get("i")).containsExactly(0, 1, 2, 3, 4);

        List<Event> eventsB = eventLog.readRange("session-b", 1);
        assertThat(eventsB).extracting(Event::seq).containsExactly(1L, 2L, 3L, 4L, 5L);
        assertThat(eventsB).extracting(e -> e.payloadAsMap().get("i")).containsExactly(0, 1, 2, 3, 4);
    }

    @Test
    void nestedPayloadSurvivesRoundtrip() throws Exception {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("a", 1);
        payload.put("b", "x");
        payload.put("c", List.of(1, 2));
        payload.put("d", Map.of("e", true));

        Event appended =
                eventLog.append("s1", EventTypes.TOOL_RESULT, payload).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        Event stored = eventLog.readRange("s1", 1).get(0);

        assertThat(appended.payloadAsMap()).isEqualTo(payload);
        assertThat(stored.payloadAsMap()).isEqualTo(payload);
        assertThat(stored.payload().get("a").asInt()).isEqualTo(1);
        assertThat(stored.payload().get("d").get("e").asBoolean()).isTrue();
    }

    @Test
    void eventFieldsArePreserved() throws Exception {
        long before = System.currentTimeMillis();
        Event appended = eventLog
                .append("session-e", EventTypes.RUN_START, Map.of("k", "v"))
                .get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        long after = System.currentTimeMillis();

        assertThat(appended.sessionId()).isEqualTo("session-e");
        assertThat(appended.type()).isEqualTo(EventTypes.RUN_START);
        assertThat(appended.ts()).isBetween(before, after);

        Event stored = eventLog.readRange("session-e", 1).get(0);
        assertThat(stored.sessionId()).isEqualTo("session-e");
        assertThat(stored.type()).isEqualTo(EventTypes.RUN_START);
        assertThat(stored.ts()).isEqualTo(appended.ts());
    }

    @Test
    void nullPayloadRoundtripsAsNull() throws Exception {
        Event appended = eventLog.append("s1", EventTypes.SESSION_META, null).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        Event stored = eventLog.readRange("s1", 1).get(0);

        assertThat(appended.payload()).isNull();
        assertThat(stored.payload()).isNull();
        assertThat(stored.payloadAsMap()).isNull();
    }

    @Test
    void subscribersReceiveAppendedEventsInOrderAndUnsubscribedStop() throws Exception {
        List<Event> first = new CopyOnWriteArrayList<>();
        List<Event> second = new CopyOnWriteArrayList<>();
        EventSubscription sub1 = eventLog.subscribe("s1", first::add);
        EventSubscription sub2 = eventLog.subscribe("s1", second::add);
        assertThat(eventLog.subscriptionCount()).isEqualTo(2);

        eventLog.append("s1", EventTypes.USER_MESSAGE, Map.of("n", 1)).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        eventLog.append("s1", EventTypes.TEXT_DELTA, Map.of("n", 2)).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        eventLog.append("other", EventTypes.TEXT_DELTA, Map.of("n", 9)).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);

        // append() завершается после уведомления слушателей — без ожиданий
        assertThat(first).extracting(Event::seq).containsExactly(1L, 2L);
        assertThat(first).extracting(Event::type).containsExactly(EventTypes.USER_MESSAGE, EventTypes.TEXT_DELTA);
        assertThat(first.get(0).payloadAsMap()).containsEntry("n", 1);
        assertThat(second).extracting(Event::seq).containsExactly(1L, 2L);

        sub1.unsubscribe();
        assertThat(sub1.isActive()).isFalse();
        assertThat(sub2.isActive()).isTrue();
        assertThat(eventLog.subscriptionCount()).isEqualTo(1);

        eventLog.append("s1", EventTypes.TEXT_DELTA, Map.of("n", 3)).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        assertThat(first).hasSize(2);
        assertThat(second).extracting(Event::seq).containsExactly(1L, 2L, 3L);

        sub2.unsubscribe();
        sub2.unsubscribe();
        assertThat(sub2.isActive()).isFalse();
        assertThat(eventLog.subscriptionCount()).isZero();

        eventLog.append("s1", EventTypes.TEXT_DELTA, Map.of("n", 4)).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        assertThat(second).hasSize(3);
    }

    @Test
    void listenerFailureDoesNotBreakAppendAndOtherListenersStillFire() throws Exception {
        eventLog.subscribe("s1", event -> {
            throw new IllegalStateException("boom");
        });
        List<Event> received = new CopyOnWriteArrayList<>();
        eventLog.subscribe("s1", received::add);

        Event appended =
                eventLog.append("s1", EventTypes.ERROR, Map.of("k", "v")).get(TIMEOUT_SECONDS, TimeUnit.SECONDS);

        assertThat(appended.seq()).isEqualTo(1);
        assertThat(appended.payloadAsMap()).containsEntry("k", "v");
        assertThat(received).extracting(Event::seq).containsExactly(1L);
        assertThat(eventLog.latestSeq("s1")).isEqualTo(1);
    }
}
