package com.astroreen.jhin.api;

import com.astroreen.jhin.api.dto.ApiError;
import com.astroreen.jhin.core.reload.ReloadService;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * POST /admin/reload — graceful restart hub'а. Аутентификация: любой device-токен
 * (Bearer), как и все защищённые роуты; без токена — 401.
 *
 * <p>Prod-режим: 202 {@code {"status":"restarting"}} — запущенные runs переведены в
 * INTERRUPTED, все SSE-стримы закрыты, процесс завершится через ~2 секунды и будет
 * перезапущен wrapper'ом ({@code deploy/run.sh}). Ответ уходит клиенту до выхода.
 *
 * <p>Dev-режим (exploded classes, рестарт невозможен): 503
 * {@code {"error":"restart manually"}} — ничего не прерывается и не рестартуется.
 */
@RestController
public class AdminController {

    private final ReloadService reloadService;

    @Autowired
    public AdminController(ReloadService reloadService) {
        this.reloadService = reloadService;
    }

    @PostMapping("/admin/reload")
    public ResponseEntity<?> reload() {
        if (!reloadService.reload()) {
            return ResponseEntity.status(503).body(new ApiError("restart manually"));
        }
        return ResponseEntity.accepted().body(Map.of("status", "restarting"));
    }
}
