/**
 * The plugin-facing seam for deferred and periodic work.
 *
 * <p>Implemented by the kernel (which owns a single executor) and reached by
 * plugins through the plugin context. The SDK declares the contract only —
 * it never implements scheduling, spawns threads or holds an executor.
 *
 * <p>Runtime contract the kernel implementation must honour:
 *
 * <ul>
 *   <li>{@link #schedule(TaskSpec)} accepts the spec and returns it as the
 *       handle; scheduling a name that is already taken cancels the previous
 *       task and replaces it.</li>
 *   <li>{@link #cancel(String)} is idempotent: cancelling an unknown or
 *       already-cancelled name is a no-op that returns {@code false} and
 *       never throws.</li>
 *   <li>A task that throws is logged and swallowed: the exception must not
 *       kill the host nor the schedule loop — a periodic task keeps its
 *       schedule after a throwing run, a one-shot that throws is simply
 *       done.</li>
 *   <li>Everything scheduled is dropped at host shutdown; plugins that need
 *       a graceful stop use their own lifecycle hooks.</li>
 * </ul>
 */
package com.astroreen.jhin.sdk.sched;

import java.util.Set;

public interface SchedulerRegistry {

    /**
     * Schedules a task for execution. Called by plugins at start-up or when
     * work needs deferring.
     *
     * @param spec the task description
     * @return the accepted spec, as the handle for the scheduled task
     */
    TaskSpec schedule(TaskSpec spec);

    /**
     * Cancels the task scheduled under the given name. Idempotent: an unknown
     * or already-cancelled name is a no-op, never an exception. Called by
     * plugins replacing or retiring their background work.
     *
     * @param name the task name given at schedule time
     * @return {@code true} when a scheduled task was cancelled,
     *         {@code false} when nothing was scheduled under the name
     */
    boolean cancel(String name);

    /**
     * Lists the names of the currently scheduled tasks. Called by plugins and
     * by host diagnostics.
     *
     * @return the set of scheduled task names, never {@code null}
     */
    Set<String> names();
}
