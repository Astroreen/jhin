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
import java.util.stream.Stream;
import org.springframework.stereotype.Component;
import org.zeroturnaround.exec.ProcessExecutor;
import org.zeroturnaround.exec.ProcessResult;
import org.zeroturnaround.exec.StartedProcess;
import org.zeroturnaround.exec.stream.LineConsumer;

/**
 * Тул "bash": исполнение shell-команды в workdir сессии через zt-exec.
 *
 * <p>Исполнение: {@code /bin/sh -c <command>} (не-Windows) или {@code cmd /c <command>}
 * (Windows, по {@code os.name}). Рабочая директория — {@link ToolContext#workdir()}.
 *
 * <p><b>Стриминг и merge-правило.</b> stdout и stderr читаются двумя независимыми
 * памперами и сливаются в общий синхронизированный коллектор <b>в порядке поступления
 * целых строк</b> (arrival order), без префиксов-различителей потоков. Каждая строка
 * публикуется как {@link ToolUpdate}{@code ("bash", line, true)} и добавляется в
 * накопленный вывод. Формат {@code ToolResult.content} — те же строки через {@code \n},
 * без завершающего перевода строки.
 *
 * <p><b>Трункация.</b> Накопление и стриминг останавливаются после 2000 строк ИЛИ
 * 51200 байт (UTF-8, с учётом +1 байт на разделитель-перевод строки). Строка, не
 * влезающая в лимит, отбрасывается целиком, {@code truncated=true}.
 *
 * <p><b>Таймаут.</b> Аргумент {@code timeout} — секунды (Number). Отсутствует/ null —
 * без ограничения; дробные значения трактуются как секунды с миллисекундной дробью
 * (floor до миллисекунд). {@code <=0} / NaN / не-Number — ошибка. Значение клампится
 * к {@code Integer.MAX_VALUE} мс. По истечении — tree-kill и ошибка
 * {@code "timed out"}; захваченный на момент убийства вывод присоединяется после
 * этой строки (content = "timed out" или "timed out\n" + captured).
 *
 * <p><b>Отмена.</b> {@code ctx.isCancelled()} до старта → {@code ToolResult.error("cancelled")}.
 * Во время исполнения вотчдог (шаг 100 мс) ловит флаг отмены → tree-kill → ошибка
 * {@code "cancelled"} (content = "cancelled" или "cancelled\n" + captured).
 *
 * <p><b>Tree-kill.</b> Снапшот {@code descendants()} корневого handle + сам корень,
 * каждому {@code destroyForcibly()} с ожиданием смерти до 2 с. Используется на
 * таймауте, отмене и аварийных путях выхода.
 *
 * <p><b>Meta-ключи результата:</b> {@code exitCode} (Integer; -1 если код неизвестен),
 * {@code timedOut} (Boolean), {@code cancelled} (Boolean).
 *
 * <p><b>Код выхода — не ошибка.</b> Ненулевой exit code даёт {@code error=false}:
 * тулу достоверно неизвестно, успешна ли команда с точки зрения задачи (например,
 * {@code grep} без совпадений), поэтому судит LLM — по content и exitCode из meta.
 * {@code error=true} только для отмены, таймаута, пустой команды и сбоев запуска.
 * Из {@code execute} исключения не выходят — сбой процесса превращается в
 * ToolResult.error.
 */
@Component
public class BashTool implements ToolDefinition {

    private static final int MAX_LINES = 2000;
    private static final int MAX_BYTES = 51200;
    private static final long WATCHDOG_PERIOD_MS = 100;
    private static final long KILL_WAIT_MS = 2000;

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
        return "Runs a shell command in the session working directory and streams its output.";
    }

    @Override
    public String promptSnippet() {
        return "bash - run a shell command in the workdir (streamed output, optional timeout in seconds)";
    }

    @Override
    public List<String> promptGuidelines() {
        return List.of(
                "Use bash to run shell commands in the session working directory.",
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
        command.put("description", "Shell command to run");
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
        List<String> shell = shellCommand(command);

        StartedProcess started;
        try {
            ProcessExecutor executor =
                    new ProcessExecutor(shell)
                            .directory(new File(ctx.workdir().toString()))
                            .exitValueAny()
                            .redirectOutput(sink)
                            .redirectError(sink);
            started = executor.start();
        } catch (Exception e) {
            return ToolResult.error("failed to start process: " + message(e));
        }

        boolean timedOut = false;
        boolean cancelled = false;
        try {
            long deadlineNs =
                    timeoutMillis == null ? 0 : System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
            while (!started.getFuture().isDone()) {
                if (ctx.isCancelled()) {
                    cancelled = true;
                    treeKill(started.getProcess().toHandle());
                    break;
                }
                if (timeoutMillis != null && System.nanoTime() - deadlineNs >= 0) {
                    timedOut = true;
                    treeKill(started.getProcess().toHandle());
                    break;
                }
                Thread.sleep(WATCHDOG_PERIOD_MS);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            treeKill(started.getProcess().toHandle());
            return abnormal(collector, "interrupted", false, false, -1);
        } catch (RuntimeException e) {
            treeKill(started.getProcess().toHandle());
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

    private static List<String> shellCommand(String command) {
        if (isWindows()) {
            return List.of("cmd", "/c", command);
        }
        return List.of("/bin/sh", "-c", command);
    }

    private static boolean isWindows() {
        String os = System.getProperty("os.name", "");
        return os.startsWith("Windows");
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

    /** Tree-kill: снапшот descendants + self, destroyForcibly каждому, ожидание смерти до 2 с. */
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
            ctx.publish(new ToolUpdate("bash", line, true));
        }

        synchronized String content() {
            return String.join("\n", lines);
        }

        synchronized boolean truncated() {
            return truncated;
        }
    }
}
