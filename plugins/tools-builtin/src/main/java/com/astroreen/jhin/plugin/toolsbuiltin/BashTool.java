/**
 * The {@code bash} tool: runs a shell command in the session workdir through
 * zt-exec with an explicit {@code sh -c} wrapper (no ad-hoc binaries - zt-exec
 * is a published library bundled into this plugin jar).
 *
 * <p><b>Execution.</b> {@code sh -c <command>} with the working directory set
 * to {@link ToolContext#workdir()}. stdout and stderr are read by two
 * independent pumps and merged into one collector <b>in whole-line arrival
 * order</b> (no stream prefixes). Every line is published as a
 * {@link ToolUpdate} for live output and appended to the result content
 * (lines joined with {@code \n}, no trailing newline).
 *
 * <p><b>Truncation.</b> Collection stops after 2000 lines OR 51200 UTF-8
 * bytes (plus 1 byte per separator); a line that does not fit is dropped
 * whole. On Windows hosts use the {@code powershell} tool instead.
 *
 * <p><b>Timeout.</b> The {@code timeout} argument is seconds (number, default
 * 60). On expiry the process tree is killed and the call fails with
 * {@code "timed out"} (captured output appended after the marker line).
 * Fractional seconds floor to milliseconds; {@code <= 0} / NaN / non-numbers
 * are rejected; values clamp to {@code Integer.MAX_VALUE} milliseconds.
 *
 * <p><b>Cancellation.</b> {@code ctx.isCancelled()} before the start is
 * {@code "cancelled"}; during the run a 100 ms watchdog flips on the flag,
 * tree-kills and fails with {@code "cancelled"}.
 *
 * <p><b>Tree-kill.</b> A snapshot of {@code descendants()} plus the root,
 * {@code destroyForcibly()} each, death awaited up to 2 s. Used on timeout,
 * cancellation and abnormal exits.
 *
 * <p><b>Exit code contract.</b> A non-zero exit code is a failure:
 * {@code "Command failed with exit code <N>"} with the captured output
 * appended after the marker line. {@code error} results carry no structured
 * payload; a successful run returns a {@code card} with rows {@code command},
 * {@code exitCode} and {@code durationMs}.
 */
package com.astroreen.jhin.plugin.toolsbuiltin;

import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.agent.api.ToolException;
import com.astroreen.jhin.plugin.agent.api.ToolResult;
import com.astroreen.jhin.plugin.agent.api.ToolUpdate;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import org.zeroturnaround.exec.ProcessExecutor;
import org.zeroturnaround.exec.ProcessResult;
import org.zeroturnaround.exec.StartedProcess;
import org.zeroturnaround.exec.stream.LineConsumer;

final class BashTool implements ToolDefinition {

    static final int MAX_LINES = 2000;
    static final int MAX_BYTES = 51200;
    static final long WATCHDOG_PERIOD_MS = 100;
    static final long KILL_WAIT_MS = 2000;
    static final int DEFAULT_TIMEOUT_SECONDS = 60;

    @Override
    public String name() {
        return "bash";
    }

    @Override
    public String label() {
        return "Bash";
    }

    @Override
    public String description() {
        return "Runs a shell command in the session working directory via 'sh -c' and streams its output.";
    }

    @Override
    public String parametersSchema() {
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("command", FileToolSupport.property("string", "Shell command to run"));
        properties.put("timeout", FileToolSupport.property("number", "Seconds before the command is killed (default 60)"));
        return FileToolSupport.schema(properties, List.of("command"));
    }

    @Override
    public String promptSnippet() {
        return "bash - run a shell command in the workdir via 'sh -c' (streamed output, timeout default 60s)";
    }

    @Override
    public String promptGuidelines() {
        return "Use bash to run shell commands in the session working directory.\n"
                + "stdout and stderr are merged in arrival order and streamed live.\n"
                + "Pass 'timeout' (seconds) for commands that may hang; the default is 60 seconds.\n"
                + "A non-zero exit code fails the call with 'Command failed with exit code N' plus the output.\n"
                + "Prefer specialized file tools for file reads, edits and search when available.";
    }

    @Override
    public ToolResult execute(ToolCall call, ToolContext ctx) {
        try {
            return run(call, ctx);
        } catch (ToolException e) {
            return ToolResult.error(e.getMessage());
        }
    }

    private ToolResult run(ToolCall call, ToolContext ctx) {
        Map<String, Object> args = FileToolSupport.args(call);
        String command = FileToolSupport.requireString(args, "command");
        Long timeoutMillis = resolveTimeoutMillis(args.get("timeout"));
        return ShellSupport.execute(List.of("sh", "-c", command), command, timeoutMillis, ctx, "bash");
    }

