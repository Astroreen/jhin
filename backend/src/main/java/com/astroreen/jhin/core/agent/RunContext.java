package com.astroreen.jhin.core.agent;

import com.astroreen.jhin.core.tools.spi.ToolContext;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Состояние одного run'а: идентификаторы, workdir, модель/провайдер, {@link ToolContext}
 * для исполнения тулов и флаг отмены.
 *
 * <p>{@link #cancel()} поднимает флаг и этого контекста, и {@link ToolContext} — агент-цикл
 * и тулы видят отмену одинаково. Отмена кооперативная: цикл проверяет флаг в контрольных
 * точках (между колбэками стрима, между турами, между тулами), прерывание сокета LLM —
 * best-effort.
 */
public class RunContext {

    private final String runId;
    private final String sessionId;
    private final String accountId;
    private final Path workdir;
    private final String model;
    private final String providerId;
    private final ToolContext toolContext;
    private final AtomicBoolean cancelled = new AtomicBoolean(false);

    public RunContext(String runId, String sessionId, String accountId, Path workdir, String model, String providerId) {
        this.runId = runId;
        this.sessionId = sessionId;
        this.accountId = accountId;
        this.workdir = workdir.toAbsolutePath().normalize();
        this.model = model;
        this.providerId = providerId;
        this.toolContext = new ToolContext(this.workdir, sessionId, runId, accountId);
    }

    public String runId() {
        return runId;
    }

    public String sessionId() {
        return sessionId;
    }

    public String accountId() {
        return accountId;
    }

    public Path workdir() {
        return workdir;
    }

    public String model() {
        return model;
    }

    public String providerId() {
        return providerId;
    }

    public ToolContext toolContext() {
        return toolContext;
    }

    public boolean isCancelled() {
        return cancelled.get();
    }

    /** Отмена run'а: флаг контекста + {@link ToolContext#cancel()} (тулы прерываются). */
    public void cancel() {
        cancelled.set(true);
        toolContext.cancel();
    }
}
