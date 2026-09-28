package com.astroreen.jhin.core.tools.spi;

/** Стриминговый чанк от тула (T14: построчные апдейты). */
public record ToolUpdate(String toolName, String chunk, boolean streaming) {}
