package com.astroreen.jhin.core.tools.spi;

/**
 * Пост-обработка результата тула: может заменить результат. Исключения от трансформеров
 * ловятся реестром — трансформер пропускается, результат сохраняется.
 */
public interface ToolResultTransformer {

    ToolResult transform(ToolResult r);
}
