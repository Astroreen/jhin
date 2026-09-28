package com.astroreen.jhin.api.dto;

import java.util.List;

/**
 * Ответ {@code GET /ui/manifest} (T32). Форма строго по контракту:
 * {@code {tools:[{name,description}], primitives:[...], version}} — без лишних полей.
 */
public record UiManifestResponse(List<ToolInfo> tools, List<String> primitives, String version) {

    /** Тул манифеста: только имя и описание (label/схемы в манифест не входят). */
    public record ToolInfo(String name, String description) {}
}
