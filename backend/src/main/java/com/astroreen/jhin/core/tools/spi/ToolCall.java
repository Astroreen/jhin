package com.astroreen.jhin.core.tools.spi;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/** Вызов тула: имя, аргументы (nullable → empty), опциональный callId для корреляции. */
public record ToolCall(String toolName, Map<String, Object> arguments, String callId) {

    public ToolCall {
        arguments =
                arguments == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(arguments));
    }

    public ToolCall(String toolName, Map<String, Object> arguments) {
        this(toolName, arguments, null);
    }
}
