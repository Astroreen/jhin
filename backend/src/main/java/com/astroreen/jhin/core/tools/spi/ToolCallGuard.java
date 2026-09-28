package com.astroreen.jhin.core.tools.spi;

/**
 * Проверка вызова тула перед исполнением: ALLOW | BLOCK(reason). Плагины ветуют здесь.
 */
public interface ToolCallGuard {

    ToolCallDecision check(ToolCall call);
}
