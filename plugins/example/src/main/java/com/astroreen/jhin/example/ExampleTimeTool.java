package com.astroreen.jhin.example;

import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Тул {@code example_time}: возвращает текущее время (ISO-8601 instant). Аргументов нет.
 * Показывает два приёма контракта {@link ToolDefinition}: пустая parametersSchema {@code {}}
 * и structured-результат — JSON-карточка SDUI (форма примитивов финализируется в T30).
 */
public final class ExampleTimeTool implements ToolDefinition {

    @Override
    public String name() {
        return "example_time";
    }

    @Override
    public String label() {
        return "Example time";
    }

    @Override
    public String description() {
        return "Returns the current time as an ISO-8601 instant. Takes no arguments.";
    }

    @Override
    public Map<String, Object> parametersSchema() {
        return Map.of();
    }

    @Override
    public String promptSnippet() {
        return "example_time - returns the current time (ISO-8601 instant), no arguments";
    }

    @Override
    public List<String> promptGuidelines() {
        return List.of(
                "Use example_time when you need to know the current time or date.",
                "The tool takes no arguments and answers with a single instant string.");
    }

    @Override
    public ToolResult execute(ToolCall call, ToolContext ctx) {
        String now = Instant.now().toString();
        String text = "Current time (UTC): " + now;
        return ToolResult.ok(text, exampleCard(text));
    }

    /** JSON-карточка SDUI: {"type":"card","title":"Example","children":[{"type":"text",...}]} */
    private static Map<String, Object> exampleCard(String text) {
        Map<String, Object> child = new LinkedHashMap<>();
        child.put("type", "text");
        child.put("text", text);
        Map<String, Object> card = new LinkedHashMap<>();
        card.put("type", "card");
        card.put("title", "Example");
        card.put("children", new ArrayList<>(List.of(child)));
        return card;
    }
}
