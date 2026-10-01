/**
 * The {@code powershell} tool: runs a PowerShell command in the session
 * workdir through zt-exec with an explicit {@code powershell -Command}
 * wrapper. Windows-only.
 *
 * <p><b>Registration - Windows only.</b> {@link ToolsPlugin} adds this tool
 * only when {@code System.getProperty("os.name")} starts with {@code Windows};
 * on Linux and macOS hosts it is registered nowhere. No execution test runs on
 * non-Windows CI - the registration condition itself is unit-tested.
 *
 * <p><b>Execution.</b> {@code powershell -NoProfile -NonInteractive -Command
 * <command>} with the working directory set to {@link ToolContext#workdir()}.
 * The behaviour contract is exactly {@link BashTool}: line-merged streaming
 * output through {@link ToolUpdate}s, 2000-line / 51200-byte caps, the same
 * timeout (default 60 s), cancellation watchdog and tree-kill, and the same
 * exit-code contract ({@code "Command failed with exit code <N>"} on a
 * non-zero exit). A successful run returns a {@code card} with rows
 * {@code command}, {@code exitCode} and {@code durationMs}.
 */
package com.astroreen.jhin.plugin.toolsbuiltin;

import com.astroreen.jhin.plugin.agent.api.ToolCall;
import com.astroreen.jhin.plugin.agent.api.ToolContext;
import com.astroreen.jhin.plugin.agent.api.ToolDefinition;
import com.astroreen.jhin.plugin.agent.api.ToolException;
import com.astroreen.jhin.plugin.agent.api.ToolResult;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class PowerShellTool implements ToolDefinition {

    @Override
    public String name() {
        return "powershell";
    }

    @Override
    public String label() {
        return "PowerShell";
    }

    @Override
    public String description() {
        return "Windows only. Runs a PowerShell command in the session working directory via"
                + " 'powershell -Command' and streams its output.";
    }

    @Override
    public String parametersSchema() {
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("command", FileToolSupport.property("string", "PowerShell command to run"));
        properties.put("timeout", FileToolSupport.property("number", "Seconds before the command is killed (default 60)"));
        return FileToolSupport.schema(properties, List.of("command"));
    }

    @Override
    public String promptSnippet() {
        return "powershell - run a PowerShell command on Windows via 'powershell -Command'"
                + " (streamed output, timeout default 60s)";
    }

    @Override
    public String promptGuidelines() {
        return "Use powershell to run PowerShell commands on Windows hosts only.\n"
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
        Long timeoutMillis = BashTool.resolveTimeoutMillis(args.get("timeout"));
        return BashTool.ShellSupport.execute(
                List.of("powershell", "-NoProfile", "-NonInteractive", "-Command", command),
                command,
                timeoutMillis,
                ctx,
                "powershell");
    }
}
