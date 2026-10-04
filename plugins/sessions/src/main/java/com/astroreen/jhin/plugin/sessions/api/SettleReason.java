/**
 * Why a session was settled: the values stored in the {@code settled_reason}
 * column and accepted by the lifecycle service and its routes.
 *
 * <p>One enum constant per reason; the {@link #wire() wire name} is what lands
 * in the column and on the wire. {@code pr_merged} is reserved for future PR
 * linking and is never produced by this plugin on its own.
 */
package com.astroreen.jhin.plugin.sessions.api;

public enum SettleReason {

    /** The user settled the session by hand. */
    MANUAL("manual"),

    /** The inactivity sweep settled the session. */
    INACTIVE("inactive"),

    /** The session was closed; reserved for future close handling. */
    CLOSED("closed"),

    /** The linked PR was merged; reserved for future PR linking. */
    PR_MERGED("pr_merged"),

    /** Anything else; the caller is expected to explain elsewhere. */
    OTHER("other");

    private final String wire;

    SettleReason(String wire) {
        this.wire = wire;
    }

    /**
     * The wire name of this reason: the value stored in the
     * {@code settled_reason} column.
     *
     * @return the wire name
     */
    public String wire() {
        return wire;
    }

    /**
     * Resolves a wire name back to its reason. Called when reading rows and
     * when parsing request bodies.
     *
     * @param wire the wire name
     * @return the matching reason, or {@code null} when the name is unknown
     */
    public static SettleReason fromWire(String wire) {
        for (SettleReason reason : values()) {
            if (reason.wire.equals(wire)) {
                return reason;
            }
        }
        return null;
    }
}
