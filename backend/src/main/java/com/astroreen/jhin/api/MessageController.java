package com.astroreen.jhin.api;

import com.astroreen.jhin.api.dto.ApiError;
import com.astroreen.jhin.api.dto.MessageRequest;
import com.astroreen.jhin.api.dto.RunIdResponse;
import com.astroreen.jhin.api.dto.UiActionRequest;
import com.astroreen.jhin.api.dto.UiActionResponse;
import com.astroreen.jhin.core.agent.RunService;
import com.astroreen.jhin.core.events.EventLogService;
import com.astroreen.jhin.core.events.EventTypes;
import com.astroreen.jhin.core.security.BearerTokenFilter;
import com.astroreen.jhin.core.sessions.SessionService;
import com.astroreen.jhin.core.sessions.SessionService.CancelResult;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Действия над сессией: отправка сообщения (асинхронный run), отмена активного run'а,
 * публикация UI-события. accountId — из device-токена; чужая сессия — 404.
 *
 * <p>Ошибки — JSON: 400 {@code {"error":"bad_request"}} (пустой text/action, битый JSON),
 * 404 {@code {"error":"not_found"}}. Cancel идемпотентен: без активного run'а —
 * {@code {"runId":null}}.
 */
@RestController
public class MessageController {

    private final SessionService sessionService;
    private final RunService runService;
    private final EventLogService eventLog;

    @Autowired
    public MessageController(SessionService sessionService, RunService runService, EventLogService eventLog) {
        this.sessionService = sessionService;
        this.runService = runService;
        this.eventLog = eventLog;
    }

    @PostMapping("/sessions/{id}/messages")
    public ResponseEntity<?> send(@PathVariable("id") String id, @RequestBody MessageRequest request) {
        String accountId = currentAccountId();
        if (request == null || isBlank(request.text())) {
            return ResponseEntity.badRequest().body(new ApiError("bad_request"));
        }
        if (sessionService.get(accountId, id).isEmpty()) {
            return ResponseEntity.status(404).body(new ApiError("not_found"));
        }
        String runId = runService.startRun(id, accountId, request.text());
        sessionService.touch(id);
        return ResponseEntity.ok(new RunIdResponse(runId));
    }

    @PostMapping("/sessions/{id}/cancel")
    public ResponseEntity<?> cancel(@PathVariable("id") String id) {
        String accountId = currentAccountId();
        Optional<CancelResult> result = sessionService.cancelActive(id, accountId);
        return result.<ResponseEntity<?>>map(cancel -> ResponseEntity.ok(new RunIdResponse(cancel.runId())))
                .orElseGet(() -> ResponseEntity.status(404).body(new ApiError("not_found")));
    }

    @PostMapping("/sessions/{id}/ui-action")
    public ResponseEntity<?> uiAction(@PathVariable("id") String id, @RequestBody UiActionRequest request) {
        String accountId = currentAccountId();
        if (request == null || isBlank(request.action())) {
            return ResponseEntity.badRequest().body(new ApiError("bad_request"));
        }
        if (sessionService.get(accountId, id).isEmpty()) {
            return ResponseEntity.status(404).body(new ApiError("not_found"));
        }
        Map<String, Object> payload = new HashMap<>();
        payload.put("action", request.action());
        payload.put("payload", request.payload());
        long seq = eventLog.append(id, EventTypes.UI, payload).join().seq();
        return ResponseEntity.ok(new UiActionResponse(seq));
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ApiError> onUnreadableBody(HttpMessageNotReadableException exception) {
        return ResponseEntity.badRequest().body(new ApiError("bad_request"));
    }

    private static String currentAccountId() {
        return BearerTokenFilter.currentDevice().orElseThrow().accountId();
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
