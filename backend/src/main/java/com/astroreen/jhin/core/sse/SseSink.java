package com.astroreen.jhin.core.sse;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.http.MediaType;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * Тестовый шов для SSE-подключения: минимальный контракт, который T23 адаптирует
 * поверх spring {@link SseEmitter}. Регистр и стрим-сервис работают только с ним.
 */
public interface SseSink {

    /**
     * Отправить сырой SSE-фрейм как есть (вместе с завершающей пустой строкой).
     * Потокобезопасно. Молча игнорируется, если поток уже закрыт; ошибка записи
     * (клиент отвалился) — {@link UncheckedIOException}.
     */
    void send(String frame);

    /** Отправить SSE-комментарий (heartbeat). */
    void comment(String text);

    /** Закрыть поток. Идемпотентно: не бросает, если уже закрыт. */
    void complete();

    boolean isOpen();

    static SseSink fromEmitter(SseEmitter emitter) {
        return new SseEmitterSink(emitter);
    }

    /**
     * Тонкий адаптер {@link SseEmitter}: open-флаг переворачивается на complete/onCompletion/onTimeout/onError.
     *
     * <p>Фреймы уходят «как есть» через {@link ResponseBodyEmitter#send(Set)}: переопределённый
     * {@link SseEmitter#send(Object)} дополнительно оборачивает payload в SSE {@code data:}.
     */
    final class SseEmitterSink implements SseSink {

        private static final MediaType TEXT_PLAIN_UTF8 = MediaType.valueOf("text/plain;charset=UTF-8");

        private final SseEmitter emitter;
        private final AtomicBoolean open = new AtomicBoolean(true);

        SseEmitterSink(SseEmitter emitter) {
            this.emitter = emitter;
            emitter.onCompletion(() -> open.set(false));
            emitter.onTimeout(() -> open.set(false));
            emitter.onError(e -> open.set(false));
        }

        @Override
        public void send(String frame) {
            if (!open.get()) {
                return;
            }
            try {
                emitter.send(Set.of(new ResponseBodyEmitter.DataWithMediaType(frame, TEXT_PLAIN_UTF8)));
            } catch (IOException e) {
                open.set(false);
                throw new UncheckedIOException(e);
            }
        }

        @Override
        public void comment(String text) {
            send(": " + text + "\n\n");
        }

        @Override
        public void complete() {
            if (open.compareAndSet(true, false)) {
                try {
                    emitter.complete();
                } catch (Exception ignored) {
                    // контракт: не бросает, если уже закрыт снизу
                }
            }
        }

        @Override
        public boolean isOpen() {
            return open.get();
        }
    }
}
