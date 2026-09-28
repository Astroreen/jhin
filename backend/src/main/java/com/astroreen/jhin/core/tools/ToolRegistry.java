package com.astroreen.jhin.core.tools;

import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolCallDecision;
import com.astroreen.jhin.core.tools.spi.ToolCallGuard;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolProvider;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import com.astroreen.jhin.core.tools.spi.ToolResultTransformer;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Реестр тулов: слияние ToolProvider'ов, guard-цепочка, исполнение, transformer-цепочка.
 *
 * <p>Дубликаты имён тулов: первая регистрация побеждает, повторные — warn + skip.
 * {@link #register} — шов для плагинов (T25). Guard-исключение или BLOCK →
 * ToolResult.error без исполнения; ошибка тула → ToolResult.error; падающий
 * трансформер логируется и пропускается, результат сохраняется.
 */
@Component
public class ToolRegistry {

    private static final Logger log = LoggerFactory.getLogger(ToolRegistry.class);

    private final Map<String, ToolDefinition> tools = new LinkedHashMap<>();
    private final List<ToolCallGuard> guards;
    private final List<ToolResultTransformer> transformers;

    public ToolRegistry(
            List<ToolProvider> providers,
            List<ToolCallGuard> guards,
            List<ToolResultTransformer> transformers) {
        this.guards = List.copyOf(guards);
        this.transformers = List.copyOf(transformers);
        providers.forEach(this::register);
    }

    /** Плагины (T25): имя регистрируется один раз — первый выигрывает, повтор → warn + skip. */
    public synchronized void register(ToolProvider provider) {
        for (ToolDefinition definition : provider.tools()) {
            String name = definition.name();
            if (tools.containsKey(name)) {
                log.warn("Tool '{}' already registered, keeping the first one", name);
                continue;
            }
            tools.put(name, definition);
        }
    }

    public synchronized List<ToolDefinition> all() {
        return List.copyOf(tools.values());
    }

    public synchronized Optional<ToolDefinition> find(String name) {
        return Optional.ofNullable(tools.get(name));
    }

    public ToolResult execute(String name, Map<String, Object> arguments, ToolContext ctx) {
        ToolDefinition definition = find(name).orElse(null);
        if (definition == null) {
            return ToolResult.error("Unknown tool: " + name);
        }
        ToolCall call = new ToolCall(name, arguments, null);

        for (ToolCallGuard guard : guards) {
            ToolCallDecision decision;
            try {
                decision = guard.check(call);
            } catch (RuntimeException e) {
                log.warn("ToolCallGuard {} failed for tool '{}'", guard.getClass().getName(), name, e);
                return ToolResult.error("Blocked: " + message(e));
            }
            if (decision != null && !decision.allowed()) {
                return ToolResult.error("Blocked: " + decision.reason());
            }
        }

        ToolResult result;
        try {
            result = definition.execute(call, ctx);
        } catch (RuntimeException e) {
            log.warn("Tool '{}' failed", name, e);
            return ToolResult.error(message(e));
        }
        if (result == null) {
            result = ToolResult.error("Tool returned no result");
        }

        for (ToolResultTransformer transformer : transformers) {
            try {
                ToolResult transformed = transformer.transform(result);
                if (transformed != null) {
                    result = transformed;
                }
            } catch (RuntimeException e) {
                log.warn("ToolResultTransformer {} failed, skipping", transformer.getClass().getName(), e);
            }
        }
        return result;
    }

    private static String message(RuntimeException e) {
        return e.getMessage() != null ? e.getMessage() : e.toString();
    }
}
