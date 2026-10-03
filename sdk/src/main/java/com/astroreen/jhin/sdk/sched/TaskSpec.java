/**
 * One scheduled task a plugin asks the host to run: a name, a delay, an
 * optional interval and the work itself.
 *
 * <p>Created by a plugin and handed to
 * {@link SchedulerRegistry#schedule(TaskSpec)}. The SDK only describes the
 * task; the executor lives in the kernel (a single host-owned executor — see
 * {@link SchedulerRegistry} for the runtime contract).
 *
 * <p>Components: {@code name} — the task name, unique per host, not blank;
 * {@code initialDelay} — millis to wait before the first run, {@code >= 0};
 * {@code interval} — millis between runs, {@code >= 1}; {@code null} means a
 * one-shot task that runs exactly once after {@code initialDelay};
 * {@code runnable} — the work, never {@code null}.
 */
package com.astroreen.jhin.sdk.sched;

public record TaskSpec(String name, long initialDelay, Long interval, Runnable runnable) {

    /**
     * Creates a task spec, rejecting illegal arguments. Called by plugins
     * (usually through the {@link #oneShot} / {@link #periodic} factories).
     *
     * @param name         the task name, must not be {@code null} or blank
     * @param initialDelay millis before the first run, must be {@code >= 0}
     * @param interval     millis between runs, must be {@code >= 1} when
     *                     present; {@code null} makes the task one-shot
     * @param runnable     the work, must not be {@code null}
     * @throws IllegalArgumentException when any argument is illegal
     */
    public TaskSpec {
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("task name must not be null or blank");
        }
        if (initialDelay < 0) {
            throw new IllegalArgumentException("task initialDelay must be >= 0, got " + initialDelay);
        }
        if (interval != null && interval < 1) {
            throw new IllegalArgumentException("task interval must be >= 1, got " + interval);
        }
        if (runnable == null) {
            throw new IllegalArgumentException("task runnable must not be null");
        }
    }

    /**
     * Creates a one-shot task: it runs exactly once, {@code initialDelay}
     * millis from now. Called by plugins scheduling cleanup or deferred work.
     *
     * @param name         the task name, unique per host
     * @param initialDelay millis before the run, {@code >= 0}
     * @param runnable     the work
     * @return the task spec with a {@code null} interval
     */
    public static TaskSpec oneShot(String name, long initialDelay, Runnable runnable) {
        return new TaskSpec(name, initialDelay, null, runnable);
    }

    /**
     * Creates a periodic task: it first runs {@code initialDelay} millis from
     * now, then again every {@code interval} millis. Called by plugins
     * scheduling sweeps or refreshers.
     *
     * @param name         the task name, unique per host
     * @param initialDelay millis before the first run, {@code >= 0}
     * @param interval     millis between runs, {@code >= 1}
     * @param runnable     the work
     * @return the task spec with the given interval
     */
    public static TaskSpec periodic(String name, long initialDelay, long interval, Runnable runnable) {
        return new TaskSpec(name, initialDelay, interval, runnable);
    }

    /**
     * Tests whether the task repeats. Called by implementations to pick the
     * scheduling method.
     *
     * @return {@code true} when the task has an interval (periodic)
     */
    public boolean periodic() {
        return interval != null;
    }
}
