package com.astroreen.jhin.core.sse;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Реестр активных SSE-подключений по deviceId.
 *
 * <p>Sink, закрывшийся сам, немедленно не вычищается: прунаем лениво на register/iterate
 * ({@link #activeCount()} считает только открытые). Revoke-пропагация: слушает
 * {@link DeviceRevokedEvent} и немедленно гасит все sinks устройства.
 */
@Component
public class SseRegistry {

    private final ConcurrentHashMap<String, Set<SseSink>> sinksByDevice = new ConcurrentHashMap<>();

    public void register(String deviceId, SseSink sink) {
        sinksByDevice.computeIfAbsent(deviceId, id -> ConcurrentHashMap.newKeySet()).add(sink);
        pruneClosed(deviceId);
    }

    public void unregister(String deviceId, SseSink sink) {
        sinksByDevice.computeIfPresent(deviceId, (id, sinks) -> {
            sinks.remove(sink);
            return sinks.isEmpty() ? null : sinks;
        });
    }

    /** Завершить ВСЕ sinks устройства и убрать его. Идемпотентно. */
    public void closeDevice(String deviceId) {
        Set<SseSink> sinks = sinksByDevice.remove(deviceId);
        if (sinks != null) {
            sinks.forEach(SseRegistry::completeQuietly);
        }
    }

    /** Завершить все sinks всех устройств (будущий /reload). */
    public void closeAll() {
        for (String deviceId : Set.copyOf(sinksByDevice.keySet())) {
            closeDevice(deviceId);
        }
    }

    public int activeCount() {
        return sinksByDevice.values().stream()
                .mapToInt(sinks -> {
                    sinks.removeIf(sink -> !sink.isOpen());
                    return sinks.size();
                })
                .sum();
    }

    public int activeCount(String deviceId) {
        Set<SseSink> sinks = sinksByDevice.get(deviceId);
        if (sinks == null) {
            return 0;
        }
        sinks.removeIf(sink -> !sink.isOpen());
        return sinks.size();
    }

    @EventListener
    public void onDeviceRevoked(DeviceRevokedEvent event) {
        closeDevice(event.deviceId());
    }

    private void pruneClosed(String deviceId) {
        Set<SseSink> sinks = sinksByDevice.get(deviceId);
        if (sinks != null) {
            sinks.removeIf(sink -> !sink.isOpen());
        }
    }

    private static void completeQuietly(SseSink sink) {
        try {
            sink.complete();
        } catch (Exception ignored) {
            // контракт SseSink.complete: не бросает; защита от багов адаптеров
        }
    }
}
