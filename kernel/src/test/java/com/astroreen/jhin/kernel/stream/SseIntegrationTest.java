package com.astroreen.jhin.kernel.stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.groups.Tuple.tuple;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.astroreen.jhin.kernel.http.HttpRegistryImpl;
import com.astroreen.jhin.sdk.http.RouteSpec;
import com.astroreen.jhin.sdk.stream.StreamEvent;
import jakarta.annotation.PostConstruct;
import java.io.BufferedReader;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.server.LocalServerPort;

/**
 * End-to-end coverage of the stream layer over a real HTTP exchange.
 *
 * <p>Routes are registered straight into the kernel HTTP registry (the
 * plugin-facing registration seam arrives with the plugin lifecycle) and a
 * raw socket drives the SSE side so the test can observe frame order and
 * deliberately stall the consumer.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class SseIntegrationTest {

    private static final CountDownLatch OVERFLOW_ENTERED = new CountDownLatch(1);
    private static final CountDownLatch OVERFLOW_RELEASE = new CountDownLatch(1);

    @LocalServerPort
    private int port;

    @Autowired
    private StreamRegistryImpl streams;

    /** Registers the three test routes on the shared registry. */
    @TestConfiguration
    static class TestRoutes {

        @Autowired
        HttpRegistryImpl http;

        @Autowired
        StreamRegistryImpl streams;

        @PostConstruct
        void install() {
            http.route(new RouteSpec("GET", "/t",
                    request -> streams.sse("t", w -> w.event("replay", 1))));
            http.route(new RouteSpec("GET", "/race",
                    request -> streams.sse("race", w -> {
                        w.event("replay", 1);
                        streams.publish("race", new StreamEvent("mid", 2));
                        w.event("after", 3);
                    })));
            http.route(new RouteSpec("GET", "/ovf",
                    request -> streams.sse("ovf", w -> {
                        OVERFLOW_ENTERED.countDown();
                        OVERFLOW_RELEASE.await();
                    })));
        }
    }

    // happy path: preamble event first, then the published events, then a heartbeat
    @Test
    void deliversPreambleThenPublishedEventsThenHeartbeat() throws Exception {
        Instant connected = Instant.now();
        try (SseClient client = SseClient.connect(port, "/t")) {
            Map<String, String> headers = client.handshake(Instant.now().plusSeconds(5));
            assertThat(headers.get("status")).contains("200");
            assertThat(headers.get("content-type")).isEqualTo("text/event-stream");
            assertThat(headers.get("cache-control")).isEqualTo("no-cache");
            assertThat(headers.get("x-accel-buffering")).isEqualTo("no");

            Frame replay = client.nextEvent(Instant.now().plusSeconds(5));
            assertThat(replay.type()).isEqualTo("replay");
            assertThat(replay.data()).isEqualTo("1");

            streams.publish("t", new StreamEvent("e", 1));
            streams.publish("t", new StreamEvent("e", 2));
            streams.publish("t", new StreamEvent("e", 3));

            List<Frame> published = client.nextEvents(3, Instant.now().plusSeconds(5));
            assertThat(published).extracting(Frame::type, Frame::data)
                    .containsExactly(
                            tuple("e", "1"),
                            tuple("e", "2"),
                            tuple("e", "3"));

            assertThat(client.awaitHeartbeat(Duration.between(connected, Instant.now())))
                    .as("heartbeat within 20 s of the connection")
                    .isTrue();
        }
    }

    // acceptance: an event published during the preamble arrives after it, not lost
    @Test
    void eventPublishedDuringPreambleIsDeliveredAfterThePreambleOutput() throws Exception {
        try (SseClient client = SseClient.connect(port, "/race")) {
            client.handshake(Instant.now().plusSeconds(5));
            List<Frame> frames = client.nextEvents(3, Instant.now().plusSeconds(5));
            assertThat(frames).extracting(Frame::type, Frame::data)
                    .containsExactly(
                            tuple("replay", "1"),
                            tuple("after", "3"),
                            tuple("mid", "2"));
        }
    }

    // failure path: 2000 events against a stalled consumer overflow the buffer
    @Test
    void bufferOverflowClosesConnectionAndWarnsNamingTheTopic() throws Exception {
        Logger topicLogger = (Logger) org.slf4j.LoggerFactory.getLogger(Topic.class);
        ListAppender<ILoggingEvent> capture = new ListAppender<>();
        capture.start();
        topicLogger.addAppender(capture);
        try (SseClient client = SseClient.connect(port, "/ovf")) {
            assertThat(OVERFLOW_ENTERED.await(5, TimeUnit.SECONDS))
                    .as("connection subscribed and the preamble is running")
                    .isTrue();
            for (int i = 0; i < 2000; i++) {
                streams.publish("ovf", new StreamEvent("x", i));
            }
            List<ILoggingEvent> warns = capture.list.stream()
                    .filter(event -> event.getLevel() == Level.WARN)
                    .filter(event -> event.getFormattedMessage().contains("ovf"))
                    .toList();
            assertThat(warns).hasSize(1);
            assertThat(warns.get(0).getFormattedMessage()).contains("overflow").contains("ovf");
            assertThat(streams.hasTopic("ovf")).isFalse();
            assertThat(streams.connectionCount("ovf")).isZero();

            OVERFLOW_RELEASE.countDown();
            List<String> tail = client.readUntilEof(Instant.now().plusSeconds(5));
            assertThat(tail).noneMatch(line -> line.startsWith("event:"));
            assertThat(tail.stream().anyMatch(line -> line.toLowerCase(Locale.ROOT)
                    .startsWith("content-type: text/event-stream"))).isTrue();
            writeOverflowEvidence(warns.get(0).getFormattedMessage());
        } finally {
            topicLogger.detachAppender(capture);
            OVERFLOW_RELEASE.countDown();
        }
    }

    private static void writeOverflowEvidence(String warnLine) throws IOException {
        Path out = Path.of("build", "t15-overflow.txt");
        Files.createDirectories(out.getParent());
        Files.writeString(out, "T15 — SSE buffer overflow: WARN excerpt\n"
                + "scenario: 2000 events published while the consumer is stalled by the preamble\n\n"
                + "WARN excerpt:\n  " + warnLine + "\n\n"
                + "asserted: exactly one WARN naming the topic; topic dropped; connection closed (EOF)\n");
    }

    /** One parsed server-sent frame: an event, or a comment. */
    private record Frame(String type, String data, String comment) {}

    /**
     * Minimal SSE consumer over a raw socket. The request speaks HTTP/1.0 so
     * the body is plain frames terminated by the connection close (no chunked
     * framing on the wire) and stalling the consumer is a plain stop-reading.
     */
    private static final class SseClient implements Closeable {

        private final Socket socket;
        private final BufferedReader reader;

        private SseClient(Socket socket, BufferedReader reader) {
            this.socket = socket;
            this.reader = reader;
        }

        static SseClient connect(int port, String path) throws IOException {
            Socket socket = new Socket("127.0.0.1", port);
            socket.setTcpNoDelay(true);
            OutputStream out = socket.getOutputStream();
            out.write(("GET " + path + " HTTP/1.0\r\n"
                    + "Host: 127.0.0.1\r\n"
                    + "Accept: text/event-stream\r\n"
                    + "\r\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
            BufferedReader reader = new BufferedReader(
                    new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            return new SseClient(socket, reader);
        }

        /** Reads the status line and headers; keys are lower-cased. */
        Map<String, String> handshake(Instant deadline) throws IOException {
            Map<String, String> headers = new LinkedHashMap<>();
            String status = readLine(deadline);
            if (status == null) {
                throw new IOException("connection closed before the response head");
            }
            headers.put("status", status);
            for (;;) {
                String line = readLine(deadline);
                if (line == null || line.isEmpty()) {
                    return headers;
                }
                int colon = line.indexOf(':');
                if (colon > 0) {
                    headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT),
                            line.substring(colon + 1).trim());
                }
            }
        }

        /** The next non-comment frame. */
        Frame nextEvent(Instant deadline) throws IOException {
            for (;;) {
                Frame frame = nextFrame(deadline);
                if (frame == null) {
                    throw new IOException("connection closed before the expected event");
                }
                if (frame.comment() == null) {
                    return frame;
                }
            }
        }

        /** The next {@code count} non-comment frames. */
        List<Frame> nextEvents(int count, Instant deadline) throws IOException {
            List<Frame> frames = new ArrayList<>();
            for (int i = 0; i < count; i++) {
                frames.add(nextEvent(deadline));
            }
            return frames;
        }

        /**
         * Reads until a {@code :heartbeat} comment appears; {@code false} when
         * the budget (20 s minus the time already spent) runs out first.
         */
        boolean awaitHeartbeat(Duration elapsed) throws IOException {
            Instant deadline = Instant.now().plus(Duration.ofSeconds(20).minus(elapsed));
            try {
                for (;;) {
                    Frame frame = nextFrame(deadline);
                    if (frame == null) {
                        return false;
                    }
                    if ("heartbeat".equals(frame.comment())) {
                        return true;
                    }
                }
            } catch (SocketTimeoutException e) {
                return false;
            }
        }

        /** Reads every remaining line until the server closes the connection. */
        List<String> readUntilEof(Instant deadline) throws IOException {
            List<String> lines = new ArrayList<>();
            for (;;) {
                String line = readLine(deadline);
                if (line == null) {
                    return lines;
                }
                lines.add(line);
            }
        }

        /** The next frame, comments included; {@code null} at end of stream. */
        private Frame nextFrame(Instant deadline) throws IOException {
            String type = null;
            String data = null;
            String comment = null;
            for (;;) {
                String line = readLine(deadline);
                if (line == null) {
                    if (type == null && data == null && comment == null) {
                        return null;
                    }
                    return new Frame(type, data, comment);
                }
                if (line.isEmpty()) {
                    if (comment != null) {
                        return new Frame(null, null, comment);
                    }
                    if (type != null || data != null) {
                        return new Frame(type, data, null);
                    }
                    continue;
                }
                if (line.startsWith(":")) {
                    comment = line.substring(1).trim();
                } else if (line.startsWith("event:")) {
                    type = line.substring("event:".length()).trim();
                } else if (line.startsWith("data:")) {
                    data = line.substring("data:".length()).trim();
                }
            }
        }

        private String readLine(Instant deadline) throws IOException {
            long millis = Duration.between(Instant.now(), deadline).toMillis();
            socket.setSoTimeout((int) Math.max(1, millis));
            return reader.readLine();
        }

        @Override
        public void close() throws IOException {
            socket.close();
        }
    }
}
