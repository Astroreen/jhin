package com.astroreen.jhin.core.sse;

import com.astroreen.jhin.core.events.Event;
import com.astroreen.jhin.core.events.EventLogService;
import com.astroreen.jhin.core.events.EventSubscription;
import java.util.Queue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Один SSE-поток событий сессии: replay из БД → live-tail. Гарантия резюма без дыр и дублей:
 *
 * <ol>
 *   <li>подписчик на новые события (буфер) регистрируется ДО чтения БД;
 *   <li>replay: события {@code seq >= fromSeq} из БД по порядку, запоминаем {@code lastSentSeq};
 *   <li>из буфера досылаются события {@code seq > lastSentSeq} по порядку, дальше — live.
 * </ol>
 *
 * Каждый seq отправляется ровно один раз: запись в БД строго предшествует уведомлению
 * слушателей, поэтому событие либо попадает в replay, либо — в буфер (дубль из обоих
 * источников отбрасывается фильтром {@code seq > lastSentSeq}). Отправка сериализована
 * одним потоком {@code jhin-sse-stream}, порядок seq сохраняется.
 *
 * <p>Закрытие ({@link #close}, complete/error эмиттера, revoke, cap) идемпотентно и
 * снимает подписку, sink с таймерами heartbeat/cap и завершает поток. Утечки исключены:
 * {@link LifecycleSink#complete()} тоже доводит до {@code close()}, поэтому любой путь
 * закрытия (в т.ч. {@code SseRegistry#closeDevice}) вычищает ресурсы немедленно.
 */
public class SessionEventStream implements AutoCloseable {

    private static final String THREAD_NAME = "jhin-sse-stream";

    private final EventLogService eventLog;
    private final SseStreamService streamService;
    private final SseSink sink;
    private final String deviceId;
    private final String sessionId;
    private final long fromSeq;
    private final ExecutorService executor;
    private final Queue<Event> buffer = new ConcurrentLinkedQueue<>();
    private final AtomicBoolean closed = new AtomicBoolean();
    private EventSubscription subscription;
    private long lastSentSeq;
    private boolean replayDone;

    public SessionEventStream(
            EventLogService eventLog,
            SseStreamService streamService,
            SseSink sink,
            String deviceId,
            String sessionId,
            long fromSeq) {
        this.eventLog = eventLog;
        this.streamService = streamService;
        this.sink = new LifecycleSink(sink);
        this.deviceId = deviceId;
        this.sessionId = sessionId;
        this.fromSeq = fromSeq;
        this.executor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, THREAD_NAME);
            thread.setDaemon(true);
            return thread;
        });
    }

    /**
     * Открывает поток: heartbeat+cap через {@link SseStreamService#openStream}, затем
     * подписка и асинхронный replay → live.
     */
    public synchronized void open() {
        if (closed.get()) {
            return;
        }
        streamService.openStream(deviceId, sink);
        subscription = eventLog.subscribe(sessionId, this::onEvent);
        executor.execute(this::replay);
    }

    /** Идемпотентно: снимает подписку, sink с таймерами и завершает эмиттер. */
    @Override
    public synchronized void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        if (subscription != null) {
            subscription.unsubscribe();
        }
        streamService.unregister(deviceId, sink);
        sink.complete();
        executor.shutdown();
    }

    private void onEvent(Event event) {
        if (closed.get()) {
            return;
        }
        buffer.add(event);
        try {
            executor.execute(this::drain);
        } catch (RejectedExecutionException ignored) {
            // поток закрывается — событие некому отдавать
        }
    }

    private void replay() {
        for (Event event : eventLog.readRange(sessionId, fromSeq)) {
            if (!dispatch(event)) {
                return;
            }
        }
        replayDone = true;
        drain();
    }

    private void drain() {
        if (!replayDone) {
            return;
        }
        Event event;
        while ((event = buffer.poll()) != null) {
            if (!dispatch(event)) {
                return;
            }
        }
    }

    /** false — поток умер, дальше не шлём. Дубли ({@code seq <= lastSentSeq}) пропускаются. */
    private boolean dispatch(Event event) {
        if (event.seq() <= lastSentSeq) {
            return true;
        }
        if (closed.get()) {
            return false;
        }
        if (!sink.isOpen()) {
            close();
            return false;
        }
        try {
            sink.send(frame(event));
        } catch (Exception e) {
            close();
            return false;
        }
        lastSentSeq = event.seq();
        return true;
    }

    /** Фрейм события в точном формате: {@code id: N}, {@code event: T}, {@code data: JSON}. */
    private static String frame(Event event) {
        String payload = event.payload() == null ? "null" : event.payload().toString();
        return "id: " + event.seq() + "\nevent: " + event.type() + "\ndata: " + payload + "\n\n";
    }

    /** Делегат, доводящий любой complete() до {@link SessionEventStream#close()}. */
    private final class LifecycleSink implements SseSink {

        private final SseSink delegate;

        LifecycleSink(SseSink delegate) {
            this.delegate = delegate;
        }

        @Override
        public void send(String frame) {
            delegate.send(frame);
        }

        @Override
        public void comment(String text) {
            delegate.comment(text);
        }

        @Override
        public void complete() {
            try {
                delegate.complete();
            } finally {
                SessionEventStream.this.close();
            }
        }

        @Override
        public boolean isOpen() {
            return delegate.isOpen();
        }
    }
}
