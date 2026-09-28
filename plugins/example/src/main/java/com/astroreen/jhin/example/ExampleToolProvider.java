package com.astroreen.jhin.example;

import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolProvider;
import java.util.List;

/**
 * Демо-провайдер тулов: отдаёт единственный тул {@code example_time} (текущее время).
 * Регистрация в Jhin — через {@code META-INF/services/com.astroreen.jhin.core.tools.spi.ToolProvider}.
 */
public final class ExampleToolProvider implements ToolProvider {

    @Override
    public List<ToolDefinition> tools() {
        return List.of(new ExampleTimeTool());
    }
}
