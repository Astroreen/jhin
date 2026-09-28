package com.astroreen.jhin.core.tools.spi;

/** Решение guard-цепочки: ALLOW (reason null) или BLOCK(reason). */
public record ToolCallDecision(boolean allowed, String reason) {

    public static ToolCallDecision allow() {
        return new ToolCallDecision(true, null);
    }

    public static ToolCallDecision block(String reason) {
        return new ToolCallDecision(false, reason);
    }
}
