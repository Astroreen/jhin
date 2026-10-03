/**
 * The kernel's scheduler extension point: one shared executor serving every
 * plugin's deferred and periodic work.
 *
 * <p>Implements the SDK {@link com.astroreen.jhin.sdk.sched.SchedulerRegistry}
 * over a single {@link java.util.concurrent.ScheduledExecutorService} created
 * when the host loads its plugins. The pool size and the thread naming are
 * host constants (two daemon threads named {@code jhin-sched-1} /
 * {@code jhin-sched-2}); a plugin chooses only its task names, delays and
 * intervals. The registry holds no domain knowledge: a task is a name, a
 * delay, an optional interval and a runnable.
 *
 * <p>Runtime contract, mirroring the SDK Javadoc:
 *
 * <ul>
 *   <li>{@link #schedule(com.astroreen.jhin.sdk.sched.TaskSpec)} accepts the
 *       spec and returns it as the handle; a name that is already taken
 *       cancels the previous task and replaces it.</li>
 *   <li>A task that throws is logged and swallowed: the schedule survives a
 *       throwing run, the executor thread never dies and the host never
 *       dies.</li>
 *   <li>{@link #cancel(String)} is idempotent: an unknown or already
 *       cancelled name is a no-op that returns {@code false} and never
 *       throws.</li>
 *   <li>{@link #close()} stops accepting work, cancels every task and joins
 *       the executor with a bounded wait of 5 seconds before forcing the
 *       interrupt. It runs inside the plugin life cycle shutdown, after the
 *       plugins' own stop hooks and before their class loaders close, so a
 *       still-running task never touches a closed loader.</li>
 * </ul>
 */
package com.astroreen.jhin.kernel.sched;

import com.astroreen.jhin.sdk.sched.SchedulerRegistry;
import com.astroreen.jhin.sdk.sched.TaskSpec;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class SchedulerRegistryImpl implements SchedulerRegistry, AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(SchedulerRegistryImpl.class);

    /** Fixed pool size of the shared executor; a host constant, not a choice. */
    static final int POOL_SIZE = 2;

    /** Bounded join before the forced interrupt, in millis. */
    static final long JOIN_MILLIS = 5_000L;

    /** Extra wait after the forced interrupt, in millis. */
    static final long FORCE_JOIN_MILLIS = 1_000L;

    private final ScheduledExecutorService executor =
            Executors.newScheduledThreadPool(POOL_SIZE, this::threadOf);

    /** Task name to its live future; the source of truth for replace/cancel. */
    private final ConcurrentMap<String, ScheduledFuture<?>> scheduled = new ConcurrentHashMap<>();

    /** Set once {@link #close()} has run; afterwards scheduling is refused. */
    private final AtomicBoolean closed = new AtomicBoolean(false);

    /** Names the pool threads {@code jhin-sched-1}, {@code jhin-sched-2}, … */
    private final AtomicInteger threadSeq = new AtomicInteger();

    /** One daemon pool thread with its generic host name. */
    private Thread threadOf(Runnable work) {
        Thread thread = new Thread(work, "jhin-sched-" + threadSeq.incrementAndGet());
        thread.setDaemon(true);
        return thread;
    }

    /**
     * Schedules one task, replacing any task already registered under its
     * name. Called by plugins through their context; the runnable is wrapped
     * so a throw is logged and swallowed instead of killing the schedule.
     * Scheduling after {@link #close()} is refused with a warning and
     * returns the spec unscheduled.
     *
     * @param spec the task description
     * @return the accepted spec, as the handle for the scheduled task
     */
    @Override
    public TaskSpec schedule(TaskSpec spec) {
        Objects.requireNonNull(spec, "spec");
        if (closed.get()) {
            log.warn("task {} rejected: the scheduler is shut down", spec.name());
            return spec;
        }
        ScheduledFuture<?> previous = scheduled.remove(spec.name());
        if (previous != null) {
            previous.cancel(false);
            log.info("task {} replaced", spec.name());
        }
        ScheduledFuture<?> future = spec.periodic()
                ? executor.scheduleAtFixedRate(guarded(spec),
                        spec.initialDelay(), spec.interval(), TimeUnit.MILLISECONDS)
                : executor.schedule(guarded(spec), spec.initialDelay(), TimeUnit.MILLISECONDS);
        ScheduledFuture<?> raced = scheduled.put(spec.name(), future);
        if (raced != null) {
            // A concurrent schedule of the same name won the map slot.
            raced.cancel(false);
        }
        if (closed.get()) {
            // A concurrent close won the race; drop the task again.
            future.cancel(false);
            scheduled.remove(spec.name(), future);
        }
        return spec;
    }

    /**
     * Cancels the task scheduled under the given name. Idempotent: an
     * unknown or already-cancelled name is a no-op that returns
     * {@code false} and never throws. A running run is not interrupted; only
     * its future runs are dropped.
     *
     * @param name the task name given at schedule time
     * @return {@code true} when a scheduled task was cancelled
     */
    @Override
    public boolean cancel(String name) {
        if (name == null) {
            return false;
        }
        ScheduledFuture<?> future = scheduled.remove(name);
        if (future == null) {
            return false;
        }
        future.cancel(false);
        return true;
    }

    /**
     * Lists the names of the currently scheduled tasks. Called by plugins
     * and by host diagnostics.
     *
     * @return the set of scheduled task names, never {@code null}
     */
    @Override
    public Set<String> names() {
        return Set.copyOf(scheduled.keySet());
    }

    /**
     * Stops the scheduler: refuses new work, cancels every task and joins
     * the executor with a bounded wait of {@value #JOIN_MILLIS} ms before
     * forcing the interrupt (plus {@value #FORCE_JOIN_MILLIS} ms of grace).
     * Called by the plugin life cycle during host shutdown, after the
     * plugins' stop hooks and before their class loaders close. Idempotent.
     */
    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        for (Map.Entry<String, ScheduledFuture<?>> entry : scheduled.entrySet()) {
            entry.getValue().cancel(false);
        }
        scheduled.clear();
        executor.shutdown();
        try {
            if (!executor.awaitTermination(JOIN_MILLIS, TimeUnit.MILLISECONDS)) {
                log.warn("scheduled work still running after {} ms; forcing the interrupt",
                        JOIN_MILLIS);
                executor.shutdownNow();
                if (!executor.awaitTermination(FORCE_JOIN_MILLIS, TimeUnit.MILLISECONDS)) {
                    log.warn("scheduled work still running after the forced interrupt");
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            executor.shutdownNow();
        }
    }

    /**
     * Whether the executor has terminated. A host diagnostic for the
     * shutdown tests: {@code true} once {@link #close()} finished and every
     * pool thread exited.
     *
     * @return {@code true} when the executor is terminated
     */
    public boolean terminated() {
        return executor.isTerminated();
    }

    /** Wraps the task so a throw is logged and swallowed, keeping the schedule. */
    private Runnable guarded(TaskSpec spec) {
        return () -> {
            try {
                spec.runnable().run();
            } catch (Throwable failure) {
                log.warn("task {} failed: {}", spec.name(), failure, failure);
            }
        };
    }
}
