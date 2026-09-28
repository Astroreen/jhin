package com.astroreen.jhin.core.sse;

/** Публикуется {@code DeviceService} после успешного отзыва устройства; слушатели немедленно гасят его SSE-потоки. */
public record DeviceRevokedEvent(String deviceId) {}
