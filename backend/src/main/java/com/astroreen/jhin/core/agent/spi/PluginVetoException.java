package com.astroreen.jhin.core.agent.spi;

/** Вето плагина: прерывает сборку system prompt (а значит и run) с причиной. */
public class PluginVetoException extends Exception {

    private final String reason;

    public PluginVetoException(String reason) {
        super(reason);
        this.reason = reason;
    }

    public String getReason() {
        return reason;
    }
}
