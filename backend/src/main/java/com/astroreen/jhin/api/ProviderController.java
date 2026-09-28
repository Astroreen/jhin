package com.astroreen.jhin.api;

import com.astroreen.jhin.api.dto.ApiError;
import com.astroreen.jhin.api.dto.ProviderRequest;
import com.astroreen.jhin.core.llm.ProviderRegistry;
import com.astroreen.jhin.core.llm.ProviderRegistry.ProviderRecord;
import com.astroreen.jhin.core.security.BearerTokenFilter;
import java.util.List;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * CRUD LLM-провайдеров аккаунта. accountId — всегда из device-токена
 * ({@link BearerTokenFilter#currentDevice()}), никогда из тела/запроса. Ответы не содержат
 * apiKey ({@link ProviderRecord} без секрета).
 *
 * <p>Ошибки — JSON: 400 {@code {"error":"bad_request"}} (пустые поля, битый JSON),
 * 400 {@code {"error":"unknown_format"}}, 404 {@code {"error":"not_found"}} (нет записи или
 * чужой аккаунт — одинаково, без утечки 403).
 */
@RestController
public class ProviderController {

    private final ProviderRegistry providerRegistry;

    @Autowired
    public ProviderController(ProviderRegistry providerRegistry) {
        this.providerRegistry = providerRegistry;
    }

    @GetMapping("/providers")
    public List<ProviderRecord> list() {
        return providerRegistry.list(currentAccountId());
    }

    @PostMapping("/providers")
    public ResponseEntity<?> create(@RequestBody ProviderRequest request) {
        String accountId = currentAccountId();
        if (request == null || isBlank(request.name()) || isBlank(request.format())
                || isBlank(request.apiKey()) || isBlank(request.model())) {
            return ResponseEntity.badRequest().body(new ApiError("bad_request"));
        }
        if (!providerRegistry.knownFormats().contains(request.format())) {
            return ResponseEntity.badRequest().body(new ApiError("unknown_format"));
        }
        ProviderRecord created = providerRegistry
                .create(
                        accountId,
                        request.name(),
                        request.format(),
                        request.apiKey(),
                        request.model(),
                        request.baseUrl(),
                        Boolean.TRUE.equals(request.isDefault()))
                .join();
        return ResponseEntity.status(201).body(created);
    }

    @GetMapping("/providers/{id}")
    public ResponseEntity<?> get(@PathVariable("id") String id) {
        Optional<ProviderRecord> found = providerRegistry.find(currentAccountId(), id);
        return found.<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.status(404).body(new ApiError("not_found")));
    }

    @DeleteMapping("/providers/{id}")
    public ResponseEntity<?> delete(@PathVariable("id") String id) {
        if (!providerRegistry.delete(currentAccountId(), id)) {
            return ResponseEntity.status(404).body(new ApiError("not_found"));
        }
        return ResponseEntity.noContent().build();
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
