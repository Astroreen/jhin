package com.astroreen.jhin.core.sse;

import jakarta.annotation.PreDestroy;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Время жизни SSE-подключений: heartbeat-комментарии и жёсткий cap на соединение.
 *
 * <p>Планировщик — один общий {@link ScheduledExecutorService} (daemon-поток
 * {@code jhin-sse-timer}), не Spring TaskScheduler: проще и тестируемее — тестовый
 * конструктор принимает свой executor с короткими периодами. Shutdown через
 * {@link PreDestroy}.
 *
 * <p>Revoke: {@link SseRegistry} (listener) закрывает sinks; этот сервис (второй listener
 * того же события) отменяет их таймеры. Собственный учёт sink → (deviceId, futures) делает
 * порядок Spring-listener'ов неважным.
 */
@Component
public class SseStreamService {

    private static final String THREAD_NAME = "jhin-sse-timer";
    private static final String HEARTBEAT_COMMENT = "keepalive";
    private static final long SHUTDOWN_TIMEOUT_SECONDS = 5;

    private final SseRegistry registry;
    private final long heartbeatMillis;
    private final long capMillis;
    private final ScheduledExecutorService scheduler;
    private final ConcurrentHashMap<SseSink, SinkTasks> tasksBySink = new ConcurrentHashMap<>();

    @Autowired
    public SseStreamService(
            SseRegistry registry,
            @Value("${jhin.sse.heartbeat-seconds:15}") long heartbeatSeconds,
            @Value("${jhin.sse.cap-seconds:900}") long capSeconds) {
        this(
                registry,
                TimeUnit.SECONDS.toMillis(heartbeatSeconds),
                TimeUnit.SECONDS.toMillis(capSeconds),
                newScheduler());
    }

    SseStreamService(
            SseRegistry registry, long heartbeatMillis, long capMillis, ScheduledExecutorService scheduler) {
        this.registry = registry;
        this.heartbeatMillis = heartbeatMillis;
        this.capMillis = capMillis;
        this.scheduler = scheduler;
    }

    /** Регистрирует sink и планирует heartbeat + cap. Возвращает тот же sink. */
    public SseSink openStream(String deviceId, SseSink sink) {
        SinkTasks tasks = new SinkTasks(deviceId);
        tasksBySink.put(sink, tasks);
        registry.register(deviceId, sink);
        tasks.heartbeat = scheduler.scheduleAtFixedRate(
                () -> heartbeat(deviceId, sink), heartbeatMillis, heartbeatMillis, TimeUnit.MILLISECONDS);
        tasks.cap = scheduler.schedule(() -> capReached(deviceId, sink), capMillis, TimeUnit.MILLISECONDS);
        return sink;
    }

    /** Снимает sink и отменяет его таймеры (без утечек). */
    public void unregister(String deviceId, SseSink sink) {
        SinkTasks tasks = tasksBySink.remove(sink);
        if (tasks != null) {
            tasks.cancel();
        }
        registry.unregister(deviceId, sink);
    }

    @EventListener
    public void onDeviceRevoked(DeviceRevokedEvent event) {
        tasksBySink.forEach((sink, tasks) -> {
            if (tasks.deviceId.equals(event.deviceId())) {
                tasks.cancel();
                tasksBySink.remove(sink, tasks);
            }
        });
    }

    @PreDestroy
    public void shutdown() {
        scheduler.shutdown();
        try {
            if (!scheduler.awaitTermination(SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                scheduler.shutdownNow();
            }
        } catch (InterruptedException e) {
            scheduler.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }

    private void heartbeat(String deviceId, SseSink sink) {
        if (!sink.isOpen()) {
            unregister(deviceId, sink);
            return;
        }
        try {
            sink.comment(HEARTBEAT_COMMENT);
        } catch (Exception e) {
            unregister(deviceId, sink);
        }
    }

    private void capReached(String deviceId, SseSink sink) {
        try {
            if (sink.isOpen()) {
                sink.complete();
            }
        } finally {
            unregister(deviceId, sink);
        }
    }

    private static ScheduledExecutorService newScheduler() {
        return Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, THREAD_NAME);
            thread.setDaemon(true);
            return thread;
        });
    }

    private static final class SinkTasks {

        final String deviceId;
        volatile ScheduledFuture<?> heartbeat;
        volatile ScheduledFuture<?> cap;

        SinkTasks(String deviceId) {
            this.deviceId = deviceId;
        }

        void cancel() {
            if (heartbeat != null) {
                heartbeat.cancel(false);
            }
            if (cap != null) {
                cap.cancel(false);
            }
        }
    }
}
