/**
 * The tool execution pipeline: live tool resolution, the
 * {@code ToolCallGuard} chain, the tool body and the
 * {@code ToolResultTransformer} chain.
 *
 * <p>Semantics, matching the tool SPI Javadoc:
 * <ul>
 *   <li>Tools resolve from {@code services().findAll(ToolProvider.class)} at
 *       call time (a plugin installed later contributes tools without a
 *       restart); definitions are keyed by {@code ToolDefinition.name()} with
 *       first-wins resolution and a {@code WARN} naming both providers on a
 *       collision.</li>
 *   <li>Guards run in load order before execution; the first block wins and a
 *       guard that throws blocks the call. A blocked call never executes and
 *       becomes an error result whose text starts with {@code Blocked: }.</li>
 *   <li>Transformers run in load order after the body; a transformer that
 *       throws is skipped with a {@code WARN} and the chain continues with the
 *       last good result.</li>
 * </ul>
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolCallDecision;
import com.astroreen.jhin.plugin.agent.api.ToolCallGuard;
import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.agent.api.ToolProvider;
import com.astroreen.jhin.plugin.agent.api.ToolResult;
import com.astroreen.jhin.plugin.agent.api.ToolResultTransformer;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.slf4j.Logger;

final class ToolInvoker {

    /** The exact prefix every guard-blocked result carries. */
    static final String BLOCKED_PREFIX = "Blocked: ";

    private final Supplier<List<ToolProvider>> providers;
    private final Supplier<List<ToolCallGuard>> guards;
    private final Supplier<List<ToolResultTransformer>> transformers;
    private final Logger log;

    ToolInvoker(Supplier<List<ToolProvider>> providers,
                Supplier<List<ToolCallGuard>> guards,
                Supplier<List<ToolResultTransformer>> transformers,
                Logger log) {
        this.providers = providers;
        this.guards = guards;
        this.transformers = transformers;
        this.log = log;
    }

    /**
     * Resolves the current tool set: every {@link ToolProvider} in load order,
     * keyed by tool name, first definition wins. A name defined twice logs a
     * {@code WARN} naming both providers and keeps the first.
     *
     * @return the resolved tools in discovery order
     */
    Map<String, ToolDefinition> resolveTools() {
        Map<String, ToolDefinition> resolved = new LinkedHashMap<>();
        Map<String, String> owners = new LinkedHashMap<>();
        for (ToolProvider provider : providers.get()) {
            if (provider == null) {
                continue;
            }
            String owner = provider.getClass().getName();
            List<ToolDefinition> definitions = provider.tools();
            if (definitions == null) {
                continue;
            }
            for (ToolDefinition definition : definitions) {
                if (definition == null || definition.name() == null) {
                    continue;
                }
                String previousOwner = owners.putIfAbsent(definition.name(), owner);
                if (previousOwner != null) {
                    log.warn("tool name '{}' defined by both {} and {}; keeping the first",
                            definition.name(), previousOwner, owner);
                    continue;
                }
                resolved.put(definition.name(), definition);
            }
        }
        return resolved;
    }

    /**
     * Executes one tool call through the full pipeline: resolve the tool,
     * run the guard chain (first block wins, an exception blocks), execute the
     * body (a thrown exception becomes an error result) and run the
     * transformer chain (a throwing transformer is skipped).
     *
     * @param call the call requested by the model
     * @param ctx  the per-run tool context
     * @return the final result, never {@code null}
     */
    ToolResult invoke(ToolCall call, ToolContext ctx) {
        ToolDefinition tool = resolveTools().get(call.name());
        if (tool == null) {
            return ToolResult.error("unknown tool: " + call.name());
        }
        ToolResult blocked = runGuards(call);
        if (blocked != null) {
            return blocked;
        }
        ToolResult result;
        try {
            result = tool.execute(call, ctx);
            if (result == null) {
                result = ToolResult.error("tool '" + call.name() + "' returned no result");
            }
        } catch (Exception e) {
            result = ToolResult.error(reasonOf(e));
        }
        return runTransformers(result);
    }

    private ToolResult runGuards(ToolCall call) {
        for (ToolCallGuard guard : guards.get()) {
            if (guard == null) {
                continue;
            }
            ToolCallDecision decision;
            try {
                decision = guard.check(call);
            } catch (RuntimeException e) {
                log.warn("tool call guard {} threw; blocking the call", guard.getClass().getName(), e);
                return ToolResult.error(BLOCKED_PREFIX + reasonOf(e));
            }
            if (decision == null) {
                return ToolResult.error(BLOCKED_PREFIX + "guard " + guard.getClass().getName()
                        + " returned no decision");
            }
            if (decision.blocked()) {
                String reason = (decision.reason() == null) ? "blocked by "
                        + guard.getClass().getName() : decision.reason();
                return ToolResult.error(BLOCKED_PREFIX + reason);
            }
        }
        return null;
    }

    private ToolResult runTransformers(ToolResult result) {
        ToolResult current = result;
        for (ToolResultTransformer transformer : transformers.get()) {
            if (transformer == null) {
                continue;
            }
            try {
                ToolResult next = transformer.transform(current);
                if (next != null) {
                    current = next;
                }
            } catch (RuntimeException e) {
                log.warn("tool result transformer {} failed; skipped",
                        transformer.getClass().getName(), e);
            }
        }
        return current;
    }

    private static String reasonOf(Throwable t) {
        String message = t.getMessage();
        return (message == null || message.isBlank()) ? t.getClass().getSimpleName() : message;
    }
}
