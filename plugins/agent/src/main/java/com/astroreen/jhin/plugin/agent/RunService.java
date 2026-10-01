/**
 * The run lifecycle: one active run per session, asynchronous execution and
 * the {@code jhin_sessions_runs} ledger.
 *
 * <p>One active run per session: a second {@code POST
 * /sessions/{id}/messages} while a run is live is rejected with
 * {@link RunException#CODE_RUN_ACTIVE} (HTTP 409). The message route appends
 * the {@code user_message} event first, then the loop runs on a daemon
 * executor thread and the route returns {@code {"runId"}} immediately.
 *
 * <p>The ledger table is {@code jhin_sessions_runs} with the fixed columns
 * {@code id, session_id, status, started_at, ended_at, error}. It is created
 * by the <em>sessions</em> migration on purpose — the run lifecycle is a
 * sessions-domain table — while this plugin owns its rows at runtime. The
 * kernel migration guard only checks {@code CREATE} statements of a plugin's
 * own migrations, so the agent's {@code DbAccess} (prefix {@code jhin_agent_})
 * may read and write that table freely; this plugin declares no migrations of
 * its own.
 *
 * <p>Status vocabulary: {@code running} while live, {@code done} after a
 * {@code run_end}, {@code cancelled} when the cancel route was honoured and
 * {@code error} on failure; the {@code error} column then holds the failure
 * text (the same text as the run's {@code error} event).
 */
package com.astroreen.jhin.plugin.agent;

import com.astroreen.jhin.plugin.sessions.api.EventLog;
import com.astroreen.jhin.plugin.sessions.api.EventType;
import com.astroreen.jhin.plugin.sessions.api.Session;
import com.astroreen.jhin.sdk.db.DbAccess;
import com.astroreen.jhin.sdk.json.Json;
import com.astroreen.jhin.sdk.stream.StreamRegistry;
import java.nio.file.Path;
import java.sql.PreparedStatement;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import org.slf4j.Logger;

final class RunService {

    static final String STATUS_RUNNING = "running";
    static final String STATUS_DONE = "done";
    static final String STATUS_CANCELLED = "cancelled";
    static final String STATUS_ERROR = "error";

    private final DbAccess db;
    private final EventLog events;
    private final StreamRegistry streams;
    private final Function<RunContext, String> loop;
    private final Logger log;
    private final ExecutorService executor;
    private final ConcurrentHashMap<String, RunContext> active = new ConcurrentHashMap<>();

    RunService(DbAccess db, EventLog events, StreamRegistry streams,
               Function<RunContext, String> loop, Logger log) {
        this.db = db;
        this.events = events;
        this.streams = streams;
        this.loop = loop;
        this.log = log;
        this.executor = Executors.newCachedThreadPool(daemonThreads());
    }

    /**
     * Starts one run asynchronously: claims the session's run slot, appends
     * the {@code user_message} event, inserts the {@code running} ledger row
     * and submits the loop to the daemon executor.
     *
     * @param session the session to run in
     * @param text    the triggering user message
     * @return the run id
     * @throws RunException with code {@link RunException#CODE_RUN_ACTIVE} when
     *                      the session already has an active run
     */
    String start(Session session, String text) {
        String sessionId = session.id();
        String runId = UUID.randomUUID().toString();
        ToolContextImpl toolContext = new ToolContextImpl(
                Path.of(session.workdir()), sessionId, runId, session.accountId(), streams);
        RunContext ctx = new RunContext(runId, session, text, toolContext);
        RunContext previous = active.putIfAbsent(sessionId, ctx);
        if (previous != null) {
            throw new RunException(RunException.CODE_RUN_ACTIVE, 409,
                    "session " + sessionId + " already has an active run");
        }
        try {
            events.append(sessionId, EventType.USER_MESSAGE,
                    Json.write(Map.of("text", text)));
            insertRow(ctx);
        } catch (RuntimeException e) {
            active.remove(sessionId, ctx);
            throw e;
        }
        executor.execute(() -> execute(ctx));
        return ctx.runId();
    }

    /**
     * Flips the cancellation flag of the session's active run. The loop
     * observes it between steps and before tool execution; running tool bodies
     * observe it through {@code ToolContext.isCancelled()}.
     *
     * @param sessionId the session whose run to cancel
     * @throws RunException with code {@link RunException#CODE_NO_ACTIVE_RUN}
     *                      when the session has no active run
     */
    void cancel(String sessionId) {
        RunContext ctx = active.get(sessionId);
        if (ctx == null) {
            throw new RunException(RunException.CODE_NO_ACTIVE_RUN, 404,
                    "session " + sessionId + " has no active run");
        }
        ctx.cancel();
    }

    private void execute(RunContext ctx) {
        String failure;
        try {
            failure = loop.apply(ctx);
        } catch (Throwable t) {
            failure = messageOf(t);
            log.error("agent run {} threw", ctx.runId(), t);
            try {
                events.append(ctx.session().id(), EventType.ERROR,
                        Json.write(Map.of("message", failure)));
            } catch (RuntimeException ignored) {
                log.warn("cannot record the error event of run {}", ctx.runId());
            }
        }
        try {
            finish(ctx, failure);
        } finally {
            active.remove(ctx.session().id(), ctx);
        }
    }

    private void finish(RunContext ctx, String failure) {
        long endedAt = System.currentTimeMillis();
        String status;
        String error;
        if (failure == null) {
            status = STATUS_DONE;
            error = null;
        } else if (ctx.isCancelled()) {
            status = STATUS_CANCELLED;
            error = failure;
        } else {
            status = STATUS_ERROR;
            error = failure;
        }
        db.write(connection -> {
            try (PreparedStatement update = connection.prepareStatement(
                    "UPDATE jhin_sessions_runs SET status = ?, ended_at = ?, error = ?"
                            + " WHERE id = ?")) {
                update.setString(1, status);
                update.setLong(2, endedAt);
                update.setString(3, error);
                update.setString(4, ctx.runId());
                update.executeUpdate();
            }
            return null;
        });
    }

    private void insertRow(RunContext ctx) {
        db.write(connection -> {
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO jhin_sessions_runs(id, session_id, status, started_at, ended_at, error)"
                            + " VALUES (?, ?, ?, ?, NULL, NULL)")) {
                insert.setString(1, ctx.runId());
                insert.setString(2, ctx.session().id());
                insert.setString(3, STATUS_RUNNING);
                insert.setLong(4, System.currentTimeMillis());
                insert.executeUpdate();
            }
            return null;
        });
    }

    private static ThreadFactory daemonThreads() {
        AtomicInteger counter = new AtomicInteger();
        return task -> {
            Thread thread = new Thread(task, "jhin-agent-run-" + counter.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
    }

    private static String messageOf(Throwable t) {
        String message = t.getMessage();
        return (message == null || message.isBlank()) ? t.getClass().getSimpleName() : message;
    }
}
