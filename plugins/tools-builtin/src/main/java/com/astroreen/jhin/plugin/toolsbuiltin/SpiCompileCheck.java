/**
 * Compile-time proof of the plugin-to-plugin dependency on {@code jhin.agent}:
 * references every type of the exported package
 * {@code com.astroreen.jhin.plugin.agent.api} and nothing else from the agent
 * plugin, exactly as a real dependant would. If this file compiles with only
 * {@code compileOnly 'com.astroreen:jhin-plugin-agent:0.2.0'} on the class
 * path, the export boundary is complete.
 *
 * <p>Deliberately does nothing at runtime: the methods are never called and
 * will be deleted once T34 implements the real tools against the same types.
 */
package com.astroreen.jhin.plugin.toolsbuiltin;

import com.astroreen.jhin.plugin.agent.api.PluginVetoException;
import com.astroreen.jhin.plugin.agent.api.PromptContext;
import com.astroreen.jhin.plugin.agent.api.PromptInterceptor;
import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolCallDecision;
import com.astroreen.jhin.plugin.agent.api.ToolCallGuard;
import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.agent.api.ToolException;
import com.astroreen.jhin.plugin.agent.api.ToolProvider;
import com.astroreen.jhin.plugin.agent.api.ToolResult;
import com.astroreen.jhin.plugin.agent.api.ToolResultTransformer;
import com.astroreen.jhin.plugin.agent.api.ToolUpdate;
import java.nio.file.Path;
import java.util.List;

final class SpiCompileCheck {

    private SpiCompileCheck() {}

    static ToolProvider provider(ToolDefinition definition) {
        return () -> List.of(definition);
    }

    static ToolCallGuard allowAll() {
        return call -> ToolCallDecision.allow();
    }

    static ToolResultTransformer keepContent() {
        return result -> ToolResult.ok(result.content(), result.structured());
    }

    static PromptInterceptor appendNote() {
        return ctx -> ctx.withSystemPrompt(ctx.systemPrompt() + "\n# compile check");
    }

    static String exercise(ToolDefinition tool, ToolCall call, ToolContext ctx) throws Exception {
        ctx.cancel();
        ctx.publish(new ToolUpdate("checking"));
        Path path = ctx.resolvePath("README.md");
        ctx.markRead(path);
        boolean seen = ctx.hasRead(path) && !ctx.readPaths().isEmpty();
        ToolResult result = tool.execute(call, ctx);
        return ctx.sessionId() + ctx.runId() + ctx.accountId() + ctx.workdir()
                + seen + result.error() + ctx.isCancelled();
    }

    static RuntimeException failures() {
        PromptContext ctx = new PromptContext("session", "prompt");
        return new PluginVetoException(ctx.systemPrompt(), new ToolException("no tools"));
    }
}
