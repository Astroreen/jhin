package com.astroreen.jhin.api;

import com.astroreen.jhin.api.dto.UiManifestResponse;
import com.astroreen.jhin.api.dto.UiManifestResponse.ToolInfo;
import com.astroreen.jhin.core.tools.ToolRegistry;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /ui/manifest} (T32) — UI-манифест hub'а: тулы реестра + SDUI-примитивы
 * + версия. Манифест общий для всех аккаунтов (accountId не участвует); доступ —
 * любой валидный device-токен (SecurityConfig: anyRequest().authenticated()), без
 * токена — 401.
 *
 * <p>Тулы читаются из {@link ToolRegistry#all()} В МОМЕНТ ЗАПРОСА: после
 * перезагрузки с плагином/MCP его тулы видны в манифесте сразу. Сортировка по
 * имени; пустое/null-описание не роняет ответ (пустая строка).
 */
@RestController
public class UiManifestController {

    /**
     * SDUI-примитивы, которые умеет рендерить клиент. Должен совпадать с
     * клиентским реестром: {@code frontend/lib/ui/ui_registry.dart}
     * ({@code supportedPrimitives()} / регистрация в {@code ui_renderer.dart}).
     */
    static final List<String> PRIMITIVES = List.of(
            "container",
            "card",
            "text",
            "button",
            "dropdown",
            "list",
            "drawer",
            "form",
            "chart_line",
            "chart_bar",
            "chart_pie",
            "figure",
            "table",
            "markdown");

    private final ToolRegistry toolRegistry;
    private final String version;

    public UiManifestController(
            ToolRegistry toolRegistry, @Value("${jhin.version:0.1.0}") String version) {
        this.toolRegistry = Objects.requireNonNull(toolRegistry, "toolRegistry");
        this.version = version;
    }

    @GetMapping("/ui/manifest")
    public UiManifestResponse manifest() {
        List<ToolInfo> tools = toolRegistry.all().stream()
                .sorted(Comparator.comparing(ToolDefinition::name))
                .map(UiManifestController::toInfo)
                .toList();
        return new UiManifestResponse(tools, PRIMITIVES, version);
    }

    private static ToolInfo toInfo(ToolDefinition definition) {
        String description = definition.description();
        return new ToolInfo(definition.name(), description != null ? description : "");
    }
}
