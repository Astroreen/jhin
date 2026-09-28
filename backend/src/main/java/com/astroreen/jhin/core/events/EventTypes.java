package com.astroreen.jhin.core.events;

public final class EventTypes {

    public static final String USER_MESSAGE = "user_message";
    public static final String MESSAGE_START = "message_start";
    public static final String TEXT_DELTA = "text_delta";
    public static final String MESSAGE_END = "message_end";
    public static final String TOOL_USE = "tool_use";
    public static final String TOOL_RESULT = "tool_result";
    public static final String RUN_START = "run_start";
    public static final String RUN_END = "run_end";
    public static final String ERROR = "error";
    public static final String SESSION_META = "session_meta";
    public static final String UI = "ui";

    private EventTypes() {}
}
