/**
 * The {@code ask_user} tool: asks the user a question mid-run and blocks the
 * tool call until the answer arrives, over the {@link QuestionBridge}
 * published by this plugin.
 *
 * <p><b>Arguments.</b> {@code question} (required), {@code options}
 * (optional array of predefined answers; omit for a free-text question).
 *
 * <p><b>Call identity.</b> The question is keyed on the session id from
 * {@link ToolContext#sessionId()} and the call id from {@link ToolCall#id()}
 * (unique per run), so the answer route can complete exactly this call's
 * future.
 *
 * <p><b>Blocking.</b> The call registers the question and blocks on the
 * answer future with {@code get()}: NO timeout - the call waits as long as
 * the user needs. The answer text is returned as the tool result content.
 *
 * <p><b>Failures.</b> A missing or blank {@code question} is
 * {@code "question must not be blank"} (and no question is registered);
 * {@code options} of a wrong shape is {@code "options must be an array of
 * strings"}; a cancelled question (the session went away) is
 * {@code "Question cancelled"}; an interrupted wait restores the interrupt
 * flag and returns {@code "Question interrupted"}. As every tool in this set,
 * a failure is a {@code ToolResult.error(message)}, never a thrown exception.
 */
package com.astroreen.jhin.plugin.toolsbuiltin;

import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.agent.api.ToolException;
import com.astroreen.jhin.plugin.agent.api.ToolResult;
import com.astroreen.jhin.plugin.toolsbuiltin.api.QuestionBridge;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;

final class AskUserTool implements ToolDefinition {

    private final QuestionBridge bridge;

    AskUserTool(QuestionBridge bridge) {
        this.bridge = bridge;
    }

    @Override
    public String name() {
        return "ask_user";
    }

    @Override
    public String label() {
        return "Ask user";
    }

    @Override
    public String description() {
        return "Asks the user a question and waits for the answer, optionally offering predefined options."
                + " Blocks until the user answers or the question is cancelled.";
    }

    @Override
    public String parametersSchema() {
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("question", FileToolSupport.property("string", "The question to show to the user"));
        Map<String, Object> items = new LinkedHashMap<>();
        items.put("type", "string");
        Map<String, Object> options = new LinkedHashMap<>();
        options.put("type", "array");
        options.put("items", items);
        options.put("description", "Predefined answers to choose from; omit for a free-text question");
        properties.put("options", options);
        return FileToolSupport.schema(properties, List.of("question"));
    }

    @Override
    public String promptSnippet() {
        return "ask_user - ask the user a question and wait for the answer (optional predefined options)";
    }

    @Override
    public String promptGuidelines() {
        return "Use ask_user when you need a decision or fact only the user can provide.\n"
                + "The call blocks until the user answers - never use it for anything you can resolve yourself.\n"
                + "Pass options as short predefined answers when the choice is finite; omit them for free text.\n"
                + "Keep the question short and self-contained; the user sees just this question while the run is paused.";
    }

    @Override
    public ToolResult execute(ToolCall call, ToolContext ctx) {
        Map<String, Object> args;
        String question;
        List<String> options;
        try {
            args = FileToolSupport.args(call);
            question = FileToolSupport.requireString(args, "question");
            options = optionsArg(args);
        } catch (ToolException e) {
            return ToolResult.error(e.getMessage());
        }
        if (ctx.isCancelled()) {
            return ToolResult.error("cancelled");
        }
        CompletionStage<String> asked = bridge.ask(ctx.sessionId(), call.id(), question, options);
        try {
            return ToolResult.ok(asked.toCompletableFuture().get());
        } catch (CancellationException e) {
            return ToolResult.error("Question cancelled");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return ToolResult.error("Question interrupted");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            if (cause instanceof CancellationException) {
                return ToolResult.error("Question cancelled");
            }
            return ToolResult.error(cause.getMessage() != null ? cause.getMessage() : cause.toString());
        }
    }

    /** @throws ToolException when {@code options} is present but not an array of strings */
    private static List<String> optionsArg(Map<String, Object> args) {
        Object raw = args.get("options");
        if (raw == null) {
            return List.of();
        }
        if (!(raw instanceof List<?> list)) {
            throw new ToolException("options must be an array of strings");
        }
        List<String> options = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof String value)) {
                throw new ToolException("options must be an array of strings");
            }
            options.add(value);
        }
        return List.copyOf(options);
    }
}