    /**
     * Timeout in milliseconds; the default applies when the argument is
     * absent. Fractional seconds floor to milliseconds; positive values clamp
     * to {@code Integer.MAX_VALUE} ms.
     *
     * @throws ToolException when the argument is not a positive number
     */
    static Long resolveTimeoutMillis(Object rawTimeout) {
        if (rawTimeout == null) {
            return (long) DEFAULT_TIMEOUT_SECONDS * 1000;
        }
        if (!(rawTimeout instanceof Number number)) {
            throw new ToolException("timeout must be a number (seconds)");
        }
        double seconds = number.doubleValue();
        if (!(seconds > 0)) {
            throw new ToolException("timeout must be positive (seconds)");
        }
        long millis = (long) Math.floor(seconds * 1000.0);
        if (millis <= 0) {
            millis = 1;
        }
        return (long) Math.min(millis, Integer.MAX_VALUE);
    }

    /** Tree-kill: snapshot of descendants + self, destroyForcibly each, await death up to 2 s. */
    static void treeKill(ProcessHandle root) {
        List<ProcessHandle> tree = Stream.concat(root.descendants(), Stream.of(root)).toList();
        tree.forEach(ProcessHandle::destroyForcibly);
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(KILL_WAIT_MS);
        for (ProcessHandle handle : tree) {
            while (handle.isAlive() && System.nanoTime() - deadline < 0) {
                try {
                    Thread.sleep(50);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    /**
     * Shared executor of the shell tools (zt-exec, explicit shell wrapper):
     * line-merged streaming output, watchdog for cancellation and timeout,
     * tree-kill, and the exit-code contract of {@link BashTool}.
     */
    static final class ShellSupport {

        private ShellSupport() {}

        static ToolResult execute(
                List<String> shell, String command, Long timeoutMillis, ToolContext ctx, String cardTitle) {
            if (ctx.isCancelled()) {
                return ToolResult.error("cancelled");
            }
            LineCollector collector = new LineCollector(ctx);
            LineConsumer sink = collector::accept;

            StartedProcess started;
            long startedAt = System.nanoTime();
            try {
                ProcessExecutor executor = new ProcessExecutor(shell)
                        .directory(new File(ctx.workdir().toString()))
                        .exitValueAny()
                        .redirectOutput(sink)
                        .redirectError(sink);
                started = executor.start();
            } catch (Exception e) {
                return ToolResult.error("failed to start process: " + FileToolSupport.message(e));
            }

            boolean timedOut = false;
            boolean cancelled = false;
            try {
                long deadlineNs =
                        System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
                while (!started.getFuture().isDone()) {
                    if (ctx.isCancelled()) {
                        cancelled = true;
                        BashTool.treeKill(started.getProcess().toHandle());
                        break;
                    }
                    if (System.nanoTime() - deadlineNs >= 0) {
                        timedOut = true;
                        BashTool.treeKill(started.getProcess().toHandle());
                        break;
                    }
                    Thread.sleep(WATCHDOG_PERIOD_MS);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                BashTool.treeKill(started.getProcess().toHandle());
                return abnormal(collector, "interrupted");
            } catch (RuntimeException e) {
                BashTool.treeKill(started.getProcess().toHandle());
                return abnormal(collector, "failed: " + FileToolSupport.message(e));
            }

            int exitCode = -1;
            try {
                ProcessResult result = started.getFuture().get();
                exitCode = result.getExitValue();
            } catch (Exception e) {
                exitCode = -1;
            }
            long durationMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt);

            if (timedOut) {
                return abnormal(collector, "timed out");
            }
            if (cancelled) {
                return abnormal(collector, "cancelled");
            }
            if (exitCode != 0) {
                String captured = collector.content();
                String marker = "Command failed with exit code " + exitCode;
                String content = captured.isEmpty() ? marker : marker + "\n" + captured;
                return ToolResult.error(content);
            }

            List<Map<String, String>> rows = new ArrayList<>();
            rows.add(FileToolSupport.Structured.row("command", command));
            rows.add(FileToolSupport.Structured.row("exitCode", Integer.toString(exitCode)));
            rows.add(FileToolSupport.Structured.row("durationMs", Long.toString(durationMs)));
            return ToolResult.ok(
                    collector.content(),
                    FileToolSupport.Structured.card(cardTitle, rows));
        }

        private static ToolResult abnormal(LineCollector collector, String marker) {
            String captured = collector.content();
            String content = captured.isEmpty() ? marker : marker + "\n" + captured;
            return ToolResult.error(content);
        }

        /**
         * Shared stdout+stderr collector: whole lines merged in arrival
         * order, output caps, one {@link ToolUpdate} per line.
         */
        static final class LineCollector {

            private final ToolContext ctx;
            private final List<String> lines = new ArrayList<>();
            private int bytes;
            private boolean truncated;

            LineCollector(ToolContext ctx) {
                this.ctx = ctx;
            }

            synchronized void accept(String line) {
                if (truncated) {
                    return;
                }
                int add = line.getBytes(StandardCharsets.UTF_8).length + 1;
                if (lines.size() >= MAX_LINES || bytes + add > MAX_BYTES) {
                    truncated = true;
                    return;
                }
                lines.add(line);
                bytes += add;
                ctx.publish(new ToolUpdate(line));
            }

            synchronized String content() {
                return String.join("\n", lines);
            }

            synchronized boolean truncated() {
                return truncated;
            }
        }
    }
}
