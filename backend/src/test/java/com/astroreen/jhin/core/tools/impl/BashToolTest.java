package com.astroreen.jhin.core.tools.impl;

import static org.assertj.core.api.Assertions.assertThat;

import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import com.astroreen.jhin.core.tools.spi.ToolUpdate;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BashToolTest {

    @TempDir
    Path workdir;

    private final BashTool tool = new BashTool();
    private final List<ToolUpdate> updates = Collections.synchronizedList(new ArrayList<>());

    @Test
    void happyPathEcho() {
        ToolResult result = tool.execute(call("command", "echo hi"), ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.content()).contains("hi");
        assertThat(result.meta()).containsEntry("exitCode", 0);
        assertThat(result.meta()).containsEntry("timedOut", false);
        assertThat(updates).isNotEmpty();
        assertThat(updates)
                .anyMatch(
                        u ->
                                "bash".equals(u.toolName())
                                        && u.streaming()
                                        && u.chunk().contains("hi"));
    }

    @Test
    void timeoutKillsProcess() {
        ToolContext ctx = ctx();
        long start = System.nanoTime();

        ToolResult result = tool.execute(call("command", "echo PID=$$; sleep 100", "timeout", 2), ctx);

        long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        assertThat(elapsedMs).isLessThan(8000);
        assertThat(result.error()).isTrue();
        assertThat(result.content()).contains("timed out");
        assertThat(result.meta()).containsEntry("timedOut", true);
        assertThat(result.meta()).containsEntry("cancelled", false);

        long pid = parsePid(updates);
        assertThat(pid).isPositive();
        assertThat(isDeadOrGone(pid)).isTrue();
    }

    @Test
    void treeKillKillsDescendants() {
        ToolContext ctx = ctx();

        ToolResult result =
                tool.execute(call("command", "sh -c 'sleep 30 & echo CHILD=$!; wait'", "timeout", 2), ctx);

        assertThat(result.error()).isTrue();
        assertThat(result.meta()).containsEntry("timedOut", true);

        long pid = parseChildPid(updates);
        assertThat(pid).isPositive();
        assertThat(isDeadOrGone(pid)).isTrue();
    }

    @Test
    void cancelStopsRun() throws Exception {
        ToolContext ctx = ctx();
        AtomicBoolean cancelIssued = new AtomicBoolean(false);
        Thread canceller =
                new Thread(
                        () -> {
                            try {
                                Thread.sleep(300);
                            } catch (InterruptedException ignored) {
                                Thread.currentThread().interrupt();
                            }
                            ctx.cancel();
                            cancelIssued.set(true);
                        });
        canceller.start();
        long start = System.nanoTime();

        ToolResult result = tool.execute(call("command", "echo PID=$$; sleep 30"), ctx);

        canceller.join(TimeUnit.SECONDS.toMillis(10));
        long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start);
        assertThat(cancelIssued).isTrue();
        assertThat(elapsedMs).isLessThan(8000);
        assertThat(result.error()).isTrue();
        assertThat(result.content()).contains("cancelled");
        assertThat(result.meta()).containsEntry("cancelled", true);
        assertThat(result.meta()).containsEntry("timedOut", false);

        long pid = parsePid(updates);
        assertThat(pid).isPositive();
        assertThat(isDeadOrGone(pid)).isTrue();
    }

    @Test
    void truncationLimitsOutput() {
        ToolResult result =
                tool.execute(
                        call(
                                "command",
                                "i=0; while [ $i -lt 3000 ]; do echo line$i; i=$((i+1)); done"),
                        ctx());

        assertThat(result.error()).isFalse();
        assertThat(result.truncated()).isTrue();
        int lineCount = result.content().split("\n", -1).length;
        assertThat(lineCount).isLessThanOrEqualTo(2000);
        assertThat(result.content().getBytes(StandardCharsets.UTF_8).length)
                .isLessThanOrEqualTo(51200);
    }

    @Test
    void blankCommandErrors() {
        assertThat(tool.execute(call("command", ""), ctx()).error()).isTrue();
        assertThat(tool.execute(call("command", "   "), ctx()).error()).isTrue();
        assertThat(tool.execute(call(), ctx()).error()).isTrue();
    }

    private ToolContext ctx() {
        ToolContext ctx = new ToolContext(workdir, "s1", "r1", "a1");
        ctx.setOnUpdate(updates::add);
        return ctx;
    }

    private static ToolCall call(Object... kv) {
        Map<String, Object> args = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            args.put((String) kv[i], kv[i + 1]);
        }
        return new ToolCall("bash", args, "c1");
    }

    private static long parsePid(List<ToolUpdate> updates) {
        return parsePrefixedPid(updates, "PID=");
    }

    private static long parseChildPid(List<ToolUpdate> updates) {
        return parsePrefixedPid(updates, "CHILD=");
    }

    private static long parsePrefixedPid(List<ToolUpdate> updates, String prefix) {
        synchronized (updates) {
            for (ToolUpdate update : updates) {
                String chunk = update.chunk();
                if (chunk != null && chunk.startsWith(prefix)) {
                    return Long.parseLong(chunk.substring(prefix.length()).trim());
                }
            }
        }
        return -1;
    }

    private static boolean isDeadOrGone(long pid) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
        while (System.nanoTime() - deadline < 0) {
            Optional<ProcessHandle> handle = ProcessHandle.of(pid);
            if (handle.isEmpty() || !handle.get().isAlive()) {
                return true;
            }
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        Optional<ProcessHandle> handle = ProcessHandle.of(pid);
        return handle.isEmpty() || !handle.get().isAlive();
    }
}
