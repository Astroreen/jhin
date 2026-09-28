package com.astroreen.jhin.core.sse;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class SseStreamServiceTest {

    private ScheduledExecutorService scheduler;
    private SseRegistry registry;
    private SseStreamService service;

    @BeforeEach
    void setUp() {
        scheduler = Executors.newSingleThreadScheduledExecutor();
        registry = new SseRegistry();
    }

    @AfterEach
    void tearDown() {
        if (service != null) {
            service.shutdown();
        } else {
            scheduler.shutdownNow();
        }
    }

    @Test
    void heartbeatSendsKeepaliveAndStopsAfterComplete() throws Exception {
        service = new SseStreamService(registry, 50, 60_000, scheduler);
        FakeSink sink = new FakeSink();
        service.openStream("d1", sink);

        awaitUntil(() -> !sink.comments.isEmpty(), 2_000);
        assertThat(sink.comments).contains("keepalive");

        sink.complete();
        awaitUntil(() -> registry.activeCount("d1") == 0, 2_000);
        int count = sink.comments.size();
        Thread.sleep(250);
        assertThat(sink.comments.size()).isEqualTo(count);
    }

    @Test
    void streamCapCompletesAndUnregisters() throws Exception {
        service = new SseStreamService(registry, 10_000, 100, scheduler);
        FakeSink sink = new FakeSink();
        service.openStream("d1", sink);

        awaitUntil(() -> sink.completions.get() >= 1, 2_000);
        assertThat(sink.isOpen()).isFalse();
        awaitUntil(() -> registry.activeCount() == 0, 2_000);
    }

    @Test
    void unregisterCancelsTimers() throws Exception {
        service = new SseStreamService(registry, 50, 60_000, scheduler);
        FakeSink sink = new FakeSink();
        service.openStream("d1", sink);

        awaitUntil(() -> !sink.comments.isEmpty(), 2_000);
        service.unregister("d1", sink);
        Thread.sleep(100);
        int count = sink.comments.size();
        Thread.sleep(250);
        assertThat(sink.comments.size()).isEqualTo(count);
        assertThat(registry.activeCount("d1")).isZero();
    }

    @Test
    void revokeClosesSinksAndCancelsTimers() throws Exception {
        service = new SseStreamService(registry, 50, 60_000, scheduler);
        FakeSink revokedSink = new FakeSink();
        FakeSink otherSink = new FakeSink();
        service.openStream("d1", revokedSink);
        service.openStream("d2", otherSink);
        awaitUntil(() -> !revokedSink.comments.isEmpty() && !otherSink.comments.isEmpty(), 2_000);

        DeviceRevokedEvent event = new DeviceRevokedEvent("d1");
        registry.onDeviceRevoked(event);
        service.onDeviceRevoked(event);

        assertThat(revokedSink.completions).hasValue(1);
        assertThat(revokedSink.isOpen()).isFalse();
        assertThat(registry.activeCount("d1")).isZero();
        assertThat(registry.activeCount("d2")).isEqualTo(1);

        Thread.sleep(100);
        int revokedCount = revokedSink.comments.size();
        int otherCount = otherSink.comments.size();
        Thread.sleep(250);
        assertThat(revokedSink.comments.size()).isEqualTo(revokedCount);
        awaitUntil(() -> otherSink.comments.size() > otherCount, 2_000);
    }

    private static void awaitUntil(BooleanSupplier condition, long timeoutMillis) throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeoutMillis;
        while (System.currentTimeMillis() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            Thread.sleep(5);
        }
        assertThat(condition.getAsBoolean())
                .as("condition not met within " + timeoutMillis + "ms")
                .isTrue();
    }
}