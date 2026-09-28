package com.astroreen.jhin.core.events;

/** Хэндл подписки на события сессии; {@link #unsubscribe()} идемпотентен и потокобезопасен. */
public interface EventSubscription {

    void unsubscribe();

    boolean isActive();
}
