/**
 * The shared heartbeat scheduler of the stream layer.
 *
 * <p>One single-thread daemon scheduler serves every SSE connection of the
 * kernel: every 15 seconds each live connection receives one
 * {@code :heartbeat} comment. The comment keeps idle streams alive through
 * proxies and lets the kernel notice dead peers on the failed write.
 */
package com.astroreen.jhin.kernel.stream;

import java.io.IOException;
import java.time.Duration;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class Heartbeat {

    private static final Logger LOG = LoggerFactory.getLogger(Heartbeat.class);

    /** Interval mandated by the stream contract. */
    private static final Duration PERIOD = Duration.ofSeconds(15);

    private final ScheduledExecutorService scheduler =
            Executors.newSingleThreadScheduledExecutor(runnable -> {
                Thread thread = new Thread(runnable, "jhin-sse-heartbeat");
                thread.setDaemon(true);
                return thread;
            });

    private final CopyOnWriteArrayList<SseConnection> connections = new CopyOnWriteArrayList<>();

    /**
     * Starts the shared scheduler. Called once per stream registry.
     */
    Heartbeat() {
        scheduler.scheduleAtFixedRate(this::beat,
                PERIOD.toMillis(), PERIOD.toMillis(), TimeUnit.MILLISECONDS);
    }

    /**
     * Registers a connection for heartbeats. Called by the hand-off when the
     * connection opens.
     *
     * @param connection the connection to keep alive
     */
    void add(SseConnection connection) {
        connections.add(connection);
    }

    /**
     * Unregisters a connection. Called by the hand-off when the connection
     * closes.
     *
     * @param connection the connection to drop
     */
    void remove(SseConnection connection) {
        connections.remove(connection);
    }

    /**
     * Stops the scheduler and drops every registration. Called by the stream
     * registry on shutdown.
     */
    void close() {
        connections.clear();
        scheduler.shutdownNow();
    }

    /** Writes one comment to every live connection; a failed write closes it. */
    private void beat() {
        for (SseConnection connection : connections) {
            try {
                connection.writeHeartbeat();
            } catch (IOException e) {
                connection.close();
            }
        }
    }
}
