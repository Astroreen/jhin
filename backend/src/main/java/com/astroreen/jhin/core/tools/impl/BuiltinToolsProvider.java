package com.astroreen.jhin.core.tools.impl;

import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolProvider;
import java.util.ArrayList;
import java.util.List;
import org.springframework.core.annotation.AnnotationAwareOrderComparator;
import org.springframework.stereotype.Component;

/**
 * Источник встроенных тулов для {@link com.astroreen.jhin.core.tools.ToolRegistry}:
 * собирает все {@link ToolDefinition}-бины (bash, T15–T17 и далее — просто новые
 * {@code @Component ToolDefinition}) и отдаёт их, отсортированными по {@code @Order}.
 */
@Component
public class BuiltinToolsProvider implements ToolProvider {

    private final List<ToolDefinition> tools;

    public BuiltinToolsProvider(List<ToolDefinition> definitions) {
        List<ToolDefinition> sorted = new ArrayList<>(definitions);
        AnnotationAwareOrderComparator.sort(sorted);
        this.tools = List.copyOf(sorted);
    }

    @Override
    public List<ToolDefinition> tools() {
        return tools;
    }
}
