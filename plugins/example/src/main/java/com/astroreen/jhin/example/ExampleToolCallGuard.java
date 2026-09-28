package com.astroreen.jhin.example;

import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolCallDecision;
import com.astroreen.jhin.core.tools.spi.ToolCallGuard;

/**
 * Демо-guard: ветует вызовы shell-тулов ({@code bash}, {@code powershell}) с командой,
 * содержащей {@code rm -rf /}. Регистрация — через {@code
 * META-INF/services/com.astroreen.jhin.core.tools.spi.ToolCallGuard}; guard-цепочка
 * выполняется ДО исполнения тула, блокировка возвращает ToolResult.error("Blocked: ...").
 */
public final class ExampleToolCallGuard implements ToolCallGuard {

    private static final String DANGEROUS = "rm -rf /";

    @Override
    public ToolCallDecision check(ToolCall call) {
        String toolName = call.toolName();
        if (!"bash".equals(toolName) && !"powershell".equals(toolName)) {
            return ToolCallDecision.allow();
        }
        Object command = call.arguments().get("command");
        if (command instanceof String value && value.contains(DANGEROUS)) {
            return ToolCallDecision.block("dangerous command");
        }
        return ToolCallDecision.allow();
    }
}
