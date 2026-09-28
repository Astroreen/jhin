package com.astroreen.jhin.core.tools.impl;

import com.astroreen.jhin.core.tools.spi.ToolCall;
import com.astroreen.jhin.core.tools.spi.ToolContext;
import com.astroreen.jhin.core.tools.spi.ToolDefinition;
import com.astroreen.jhin.core.tools.spi.ToolResult;
import com.astroreen.jhin.core.tools.spi.ToolUpdate;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.zeroturnaround.exec.ProcessExecutor;
import org.zeroturnaround.exec.ProcessResult;
import org.zeroturnaround.exec.StartedProcess;
import org.zeroturnaround.exec.stream.LineConsumer;

/**
 * Тул "powershell": исполнение PowerShell-команды (Windows-only).
 *
 * <p><b>Регистрация — только Windows.</b> Класс не {@code @Component}; бин создаёт
 * {@link PowerShellToolConfig} под {@code @Conditional(OnWindowsCondition)} (os.name
 * содержит "windows"). На Linux/macOS тула нет ни в контексте, ни в реестре.
 *
 * <p><b>Исполнение.</b> {@code powershell -NoProfile -NonInteractive -Command <command>};
 * если бинарник {@code powershell} не стартует (отсутствует в системе) — fallback на
 * {@code pwsh} (PowerShell 7+) с теми же флагами. Порядок фиксирован: сначала
 * {@code powershell}. Рабочая директория — {@link ToolContext#workdir()}.
 *
 * <p><b>Поведение — контракт {@link BashTool}.</b> Стриминг строк через
 * {@code ctx.publish(new ToolUpdate("powershell", line, true))}; stdout и stderr
 * мерджатся в порядке поступления целых строк (arrival order), формат
 * {@code ToolResult.content} — строки через {@code \n} без завершающего перевода строки.
 *
 * <p><b>Трункация.</b> Накопление и стриминг останавливаются после 2000 строк ИЛИ
 * 51200 байт (UTF-8, +1 байт на разделитель). Невлезающая строка отбрасывается целиком,
 * {@code truncated=true}.
 *
 * <p><b>Таймаут.</b> Аргумент {@code timeout} — секунды (Number). Отсутствует/ null —
 * без ограничения; дробные — floor до миллисекунд; {@code <=0} / NaN / не-Number —
 * ошибка; кламп к {@code Integer.MAX_VALUE} мс. По истечении — tree-kill и ошибка
 * {@code "timed out"} (content = маркер или маркер + захваченный вывод).
 *
 * <p><b>Отмена.</b> {@code ctx.isCancelled()} до старта → error "cancelled". Во время
 * исполнения вотчдог (100 мс) ловит флаг отмены → tree-kill → ошибка "cancelled".
 *
 * <p><b>Tree-kill</b> — {@link BashTool#treeKill} (снапшот descendants + self,
 * destroyForcibly каждому, ожидание смерти до 2 с).
 *
 * <p><b>Meta-ключи:</b> {@code exitCode} (Integer; -1 если неизвестен),
 * {@code timedOut} (Boolean), {@code cancelled} (Boolean).
 *
 * <p><b>Код выхода — не ошибка.</b> Ненулевой exit code даёт {@code error=false} —
 * судит LLM по content и exitCode. {@code error=true} только для отмены, таймаута,
 * пустой команды и сбоев запуска. Из {@code execute} исключения не выходят.
 */
public class PowerShellTool implements ToolDefinition {

