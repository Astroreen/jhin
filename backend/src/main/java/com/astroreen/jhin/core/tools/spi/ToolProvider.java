package com.astroreen.jhin.core.tools.spi;

import java.util.List;

/** Источник тулов: core-провайдеры и плагины (через ToolRegistry.register). */
public interface ToolProvider {

    List<ToolDefinition> tools();
}
