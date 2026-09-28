package com.astroreen.jhin.core.tools.spi;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Результат тула (immutable): текст, флаги error/truncated, опциональный JSON-able
 * structured (например {"type":"image","mimeType":...,"data":...}) и meta-флаги
 * (matchLimitReached и т.п.; nullable → empty).
 */
public record ToolResult(
        String content, boolean error, boolean truncated, Object structured, Map<String, Object> meta) {

    public ToolResult {
        content = content == null ? "" : content;
        meta = meta == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(meta));
    }

    public static ToolResult ok(String content) {
        return new ToolResult(content, false, false, null, null);
    }

    public static ToolResult ok(String content, Object structured) {
        return new ToolResult(content, false, false, structured, null);
    }

    public static ToolResult error(String content) {
        return new ToolResult(content, true, false, null, null);
    }
}
