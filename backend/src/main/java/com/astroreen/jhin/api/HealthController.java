package com.astroreen.jhin.api;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /health — liveness для smoke-проверки и reverse-proxy. Анонимный роут (permitAll),
 * никакой БД: единственная точка, доступная без device-токена кроме POST /enroll.
 */
@RestController
public class HealthController {

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "UP");
    }
}
