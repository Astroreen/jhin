/**
 * The per-run execution environment a tool body receives next to its call.
 *
 * <p>An interface on purpose: the agent plugin supplies the implementation
 * (workdir confinement, read tracking, cancellation, event publication) and
 * tool plugins only consume it, so tool code stays testable against a fake
 * and the implementation may change without breaking compiled tools. One
 * instance exists per agent run and is shared by all tool calls of that run.
 */
package com.astroreen.jhin.plugin.agent.api;

import java.nio.file.Path;
import java.util.List;

public interface ToolContext {

    /**
     * The session working directory every tool path must stay inside.
     *
     * @return the workdir
     */
    Path workdir();

    /**
     * The session this run belongs to.
     *
     * @return the session id
     */
    String sessionId();

    /**
     * The run this tool call belongs to.
     *
     * @return the run id
     */
    String runId();

    /**
     * The account that owns the session.
     *
     * @return the account id
     */
    String accountId();

    /**
     * Resolves a user-supplied path against the workdir and confines it to the
     * workdir. The implementation resolves symlinks before the check, so no
     * link can escape the workspace.
     *
     * @param userPath the path as written by the model, absolute or relative
     * @return the resolved absolute path, guaranteed inside the workdir
     * @throws ToolException with the message
     *         {@code Path goes outside of workspace} when the path escapes
     */
    Path resolvePath(String userPath);

    /**
     * The paths already marked read during this run, in mark order.
     *
     * @return an unmodifiable snapshot of the read paths
     */
    List<Path> readPaths();

    /**
     * Records a path as read during this run. Tools call this so later calls
     * (and later turns of the same run) can skip re-reading unchanged files.
     *
     * @param path the path that was read
     */
    void markRead(Path path);

    /**
     * Whether {@link #markRead} was called for this path during this run.
     *
     * @param path the path to check
     * @return {@code true} when the path was already marked read
     */
    boolean hasRead(Path path);

    /**
     * Whether this run has been cancelled. Long-running tool bodies poll this
     * and return early with an error result when it flips.
     *
     * @return {@code true} when cancellation was requested
     */
    boolean isCancelled();

    /**
     * Requests cancellation of this run. Called by the cancel route
     * ({@code POST /sessions/{id}/cancel}); the running tool bodies observe it
     * through {@link #isCancelled()}.
     */
    void cancel();

    /**
     * Publishes one incremental update of a running tool to the session event
     * stream, so the UI can show live output before the final
     * {@link ToolResult}. Delivery is best-effort and ordered per call.
     *
     * @param update the output chunk to publish
     */
    void publish(ToolUpdate update);
}
