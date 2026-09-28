package com.astroreen.jhin.core.sse;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Тестовый шов для SSE-подключения: минимальный контракт, который T23 адаптирует
 * поверх spring {@link SseEmitter}. Регистр и стрим-сервис работают только с ним.
 */
public interface SseSink {

    /** Отправить SSE-комментарий (heartbeat). */
    void comment(String text);

    /** Закрыть поток. Идемпотентно: не бросает, если уже закрыт. */
    void complete();

    boolean isOpen();

    static SseSink fromEmitter(SseEmitter emitter) {
        return new SseEmitterSink(emitter);
    }

    /** Тонкий адаптер {@link SseEmitter}: open-флаг переворачивается на complete/onCompletion/onTimeout/onError. */
    final class SseEmitterSink implements SseSink {

        private final SseEmitter emitter;
        private final AtomicBoolean open = new AtomicBoolean(true);

        SseEmitterSink(SseEmitter emitter) {
            this.emitter = emitter;
            emitter.onCompletion(() -> open.set(false));
            emitter.onTimeout(() -> open.set(false));
            emitter.onError(e -> open.set(false));
        }

        @Override
        public void comment(String text) {
            if (!open.get()) {
                return;
            }
            try {
                emitter.send(SseEmitter.event().comment(text));
            } catch (IOException e) {
                open.set(false);
                throw new UncheckedIOException(e);
            }
        }

        @Override
        public void complete() {
            if (open.compareAndSet(true, false)) {
                try {
                    emitter.complete();
                } catch (Exception ignored) {
                    // контракт: не бросаем, если уже закрыт снизу
                }
            }
        }

        @Override
        public boolean isOpen() {
            return open.get();
        }
    }
}
