/**
 * One session row of the {@code jhin_sessions_sessions} table.
 *
 * <p>Exposed to dependant plugins through the exported API package; mirrors the
 * table columns one to one so it can be persisted and replayed without a
 * separate mapping layer.
 */
package com.astroreen.jhin.plugin.sessions.api;

/**
 * @param id        unique session id
 * @param accountId owning account; {@code local} when no security plugin is present
 * @param title     user-visible session title
 * @param workdir   absolute workspace directory of the session
 * @param model     model name the session runs with; {@code null} until chosen
 * @param providerId provider id the session runs with; {@code null} until chosen
 * @param status    free-form session status; {@code active} on creation
 * @param createdAt creation time, epoch milliseconds
 * @param updatedAt last modification time, epoch milliseconds
 */
public record Session(
        String id,
        String accountId,
        String title,
        String workdir,
        String model,
        String providerId,
        String status,
        long createdAt,
        long updatedAt) {}
