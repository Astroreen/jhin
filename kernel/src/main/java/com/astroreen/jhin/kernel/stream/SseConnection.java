/**
 * One live SSE connection to one topic.
 *
 * <p>Owns the bounded buffer that absorbs live events while the preamble is
 * still replaying history and the writer that turns events into server-sent
 * frames on the wire. Publishing never blocks on this connection: an event is
 * offered to the buffer and dropped-and-reported when the buffer is full.
 *
 * <p>Writes are serialized on one lock so frames from the request thread and
 * the heartbeat scheduler never interleave. A write that fails (client gone)
 * or a buffer overflow closes the connection; closing is idempotent and
 * unsubscribes the connection from its topic.
 */
package com.astroreen.jhin.kernel.stream;

import com.astroreen.jhin.sdk.stream.SseWriter;
import com.astroreen.jhin.sdk.stream.StreamEvent;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

final class SseConnection {

    /** Events buffered while the preamble runs before slow consumers are dropped. */
    static final int BUFFER_CAPACITY = 1024;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static final String FRAME_SUFFIX = "\n\n";

    private final String topic;
    private final OutputStream out;
    private final Consumer<SseConnection> closeAction;
    private final BlockingQueue<StreamEvent> buffer = new ArrayBlockingQueue<>(BUFFER_CAPACITY);
    private final Object writeLock = new Object();
    private final AtomicBoolean closed = new AtomicBoolean();

    /**
     * Creates a connection on one topic. Called once per SSE request by the
     * hand-off, before the connection is attached and buffering starts.
     *
     * @param topic       the topic this connection streams
     * @param out         the raw stream to write frames to
     * @param closeAction invoked once when the connection closes, to detach it
     */
    SseConnection(String topic, OutputStream out, Consumer<SseConnection> closeAction) {
        this.topic = topic;
        this.out = out;
        this.closeAction = closeAction;
    }

    /**
     * The topic this connection streams. Called on close to detach it.
     *
     * @return the topic name
     */
    String topic() {
        return topic;
    }

    /**
     * Whether the connection is closed. Called by the stream loops to decide
     * whether to keep going.
     *
     * @return {@code true} once the connection is closed
     */
    boolean isClosed() {
        return closed.get();
    }

    /**
     * Offers one live event to the buffer without ever blocking the caller.
     * Called by the topic on every publish.
     *
     * @param event the event to buffer
     * @return {@code false} when the buffer is full and the event is dropped
     */
    boolean offer(StreamEvent event) {
        return buffer.offer(event);
    }

    /**
     * Closes the connection: drops the buffer and unsubscribes from the topic.
     * Called on overflow, on write failure and when the stream finishes;
     * idempotent, the close action runs once.
     */
    void close() {
        if (closed.compareAndSet(false, true)) {
            buffer.clear();
            closeAction.accept(this);
        }
    }

    /**
     * Writes one server-sent frame to the stream. Called by the writer handed
     * to the preamble and by the two drain loops.
     *
     * @param type    the event type discriminator
     * @param payload the event body, serialized to JSON
     * @throws IOException            when the client connection failed or the
     *                                connection is already closed
     * @throws IllegalArgumentException when the payload is not
     *                                JSON-serializable
     */
    void writeEvent(String type, Object payload) throws IOException {
        String json;
        try {
            json = MAPPER.writeValueAsString(payload);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("payload is not JSON-serializable", e);
        }
        writeRaw("event: " + type + "\ndata: " + json + FRAME_SUFFIX);
    }

    /**
     * Writes one heartbeat comment to the stream. Called by the shared
     * scheduler every 15 seconds.
     *
     * @throws IOException when the client connection failed or the connection
     *                     is already closed
     */
    void writeHeartbeat() throws IOException {
        writeRaw(":heartbeat" + FRAME_SUFFIX);
    }

    /**
     * The writer handed to the preamble; valid only for the duration of the
     * preamble call, exactly as the SDK contract states.
     *
     * @return the preamble writer
     */
    SseWriter writer() {
        return this::writeEvent;
    }

    /**
     * Drains events buffered while the preamble ran, in publish order. Called
     * once by the hand-off between the preamble and the live tail; a write
     * failure closes the connection instead of propagating.
     */
    void flushBuffered() {
        try {
            StreamEvent event;
            while ((event = buffer.poll()) != null) {
                writeEvent(event.type(), event.payload());
            }
        } catch (IOException e) {
            close();
        }
    }

    /**
     * Writes buffered events as they arrive, until the connection closes.
     * Called by the hand-off on the request thread once the preamble is done;
     * a write failure closes the connection instead of propagating.
     */
    void liveTail() {
        while (!closed.get()) {
            try {
                StreamEvent event = buffer.poll(200, TimeUnit.MILLISECONDS);
                if (event != null) {
                    writeEvent(event.type(), event.payload());
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                close();
                return;
            } catch (IOException e) {
                close();
                return;
            }
        }
    }

    private void writeRaw(String frame) throws IOException {
        synchronized (writeLock) {
            if (closed.get()) {
                throw new IOException("sse connection is closed");
            }
            out.write(frame.getBytes(StandardCharsets.UTF_8));
            out.flush();
        }
    }
}
