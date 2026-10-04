/**
 * The product event vocabulary stored in the session event log and streamed on
 * the {@code sessions/<id>} topic.
 *
 * <p>One enum constant per event kind; the {@link #wire() wire name} is what
 * lands in the {@code type} column and in the published
 * {@code StreamEvent} discriminator. Payloads are JSON strings whose shape is
 * defined by the producer of each event kind.
 */
package com.astroreen.jhin.plugin.sessions.api;

public enum EventType {

    /** A message sent by the user into the session. */
    USER_MESSAGE("user_message"),

    /** The assistant starts producing a message. */
    MESSAGE_START("message_start"),

    /** One incremental fragment of assistant text. */
    TEXT_DELTA("text_delta"),

    /** The assistant finished producing a message. */
    MESSAGE_END("message_end"),

    /** The assistant requests a tool call. */
    TOOL_USE("tool_use"),

    /** The result of one tool call. */
    TOOL_RESULT("tool_result"),

    /** An agent run has started. */
    RUN_START("run_start"),

    /** An agent run has finished. */
    RUN_END("run_end"),

    /**
     * A lifecycle operation changed the session. Emitted by the lifecycle
     * service on every successful operation; the payload is the updated
     * session as JSON.
     */
    SESSION_UPDATED("session_updated"),

    /** Something failed; details live in the payload. */
    ERROR("error");

    private final String wire;

    EventType(String wire) {
        this.wire = wire;
    }

    /**
     * The wire name of this event kind: the value stored in the {@code type}
     * column and used as the stream event discriminator.
     *
     * @return the wire name
     */
    public String wire() {
        return wire;
    }

    /**
     * Resolves a wire name back to its event kind. Called when reading rows
     * from the event log.
     *
     * @param wire the wire name stored in the database
     * @return the matching event kind
     * @throws com.astroreen.jhin.sdk.PluginException when no kind matches
     */
    public static EventType fromWire(String wire) {
        for (EventType type : values()) {
            if (type.wire.equals(wire)) {
                return type;
            }
        }
        throw new com.astroreen.jhin.sdk.PluginException("unknown event type: " + wire);
    }
}
