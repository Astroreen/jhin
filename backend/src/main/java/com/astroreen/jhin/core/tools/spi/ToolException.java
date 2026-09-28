package com.astroreen.jhin.core.tools.spi;

/** Ошибки sandbox и исполнения тулов (unchecked). */
public class ToolException extends RuntimeException {

    public ToolException(String message) {
        super(message);
    }

    public ToolException(String message, Throwable cause) {
        super(message, cause);
    }
}
