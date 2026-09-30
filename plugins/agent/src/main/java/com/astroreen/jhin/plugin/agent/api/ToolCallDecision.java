/**
 * The verdict of one {@link ToolCallGuard}: allow the call or block it with a
 * reason.
 *
 * <p>Use the factories instead of the canonical constructor:
 * {@link #allow()} and {@link #block(String)} fix the flag consistently. A
 * blocked call yields a {@code tool_result} with {@code error: true} whose
 * text starts with {@code Blocked:} followed by the reason.
 */
package com.astroreen.jhin.plugin.agent.api;

/**
 * @param allowed {@code true} when the call may execute
 * @param reason  the block reason, surfaced to the model; {@code null} when
 *                {@code allowed} is {@code true}
 */
public record ToolCallDecision(boolean allowed, String reason) {

    /**
     * The call may execute.
     *
     * @return the allowing decision
     */
    public static ToolCallDecision allow() {
        return new ToolCallDecision(true, null);
    }

    /**
     * The call is blocked with a reason.
     *
     * @param reason the reason surfaced to the model, never {@code null}
     * @return the blocking decision
     */
    public static ToolCallDecision block(String reason) {
        return new ToolCallDecision(false, reason);
    }

    /**
     * @return {@code true} when the call may not execute
     */
    public boolean blocked() {
        return !allowed;
    }
}
