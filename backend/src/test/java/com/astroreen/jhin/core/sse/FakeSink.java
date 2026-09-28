package com.astroreen.jhin.core.sse;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/** Записывает вызовы send/comment/complete; потокобезопасно; complete идемпотентен. */
final class FakeSink implements SseSink {

    final List<String> frames = new CopyOnWriteArrayList<>();
    final List<String> comments = new CopyOnWriteArrayList<>();
    final AtomicInteger completions = new AtomicInteger();
    private final AtomicBoolean open = new AtomicBoolean(true);

    @Override
    public void send(String frame) {
        frames.add(frame);
    }

    @Override
    public void comment(String text) {
        comments.add(text);
    }

    @Override
    public void complete() {
        if (open.compareAndSet(true, false)) {
            completions.incrementAndGet();
        }
    }

    @Override
    public boolean isOpen() {
        return open.get();
    }
}