    private static final int MAX_LINES = 2000;
    private static final int MAX_BYTES = 51200;
    private static final long WATCHDOG_PERIOD_MS = 100;
    private static final List<String> SHELLS = List.of("powershell", "pwsh");

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
        return "Windows only. Runs a PowerShell command in the session working directory and streams its output.";
    }

    @Override
    public String promptSnippet() {
        return "powershell - run a PowerShell command on Windows (streamed output, optional timeout in seconds)";
    }

    @Override
    public List<String> promptGuidelines() {
        return List.of(
                "Use powershell to run PowerShell commands on Windows hosts only.",
                "stdout and stderr are merged in arrival order and streamed live.",
                "Pass 'timeout' (seconds) for commands that may hang; without it there is no time limit.",
                "A non-zero exit code is not an error - read the output and exitCode to judge success.",
                "Prefer specialized file tools for file reads, edits and search when available.");
    }

    @Override
    public Map<String, Object> parametersSchema() {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        Map<String, Object> command = new LinkedHashMap<>();
        command.put("type", "string");
        command.put("description", "PowerShell command to run");
        properties.put("command", command);
        Map<String, Object> timeout = new LinkedHashMap<>();
        timeout.put("type", "number");
        timeout.put("description", "seconds");
        properties.put("timeout", timeout);
        schema.put("properties", properties);
        schema.put("required", List.of("command"));
        return schema;
    }

    @Override
    public ToolResult execute(ToolCall call, ToolContext ctx) {
        Map<String, Object> args = call.arguments();
        Object rawCommand = args.get("command");
        if (!(rawCommand instanceof String command) || command.isBlank()) {
            return ToolResult.error("command must not be blank");
        }

        Long timeoutMillis;
        try {
            timeoutMillis = resolveTimeoutMillis(args.get("timeout"));
        } catch (IllegalArgumentException e) {
            return ToolResult.error(e.getMessage());
        }

        if (ctx.isCancelled()) {
            return ToolResult.error("cancelled");
        }

        LineCollector collector = new LineCollector(ctx);
        LineConsumer sink = collector::accept;

        StartedProcess started = null;
        String launchError = null;
        for (String shell : SHELLS) {
            try {
                ProcessExecutor executor =
                        new ProcessExecutor(shellCommand(shell, command))
                                .directory(new File(ctx.workdir().toString()))
                                .exitValueAny()
                                .redirectOutput(sink)
                                .redirectError(sink);
                started = executor.start();
                break;
            } catch (Exception e) {
                launchError = message(e);
            }
        }
        if (started == null) {
            return ToolResult.error("failed to start process: " + launchError);
        }

        boolean timedOut = false;
        boolean cancelled = false;
        try {
            long deadlineNs =
                    timeoutMillis == null ? 0 : System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
            while (!started.getFuture().isDone()) {
                if (ctx.isCancelled()) {
                    cancelled = true;
                    BashTool.treeKill(started.getProcess().toHandle());
                    break;
                }
                if (timeoutMillis != null && System.nanoTime() - deadlineNs >= 0) {
                    timedOut = true;
                    BashTool.treeKill(started.getProcess().toHandle());
                    break;
                }
                Thread.sleep(WATCHDOG_PERIOD_MS);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            BashTool.treeKill(started.getProcess().toHandle());
            return abnormal(collector, "interrupted", false, false, -1);
        } catch (RuntimeException e) {
            BashTool.treeKill(started.getProcess().toHandle());
            return abnormal(collector, "failed: " + message(e), false, false, -1);
        }

        Integer exitCode = -1;
        try {
            ProcessResult result = started.getFuture().get();
            exitCode = result.getExitValue();
        } catch (Exception e) {
            exitCode = -1;
        }

        if (timedOut) {
            return abnormal(collector, "timed out", true, false, exitCode);
        }
        if (cancelled) {
            return abnormal(collector, "cancelled", false, true, exitCode);
        }

        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("exitCode", exitCode);
        meta.put("timedOut", false);
        meta.put("cancelled", false);
        return new ToolResult(collector.content(), false, collector.truncated(), null, meta);
    }

    private static List<String> shellCommand(String shell, String command) {
        return List.of(shell, "-NoProfile", "-NonInteractive", "-Command", command);
    }

    /**
     * Число миллисекунд таймаута или null (без ограничения). Дробные секунды
     * флоорятся до миллисекунд; положительные значения клампятся к Integer.MAX_VALUE мс.
     */
    private static Long resolveTimeoutMillis(Object rawTimeout) {
        if (rawTimeout == null) {
            return null;
        }
        if (!(rawTimeout instanceof Number number)) {
            throw new IllegalArgumentException("timeout must be a number (seconds)");
        }
        double seconds = number.doubleValue();
        if (!(seconds > 0)) {
            throw new IllegalArgumentException("timeout must be positive (seconds)");
        }
        long millis = (long) Math.floor(seconds * 1000.0);
        if (millis <= 0) {
            millis = 1;
        }
        return (long) Math.min(millis, Integer.MAX_VALUE);
    }

    private static ToolResult abnormal(
            LineCollector collector, String marker, boolean timedOut, boolean cancelled, int exitCode) {
        String captured = collector.content();
        String content = captured.isEmpty() ? marker : marker + "\n" + captured;
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("exitCode", exitCode);
        meta.put("timedOut", timedOut);
        meta.put("cancelled", cancelled);
        return new ToolResult(content, true, collector.truncated(), null, meta);
    }

    private static String message(Exception e) {
        return e.getMessage() != null ? e.getMessage() : e.toString();
    }

    /**
     * Общий коллектор stdout+stderr: merge целых строк в порядке поступления,
     * лимиты накопления/стриминга, публикация ToolUpdate построчно.
     */
    private static final class LineCollector {

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
            ctx.publish(new ToolUpdate("powershell", line, true));
        }

        synchronized String content() {
            return String.join("\n", lines);
        }

        synchronized boolean truncated() {
            return truncated;
        }
    }
}
