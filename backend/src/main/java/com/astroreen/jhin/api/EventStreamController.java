package com.astroreen.jhin.api;

import com.astroreen.jhin.api.dto.ApiError;
import com.astroreen.jhin.core.accounts.DevicePrincipal;
import com.astroreen.jhin.core.events.EventLogService;
import com.astroreen.jhin.core.security.BearerTokenFilter;
import com.astroreen.jhin.core.sessions.SessionService;
import com.astroreen.jhin.core.sse.SessionEventStream;
import com.astroreen.jhin.core.sse.SseSink;
import com.astroreen.jhin.core.sse.SseStreamService;
import java.util.OptionalLong;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * SSE-поток событий сессии: {@code GET /sessions/{id}/events?fromSeq=N} (Bearer auth).
 * Replay истории с {@code seq >= N} (по умолчанию N=0 — вся история) и live-tail без
 * дыр и дублей (см. {@link SessionEventStream}). Heartbeat и cap — через
 * {@link SseStreamService}; revoke устройства немедленно завершает поток.
 *
 * <p>accountId — из device-токена; чужая/несуществующая сессия — 404
 * {@code {"error":"not_found"}} (никогда 403) ДО открытия стрима. Ошибки — JSON:
 * 400 {@code {"error":"bad_request"}} (нечисловой или отрицательный fromSeq).
 */
@RestController
public class EventStreamController {

    private final SessionService sessionService;
    private final EventLogService eventLog;
    private final SseStreamService streamService;
    private final long emitterTimeoutMillis;

    @Autowired
    public EventStreamController(
            SessionService sessionService,
            EventLogService eventLog,
            SseStreamService streamService,
            @Value("${jhin.sse.cap-seconds:900}") long capSeconds) {
        this.sessionService = sessionService;
        this.eventLog = eventLog;
        this.streamService = streamService;
        this.emitterTimeoutMillis = TimeUnit.SECONDS.toMillis(capSeconds) + TimeUnit.MINUTES.toMillis(5);
    }

    @GetMapping("/sessions/{id}/events")
    public ResponseEntity<?> stream(
            @PathVariable("id") String id,
            @RequestParam(value = "fromSeq", required = false) String fromSeq) {
        OptionalLong parsed = parseFromSeq(fromSeq);
        if (parsed.isEmpty()) {
            return ResponseEntity.badRequest().body(new ApiError("bad_request"));
        }
        DevicePrincipal device = BearerTokenFilter.currentDevice().orElseThrow();
        if (sessionService.get(device.accountId(), id).isEmpty()) {
            return ResponseEntity.status(404).body(new ApiError("not_found"));
        }
        SseEmitter emitter = new SseEmitter(emitterTimeoutMillis);
        SessionEventStream stream = new SessionEventStream(
                eventLog, streamService, SseSink.fromEmitter(emitter), device.id(), id, parsed.getAsLong());
        emitter.onCompletion(stream::close);
        emitter.onTimeout(stream::close);
        emitter.onError(error -> stream.close());
        stream.open();
        return ResponseEntity.ok().contentType(MediaType.TEXT_EVENT_STREAM).body(emitter);
    }

    /** Нет/пустой fromSeq — 0 (вся история); нечисловой или отрицательный — invalid. */
    private static OptionalLong parseFromSeq(String raw) {
        if (raw == null || raw.isBlank()) {
            return OptionalLong.of(0);
        }
        try {
            long value = Long.parseLong(raw.strip());
            return value < 0 ? OptionalLong.empty() : OptionalLong.of(value);
        } catch (NumberFormatException e) {
            return OptionalLong.empty();
        }
    }
}
