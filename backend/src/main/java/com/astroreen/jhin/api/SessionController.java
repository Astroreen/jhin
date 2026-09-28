package com.astroreen.jhin.api;

import com.astroreen.jhin.api.dto.ApiError;
import com.astroreen.jhin.api.dto.SessionPatchRequest;
import com.astroreen.jhin.api.dto.SessionRequest;
import com.astroreen.jhin.api.dto.SessionResponse;
import com.astroreen.jhin.core.llm.ProviderRegistry;
import com.astroreen.jhin.core.security.BearerTokenFilter;
import com.astroreen.jhin.core.sessions.SessionService;
import java.util.List;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * CRUD сессий аккаунта. accountId — всегда из device-токена
 * ({@link BearerTokenFilter#currentDevice()}). Чужая сессия — 404
 * {@code {"error":"not_found"}} без утечки 403.
 *
 * <p>Ошибки — JSON: 400 {@code {"error":"bad_request"}} (пустые title/workdir, пустой PATCH-body,
 * неизвестный/чужой providerId, битый JSON), 404 {@code {"error":"not_found"}}.
 */
@RestController
public class SessionController {

    private final SessionService sessionService;
    private final ProviderRegistry providerRegistry;

    @Autowired
    public SessionController(SessionService sessionService, ProviderRegistry providerRegistry) {
        this.sessionService = sessionService;
        this.providerRegistry = providerRegistry;
    }

    @GetMapping("/sessions")
    public List<SessionResponse> list() {
        return sessionService.list(currentAccountId());
    }

    @PostMapping("/sessions")
    public ResponseEntity<?> create(@RequestBody SessionRequest request) {
        String accountId = currentAccountId();
        if (request == null || isBlank(request.title()) || isBlank(request.workdir())) {
            return ResponseEntity.badRequest().body(new ApiError("bad_request"));
        }
        if (!providerResolves(accountId, request.providerId())) {
            return ResponseEntity.badRequest().body(new ApiError("bad_request"));
        }
        SessionResponse created =
                sessionService.create(accountId, request.title(), request.workdir(), request.model(), request.providerId());
        return ResponseEntity.status(201).body(created);
    }

    @GetMapping("/sessions/{id}")
    public ResponseEntity<?> get(@PathVariable("id") String id) {
        Optional<SessionResponse> found = sessionService.get(currentAccountId(), id);
        return found.<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.status(404).body(new ApiError("not_found")));
    }

    @PatchMapping("/sessions/{id}")
    public ResponseEntity<?> patch(@PathVariable("id") String id, @RequestBody SessionPatchRequest request) {
        String accountId = currentAccountId();
        if (request == null || (request.title() == null && request.model() == null && request.providerId() == null)) {
            return ResponseEntity.badRequest().body(new ApiError("bad_request"));
        }
        if (request.title() != null && isBlank(request.title())) {
            return ResponseEntity.badRequest().body(new ApiError("bad_request"));
        }
        if (!providerResolves(accountId, request.providerId())) {
            return ResponseEntity.badRequest().body(new ApiError("bad_request"));
        }
        Optional<SessionResponse> updated =
                sessionService.update(accountId, id, request.title(), request.model(), request.providerId());
        return updated.<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.status(404).body(new ApiError("not_found")));
    }

    @DeleteMapping("/sessions/{id}")
    public ResponseEntity<?> delete(@PathVariable("id") String id) {
        if (!sessionService.delete(currentAccountId(), id)) {
            return ResponseEntity.status(404).body(new ApiError("not_found"));
        }
        return ResponseEntity.noContent().build();
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ApiError> onUnreadableBody(HttpMessageNotReadableException exception) {
        return ResponseEntity.badRequest().body(new ApiError("bad_request"));
    }

    /** providerId не задан — ок; задан — должен существовать и принадлежать аккаунту. */
    private boolean providerResolves(String accountId, String providerId) {
        return providerId == null || providerRegistry.find(accountId, providerId).isPresent();
    }

    private static String currentAccountId() {
        return BearerTokenFilter.currentDevice().orElseThrow().accountId();
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
